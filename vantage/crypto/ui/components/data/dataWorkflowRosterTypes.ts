export type DataWorkflowRosterWallet = {
  walletAddress: string;
  chain: string;
  name: string | null;
  rankPosition: number | null;
  tradeCount: number;
  realizedProfitUsd: number | null;
  realizedPnlPercent: number | null;
  verified60d: boolean;
  deepestCompletedDays: number | null;
};

export type DataWorkflowRosterResponse = {
  generatedAt: string;
  chain: string;
  snapshotId: number | null;
  capturedAt: string | null;
  wallets: DataWorkflowRosterWallet[];
};
