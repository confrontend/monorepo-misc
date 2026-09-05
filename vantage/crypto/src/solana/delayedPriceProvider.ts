import { SolanaRpcClient } from './rpcClient.js';
import { parseSplTokenSwap } from './swapParser.js';
import type { SolanaPriceResult, SolanaSwapObservation, SolanaRpcStats } from './types.js';

export const MAX_LEG_RUNTIME_MS = 30_000;

export type DelayedPriceRequest = {
  originalSignature: string;
  tokenMint: string;
  copyDelaySeconds: number;
  maxWindowSeconds: number;
  maxTargetSlotSearchCalls?: number;
  maxBlocksInspected?: number;
  maxRuntimeMs?: number;
};

export class SolanaDelayedPriceProvider {
  constructor(private readonly rpc: SolanaRpcClient) {}

  async findDelayedPrice(request: DelayedPriceRequest): Promise<SolanaPriceResult> {
    const before = this.rpc.telemetry;
    const result = await this.findDelayedPriceInternal(request);
    const after = this.rpc.telemetry;
    const rpcStats: SolanaRpcStats = {
      elapsedMs: after.elapsedMs - before.elapsedMs,
      totalCalls: after.totalCalls - before.totalCalls,
      getTransactionCalls: after.getTransactionCalls - before.getTransactionCalls,
      getBlocksCalls: after.getBlocksCalls - before.getBlocksCalls,
      getBlockTimeCalls: after.getBlockTimeCalls - before.getBlockTimeCalls,
      getBlockCalls: after.getBlockCalls - before.getBlockCalls,
      retries: after.retries - before.retries,
      rateLimitWaitMs: after.rateLimitWaitMs - before.rateLimitWaitMs,
      cacheHits: after.cacheHits - before.cacheHits,
      cacheMisses: after.cacheMisses - before.cacheMisses,
      producedSlotsConsidered: after.producedSlotsConsidered - before.producedSlotsConsidered,
      blocksInspected: after.getBlockCalls - before.getBlockCalls,
    };
    return { ...result, rpcStats };
  }

  private async findDelayedPriceInternal(request: DelayedPriceRequest): Promise<SolanaPriceResult> {
    const startedAt = Date.now();
    const maxSearchCalls = request.maxTargetSlotSearchCalls ?? 10;
    const maxBlocksInspected = request.maxBlocksInspected ?? 20;
    const timedOut = () => Date.now() - startedAt > (request.maxRuntimeMs ?? MAX_LEG_RUNTIME_MS);
    const rpcReason = (
      error: unknown,
    ): 'RPC_TIME_BUDGET_EXCEEDED' | 'RPC_RATE_LIMITED' | 'RPC_ERROR' => {
      const text = error instanceof Error ? error.message : String(error);
      if (text.includes('time limit') || text.includes('budget reached'))
        return 'RPC_TIME_BUDGET_EXCEEDED';
      if (text.includes('RPC_RATE_LIMITED') || text.includes('429')) return 'RPC_RATE_LIMITED';
      return 'RPC_ERROR';
    };
    let original;
    try {
      original = await this.rpc.getTransaction(request.originalSignature);
    } catch (error) {
      return {
        ok: false,
        targetTimestamp: 0,
        failure: {
          reason: rpcReason(error),
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!original)
      return {
        ok: false,
        targetTimestamp: 0,
        failure: {
          reason: 'ORIGINAL_TRANSACTION_NOT_FOUND',
          message: 'Original transaction is unavailable from this RPC endpoint.',
        },
      };
    const originalTime = Number(original.blockTime);
    const originalSlot = Number(original.slot);
    if (!Number.isFinite(originalTime) || !Number.isFinite(originalSlot))
      return {
        ok: false,
        targetTimestamp: 0,
        failure: {
          reason: 'PARSER_FAILED',
          message: 'Original transaction has no usable slot or blockTime.',
        },
      };
    const targetTimestamp = originalTime + request.copyDelaySeconds;
    const endTime = targetTimestamp + request.maxWindowSeconds;
    let blocks: number[];
    try {
      const estimatedTargetSlot = originalSlot + Math.round(request.copyDelaySeconds * 2.5);
      const radius = Math.max(20, Math.ceil(request.maxWindowSeconds * 2.5) + 20);
      blocks = await this.rpc.getBlocks(
        Math.max(0, estimatedTargetSlot - 20),
        estimatedTargetSlot + radius,
      );
    } catch (error) {
      return {
        ok: false,
        targetTimestamp,
        failure: {
          reason: rpcReason(error),
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if (!blocks.length)
      return {
        ok: false,
        targetTimestamp,
        failure: {
          reason: 'TARGET_SLOT_NOT_FOUND',
          message: 'No produced slots were returned near the estimated target.',
        },
      };
    try {
      // Block times are monotonic. Binary-search the produced slots; this keeps
      // target discovery to at most ten timestamp calls instead of walking slots.
      let low = 0;
      let high = blocks.length - 1;
      let searchCalls = 0;
      let targetIndex = blocks.length;
      while (low <= high) {
        if (timedOut())
          return {
            ok: false,
            targetTimestamp,
            failure: {
              reason: 'RPC_TIME_BUDGET_EXCEEDED',
              message: 'Delayed lookup exceeded its per-trade time budget.',
            },
          };
        if (++searchCalls > maxSearchCalls)
          return {
            ok: false,
            targetTimestamp,
            failure: {
              reason: 'TARGET_SLOT_SEARCH_LIMIT_EXCEEDED',
              message: `Target-slot search exceeded ${maxSearchCalls} timestamp calls.`,
            },
          };
        const middle = Math.floor((low + high) / 2);
        const blockTime = await this.rpc.getBlockTime(blocks[middle]);
        if (blockTime === null) {
          low = middle + 1;
        } else if (blockTime >= targetTimestamp) {
          targetIndex = middle;
          high = middle - 1;
        } else {
          low = middle + 1;
        }
      }
      if (targetIndex >= blocks.length)
        return {
          ok: false,
          targetTimestamp,
          failure: {
            reason: 'TARGET_SLOT_NOT_FOUND',
            message: 'No produced slot at or after the delayed target timestamp was found.',
          },
        };
      let inspected = 0;
      for (const slot of blocks.slice(targetIndex, targetIndex + maxBlocksInspected)) {
        if (timedOut())
          return {
            ok: false,
            targetTimestamp,
            failure: {
              reason: 'RPC_TIME_BUDGET_EXCEEDED',
              message: 'Delayed lookup exceeded its per-trade time budget.',
            },
          };
        if (++inspected > maxBlocksInspected)
          return {
            ok: false,
            targetTimestamp,
            failure: {
              reason: 'BLOCK_SCAN_LIMIT_EXCEEDED',
              message: `Block scan exceeded ${maxBlocksInspected} blocks.`,
            },
          };
        const block = await this.rpc.getBlock(slot);
        if (!block) continue;
        const blockTime = Number((block as { blockTime?: unknown }).blockTime);
        if (!Number.isFinite(blockTime) || blockTime < targetTimestamp || blockTime > endTime)
          continue;
        const transactions = Array.isArray(block.transactions)
          ? (block.transactions as SolanaSwapObservation[])
          : [];
        for (let index = 0; index < transactions.length; index += 1) {
          const tx = transactions[index] as unknown as Record<string, unknown>;
          const observation = parseSplTokenSwap(
            { ...(tx as object), slot, blockTime, meta: tx.meta } as Record<string, unknown>,
            request.tokenMint,
            targetTimestamp,
            String(
              (tx as { transaction?: { signatures?: string[] } }).transaction?.signatures?.[0] ??
                '',
            ),
          );
          if (observation)
            return {
              ok: true,
              targetTimestamp,
              observation: {
                ...observation,
                transactionIndex: index,
                timestampGapSeconds: observation.blockTime - targetTimestamp,
              },
            };
        }
      }
    } catch (error) {
      return {
        ok: false,
        targetTimestamp,
        failure: {
          reason: 'RPC_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    return {
      ok: false,
      targetTimestamp,
      failure: {
        reason: 'NO_MARKET_TRADE_WITHIN_WINDOW',
        message: 'No safely parsed market swap was found within the permitted matching window.',
      },
    };
  }
}
