export const gmgnWalletUrl = (walletAddress: string): string =>
  `https://gmgn.ai/sol/address/${encodeURIComponent(walletAddress)}`;
