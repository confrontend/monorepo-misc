import type {
  SolanaRpcCache,
  SolanaRpcConfig,
  SolanaRpcTransport,
  SolanaTransaction,
  SolanaRpcStats,
} from './types.js';

export const SOLANA_MAINNET_RPC_URL = 'https://api.mainnet.solana.com';

type RpcResponse<T> = {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class SolanaRpcClient {
  private readonly url: string;
  private readonly transport: SolanaRpcTransport;
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly cache: SolanaRpcCache;
  private requestId = 0;
  private readonly maxCalls: number;
  private readonly deadline: number;
  private readonly onRequest?: (request: {
    count: number;
    method: string;
    params: unknown[];
    at: string;
  }) => void;
  private readonly requestTimes: number[] = [];
  private rateLimitWaitMs = 0;
  private retries = 0;
  private cacheHits = 0;
  private cacheMisses = 0;
  private producedSlotsConsidered = 0;
  private readonly startedAt = Date.now();
  private readonly methodCalls = new Map<string, number>();
  private active = 0;
  private readonly transactionCache = new Map<string, SolanaTransaction | null>();
  private readonly blockTimeCache = new Map<number, number | null>();
  private readonly blockCache = new Map<number, SolanaTransaction | null>();
  private readonly rangeCache = new Map<string, number[]>();

  constructor(config: SolanaRpcConfig = {}) {
    this.maxCalls = config.maxCalls ?? Infinity;
    this.deadline = Date.now() + (config.deadlineMs ?? Infinity);
    this.onRequest = config.onRequest;
    this.url = config.url ?? process.env.SOLANA_RPC_URL ?? SOLANA_MAINNET_RPC_URL;
    this.transport = config.transport ?? fetch;
    this.maxRequests = config.maxRequestsPerWindow ?? 30;
    this.windowMs = config.windowMs ?? 10_000;
    this.maxConcurrent = config.maxConcurrent ?? 6;
    this.timeoutMs = config.timeoutMs ?? 20_000;
    this.cache = config.cache ?? {};
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let attempt = 0;
    while (true) {
      if (this.requestId >= this.maxCalls)
        throw new Error('RPC request budget reached. Partial results have been saved.');
      await this.acquire();
      if (Date.now() >= this.deadline)
        throw new Error('RPC time limit reached. Partial results have been saved.');
      this.onRequest?.({ count: this.requestId + 1, method, params, at: new Date().toISOString() });
      this.methodCalls.set(method, (this.methodCalls.get(method) ?? 0) + 1);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.transport(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
          signal: controller.signal,
        });
        if (response.status === 429 || response.status >= 500) {
          if (attempt++ < 3) {
            this.retries += 1;
            const retryAfter = Number(response.headers.get('retry-after'));
            await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * 2 ** attempt);
            continue;
          }
          throw new Error(
            response.status === 429 ? 'RPC_RATE_LIMITED' : `RPC HTTP ${response.status}`,
          );
        }
        if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
        const body = (await response.json()) as RpcResponse<T>;
        if (body.error) throw new Error(`RPC ${body.error.code}: ${body.error.message}`);
        if (body.result === undefined) throw new Error('RPC returned no result');
        return body.result;
      } catch (error) {
        if (attempt++ < 3 && error instanceof Error && error.name === 'AbortError') {
          this.retries += 1;
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        this.active -= 1;
      }
    }
  }

  async getTransaction(signature: string): Promise<SolanaTransaction | null> {
    if (this.cache.transactions?.has(signature)) {
      this.cacheHits += 1;
      return this.cache.transactions.get(signature) ?? null;
    }
    if (this.transactionCache.has(signature)) {
      this.cacheHits += 1;
      return this.transactionCache.get(signature) ?? null;
    }
    this.cacheMisses += 1;
    const result = await this.call<SolanaTransaction | null>('getTransaction', [
      signature,
      {
        commitment: 'finalized',
        encoding: 'json',
        maxSupportedTransactionVersion: 0,
      },
    ]);
    this.transactionCache.set(signature, result);
    this.cache.transactions?.set(signature, result);
    return result;
  }

  async getBlockTime(slot: number): Promise<number | null> {
    if (this.cache.blockTimes?.has(slot)) {
      this.cacheHits += 1;
      return this.cache.blockTimes.get(slot) ?? null;
    }
    if (this.blockTimeCache.has(slot)) {
      this.cacheHits += 1;
      return this.blockTimeCache.get(slot) ?? null;
    }
    this.cacheMisses += 1;
    const result = await this.call<number | null>('getBlockTime', [slot]);
    this.blockTimeCache.set(slot, result);
    this.cache.blockTimes?.set(slot, result);
    return result;
  }

  async getBlocks(startSlot: number, endSlot: number): Promise<number[]> {
    const result = await this.call<number[]>('getBlocks', [
      startSlot,
      endSlot,
      { commitment: 'finalized' },
    ]);
    this.producedSlotsConsidered += result.length;
    return result;
  }

  async getBlock(slot: number): Promise<SolanaTransaction | null> {
    if (this.cache.blocks?.has(slot)) {
      this.cacheHits += 1;
      return this.cache.blocks.get(slot) ?? null;
    }
    if (this.blockCache.has(slot)) {
      this.cacheHits += 1;
      return this.blockCache.get(slot) ?? null;
    }
    this.cacheMisses += 1;
    const result = await this.call<SolanaTransaction | null>('getBlock', [
      slot,
      {
        commitment: 'finalized',
        encoding: 'json',
        transactionDetails: 'full',
        rewards: false,
        maxSupportedTransactionVersion: 0,
      },
    ]);
    this.blockCache.set(slot, result);
    this.cache.blocks?.set(slot, result);
    return result;
  }

  async getFirstAvailableBlock(): Promise<number> {
    return this.call<number>('getFirstAvailableBlock');
  }

  get cacheStats(): { transactions: number; blocks: number; blockTimes: number } {
    return {
      transactions: this.transactionCache.size,
      blocks: this.blockCache.size,
      blockTimes: this.blockTimeCache.size,
    };
  }

  get telemetry(): SolanaRpcStats {
    const callsByMethod = (method: string) => this.methodCalls.get(method) ?? 0;
    return {
      elapsedMs: Date.now() - this.startedAt,
      totalCalls: this.requestId,
      getTransactionCalls: callsByMethod('getTransaction'),
      getBlocksCalls: callsByMethod('getBlocks'),
      getBlockTimeCalls: callsByMethod('getBlockTime'),
      getBlockCalls: callsByMethod('getBlock'),
      retries: this.retries,
      rateLimitWaitMs: this.rateLimitWaitMs,
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
      producedSlotsConsidered: this.producedSlotsConsidered,
      blocksInspected: 0,
    };
  }

  get endpoint(): string {
    return this.url;
  }

  private async acquire(): Promise<void> {
    while (true) {
      const now = Date.now();
      while (this.requestTimes[0] !== undefined && this.requestTimes[0] + this.windowMs <= now)
        this.requestTimes.shift();
      if (this.active < this.maxConcurrent && this.requestTimes.length < this.maxRequests) break;
      const waitMs = Math.max(25, (this.requestTimes[0] ?? now) + this.windowMs - now);
      this.rateLimitWaitMs += waitMs;
      await sleep(waitMs);
    }
    this.requestTimes.push(Date.now());
    this.active += 1;
  }
}
