export type SolanaRpcTransport = (url: string, init: RequestInit) => Promise<Response>;

export type SolanaRpcConfig = {
  maxCalls?: number;
  deadlineMs?: number;
  onRequest?: (request: { count: number; method: string; params: unknown[]; at: string }) => void;
  url?: string;
  maxRequestsPerWindow?: number;
  windowMs?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
  transport?: SolanaRpcTransport;
  cache?: SolanaRpcCache;
};

export type SolanaRpcStats = {
  elapsedMs: number;
  totalCalls: number;
  getTransactionCalls: number;
  getBlocksCalls: number;
  getBlockTimeCalls: number;
  getBlockCalls: number;
  retries: number;
  rateLimitWaitMs: number;
  cacheHits: number;
  cacheMisses: number;
  producedSlotsConsidered: number;
  blocksInspected: number;
};

export type SolanaRpcCache = {
  transactions?: Map<string, SolanaTransaction | null>;
  blockTimes?: Map<number, number | null>;
  blocks?: Map<number, SolanaTransaction | null>;
};

export type SolanaTransaction = Record<string, unknown>;

export type SolanaSwapObservation = {
  signature: string;
  slot: number;
  blockTime: number;
  transactionIndex?: number;
  tokenMint: string;
  quoteMint: string | 'SOL';
  tokenAmount: number;
  quoteAmount: number;
  priceInQuote: number;
  direction: 'buy' | 'sell';
  venue?: string;
  pool?: string;
  timestampGapSeconds: number;
  parser: 'spl_balance_delta' | 'native_sol_balance_delta' | 'venue_specific' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
};

export type SolanaPriceFailure = {
  reason:
    | 'RPC_HISTORY_UNAVAILABLE'
    | 'ORIGINAL_TRANSACTION_NOT_FOUND'
    | 'TARGET_SLOT_NOT_FOUND'
    | 'NO_MARKET_TRADE_WITHIN_WINDOW'
    | 'TARGET_MINT_NOT_FOUND_IN_TRANSACTION'
    | 'QUOTE_ASSET_NOT_IDENTIFIED'
    | 'NATIVE_SOL_SWAP_AMBIGUOUS'
    | 'UNSUPPORTED_VENUE'
    | 'PARSER_FAILED'
    | 'TARGET_SLOT_SEARCH_LIMIT_EXCEEDED'
    | 'BLOCK_SCAN_LIMIT_EXCEEDED'
    | 'RPC_TIME_BUDGET_EXCEEDED'
    | 'RPC_RATE_LIMITED'
    | 'RPC_ERROR';
  message: string;
};

export type SolanaPriceResult =
  | {
      ok: true;
      targetTimestamp: number;
      observation: SolanaSwapObservation;
      rpcStats?: SolanaRpcStats;
    }
  | { ok: false; targetTimestamp: number; failure: SolanaPriceFailure; rpcStats?: SolanaRpcStats };
