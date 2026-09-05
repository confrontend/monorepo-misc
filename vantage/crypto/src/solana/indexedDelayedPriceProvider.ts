import { SolanaRpcClient } from './rpcClient.js';
import { parseSplTokenSwap } from './swapParser.js';
import type { SolanaPriceResult, SolanaRpcStats, SolanaTransaction } from './types.js';

const MAX_ADDRESSES = 6;
const MAX_RUNTIME_MS = 30_000;

/**
 * Helius indexed delayed-price experiment. This deliberately does not use
 * slot estimation, getBlockTime, or getBlock. Helius performs the historical
 * time filtering and returns full parsed transaction envelopes directly.
 */
export class HeliusIndexedDelayedPriceProvider {
  constructor(private readonly rpc: SolanaRpcClient) {}

  async findDelayedPrice(request: {
    originalSignature: string;
    tokenMint: string;
    copyDelaySeconds: number;
    maxWindowSeconds: number;
    maxRuntimeMs?: number;
  }): Promise<SolanaPriceResult> {
    const startedAt = Date.now();
    const before = this.rpc.telemetry;
    const finish = (result: SolanaPriceResult): SolanaPriceResult => {
      const after = this.rpc.telemetry;
      const stats: SolanaRpcStats = {
        elapsedMs: after.elapsedMs - before.elapsedMs,
        totalCalls: after.totalCalls - before.totalCalls,
        getTransactionCalls: after.getTransactionCalls - before.getTransactionCalls,
        getBlocksCalls: after.getBlocksCalls - before.getBlocksCalls,
        getBlockTimeCalls: after.getBlockTimeCalls - before.getBlockTimeCalls,
        getBlockCalls: after.getBlockCalls - before.getBlockCalls,
        getTransactionsForAddressCalls:
          after.getTransactionsForAddressCalls - before.getTransactionsForAddressCalls,
        parsedEventsCalls: after.parsedEventsCalls - before.parsedEventsCalls,
        retries: after.retries - before.retries,
        rateLimitWaitMs: after.rateLimitWaitMs - before.rateLimitWaitMs,
        cacheHits: after.cacheHits - before.cacheHits,
        cacheMisses: after.cacheMisses - before.cacheMisses,
        producedSlotsConsidered: after.producedSlotsConsidered - before.producedSlotsConsidered,
        blocksInspected: 0,
      };
      return { ...result, rpcStats: stats };
    };
    const timedOut = () => Date.now() - startedAt > (request.maxRuntimeMs ?? MAX_RUNTIME_MS);
    const mapError = (
      error: unknown,
    ): 'RPC_TIME_BUDGET_EXCEEDED' | 'RPC_RATE_LIMITED' | 'RPC_ERROR' => {
      const text = error instanceof Error ? error.message : String(error);
      if (text.includes('TIMEOUT') || text.includes('time limit') || text.includes('budget'))
        return 'RPC_TIME_BUDGET_EXCEEDED';
      if (text.includes('429') || text.includes('RATE_LIMITED')) return 'RPC_RATE_LIMITED';
      return 'RPC_ERROR';
    };

    let original: SolanaTransaction | null;
    try {
      original = await this.rpc.getTransaction(request.originalSignature);
    } catch (error) {
      return finish({
        ok: false,
        targetTimestamp: 0,
        failure: { reason: mapError(error), message: String(error) },
      });
    }
    if (!original)
      return finish({
        ok: false,
        targetTimestamp: 0,
        failure: {
          reason: 'ORIGINAL_TRANSACTION_NOT_FOUND',
          message: 'Original transaction is unavailable.',
        },
      });
    const originalTime = Number(original.blockTime);
    if (!Number.isFinite(originalTime))
      return finish({
        ok: false,
        targetTimestamp: 0,
        failure: {
          reason: 'PARSER_FAILED',
          message: 'Original transaction has no usable blockTime.',
        },
      });
    const targetTimestamp = originalTime + request.copyDelaySeconds;
    const endTimestamp = targetTimestamp + request.maxWindowSeconds;
    const addresses = relevantAddresses(original);
    if (!addresses.length)
      return finish({
        ok: false,
        targetTimestamp,
        failure: {
          reason: 'NO_RELEVANT_MARKET_ADDRESS',
          message: 'No relevant account address was identified in the original swap.',
        },
      });

    const candidates: Array<{ tx: SolanaTransaction; signature: string; parsed: boolean }> = [];
    let parsedEventsAvailable = true;
    let usedApi: 'helius-indexed-events' | 'helius-getTransactionsForAddress' =
      'helius-indexed-events';
    try {
      for (const address of addresses) {
        if (timedOut())
          return finish({
            ok: false,
            targetTimestamp,
            failure: {
              reason: 'RPC_TIME_BUDGET_EXCEEDED',
              message: 'Indexed lookup exceeded its per-trade time budget.',
            },
          });
        const result = await this.rpc.getParsedTransactionHistory(address, {
          limit: 100,
          sortOrder: 'asc',
          commitment: 'confirmed',
          filters: { blockTime: { gte: targetTimestamp, lte: endTimestamp } },
        });
        for (const tx of result.data ?? []) {
          const signature = transactionSignature(tx);
          if (signature) candidates.push({ tx, signature, parsed: true });
        }
      }
    } catch (error) {
      parsedEventsAvailable = false;
      usedApi = 'helius-getTransactionsForAddress';
      for (const address of addresses) {
        if (timedOut()) break;
        try {
          const result = await this.rpc.getTransactionsForAddress(address, {
            transactionDetails: 'full',
            sortOrder: 'asc',
            limit: 100,
            filters: {
              blockTime: { gte: targetTimestamp, lte: endTimestamp },
              status: 'succeeded',
              tokenAccounts: 'all',
            },
          });
          for (const tx of result.data ?? []) {
            const signature = transactionSignature(tx);
            if (signature) candidates.push({ tx, signature, parsed: false });
          }
        } catch {
          // The final failure below preserves the indexed provider error.
        }
      }
      if (!candidates.length && !timedOut())
        return finish({
          ok: false,
          targetTimestamp,
          failure: { reason: mapError(error), message: String(error) },
        });
    }
    const observations = candidates
      .sort((a, b) => transactionTime(a.tx) - transactionTime(b.tx))
      .map(({ tx, signature, parsed }) =>
        parsed
          ? parseParsedEvent(tx, request.tokenMint, targetTimestamp, signature)
          : parseSplTokenSwap(tx, request.tokenMint, targetTimestamp, signature),
      )
      .filter((value): value is NonNullable<typeof value> => Boolean(value))
      .filter((value) => value.blockTime >= targetTimestamp && value.blockTime <= endTimestamp);
    const observation = observations[0];
    if (!observation && parsedEventsAvailable && !timedOut()) {
      usedApi = 'helius-getTransactionsForAddress';
      for (const address of addresses) {
        try {
          const result = await this.rpc.getTransactionsForAddress(address, {
            transactionDetails: 'full',
            sortOrder: 'asc',
            limit: 100,
            filters: {
              blockTime: { gte: targetTimestamp, lte: endTimestamp },
              status: 'succeeded',
              tokenAccounts: 'all',
            },
          });
          const fallbackObservations = (result.data ?? [])
            .map((tx) => {
              const signature = transactionSignature(tx);
              return signature
                ? parseSplTokenSwap(tx, request.tokenMint, targetTimestamp, signature)
                : null;
            })
            .filter((value): value is NonNullable<typeof value> => Boolean(value))
            .filter(
              (value) => value.blockTime >= targetTimestamp && value.blockTime <= endTimestamp,
            )
            .sort((a, b) => a.blockTime - b.blockTime);
          if (fallbackObservations[0])
            return finish({
              ok: true,
              targetTimestamp,
              observation: fallbackObservations[0],
              api: usedApi,
            });
        } catch {
          // Continue through the bounded fallback addresses.
        }
      }
    }
    if (!observation)
      return finish({
        ok: false,
        targetTimestamp,
        failure: {
          reason: parsedEventsAvailable
            ? 'NO_MARKET_TRADE_WITHIN_WINDOW'
            : 'PARSED_EVENT_UNSUPPORTED',
          message: parsedEventsAvailable
            ? 'No indexed swap for the token was found in the target window.'
            : 'Parsed Events and the indexed fallback did not yield a parseable swap.',
        },
      });
    return finish({ ok: true, targetTimestamp, observation, api: usedApi });
  }
}

function transactionSignature(tx: SolanaTransaction): string | null {
  if (typeof tx.signature === 'string') return tx.signature;
  const signatures = (tx.transaction as { signatures?: unknown } | undefined)?.signatures;
  return Array.isArray(signatures) && typeof signatures[0] === 'string' ? signatures[0] : null;
}

function transactionTime(tx: SolanaTransaction): number {
  return Number(tx.blockTime ?? (tx.parsed as { blockTime?: number } | undefined)?.blockTime ?? 0);
}

function parseParsedEvent(
  tx: SolanaTransaction,
  tokenMint: string,
  targetTimestamp: number,
  signature: string,
) {
  const parsed = tx.parsed as
    | {
        slot?: number;
        blockTime?: number;
        summary?: { parsedData?: Record<string, unknown> };
        tokenTransfers?: Array<{
          mint?: string;
          decimals?: number;
          rawTokenAmount?: { decimals?: number };
        }>;
      }
    | undefined;
  const data = parsed?.summary?.parsedData;
  if (!data || data.type !== 'swap') return null;
  const inputMint = typeof data.input_mint === 'string' ? data.input_mint : null;
  const outputMint = typeof data.output_mint === 'string' ? data.output_mint : null;
  const inputAmount = Number(data.in_amount);
  const outputAmount = Number(data.actual_out_amount);
  const blockTime = Number(parsed?.blockTime);
  const slot = Number(parsed?.slot);
  if (
    !inputMint ||
    !outputMint ||
    !Number.isFinite(inputAmount) ||
    !Number.isFinite(outputAmount) ||
    !Number.isFinite(blockTime) ||
    !Number.isFinite(slot)
  )
    return null;
  const tokenIsOutput = outputMint === tokenMint;
  const tokenIsInput = inputMint === tokenMint;
  if (!tokenIsOutput && !tokenIsInput) return null;
  const quoteMint = tokenIsOutput ? inputMint : outputMint;
  if (
    quoteMint !== 'So11111111111111111111111111111111111111112' &&
    quoteMint !== 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  )
    return null;
  const tokenTransfer = parsed?.tokenTransfers?.find((item) => item.mint === tokenMint);
  const tokenDecimals = tokenTransfer?.decimals ?? tokenTransfer?.rawTokenAmount?.decimals ?? 0;
  const tokenAmount = (tokenIsOutput ? outputAmount : inputAmount) / 10 ** tokenDecimals;
  const quoteAmount =
    (tokenIsOutput ? inputAmount : outputAmount) /
    10 ** (quoteMint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' ? 6 : 9);
  if (!tokenAmount || !quoteAmount) return null;
  return {
    signature,
    slot,
    blockTime,
    tokenMint,
    quoteMint:
      quoteMint === 'So11111111111111111111111111111111111111112' ? ('SOL' as const) : quoteMint,
    tokenAmount,
    quoteAmount,
    priceInQuote: quoteAmount / tokenAmount,
    direction: tokenIsOutput ? ('buy' as const) : ('sell' as const),
    timestampGapSeconds: blockTime - targetTimestamp,
    parser: 'venue_specific' as const,
    confidence: 'high' as const,
  };
}

function relevantAddresses(tx: SolanaTransaction): string[] {
  const message = tx.transaction as { message?: { accountKeys?: unknown[] } } | undefined;
  const keys = message?.message?.accountKeys ?? [];
  const addresses = keys
    .map((key) => (typeof key === 'string' ? key : (key as { pubkey?: unknown })?.pubkey))
    .filter((key): key is string => typeof key === 'string' && key.length > 20);
  return [...new Set(addresses)].slice(0, MAX_ADDRESSES);
}
