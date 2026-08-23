export interface NormalizedGmgnSignal {
  observedAt: string | null;
  tokenAddress: string | null;
  signalType: string | null;
  marketCap: number | null;
  triggeringWallet: string | null;
  rawWalletLabels: unknown | null;
  sourceUrl: string | null;
  ingestionLatencyMs: number | null;
  source: string | null;
  chain: string | null;
  sourceEventId: string | null;
  triggerAt: string | null;
  triggerMc: number | null;
  firstTriggerMc: number | null;
  signalTimes: number | null;
  signalTimesByType: unknown | null;
  queryMarketCap: number | null;
  queryAth: number | null;
  queryCurData: unknown | null;
}

export interface StoredGmgnSignal extends NormalizedGmgnSignal {
  id: number;
  rawPayload: string;
  capturedAt: string;
  validationErrors: string[];
  duplicate: boolean;
}
