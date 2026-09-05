import type { SolanaSwapObservation, SolanaTransaction } from './types.js';

type Balance = {
  accountIndex?: number;
  mint?: string;
  owner?: string;
  uiTokenAmount?: { amount?: string; decimals?: number };
};
type Meta = {
  preTokenBalances?: Balance[];
  postTokenBalances?: Balance[];
  err?: unknown;
  preBalances?: number[];
  postBalances?: number[];
  fee?: number;
};

export const parseSplTokenSwap = (
  tx: SolanaTransaction,
  tokenMint: string,
  targetTimestamp: number,
  signature = '',
): SolanaSwapObservation | null => {
  const meta = tx.meta as Meta | undefined;
  if (!meta || meta.err || !meta.preTokenBalances || !meta.postTokenBalances) return null;
  const pre = new Map(meta.preTokenBalances.filter((b) => b.mint).map((b) => [b.accountIndex, b]));
  const post = new Map(
    meta.postTokenBalances.filter((b) => b.mint).map((b) => [b.accountIndex, b]),
  );
  let tokenDelta = 0;
  let quoteDelta = 0;
  let quoteMint: string | 'SOL' | undefined;
  for (const index of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(index);
    const after = post.get(index);
    const mint = after?.mint ?? before?.mint;
    if (!mint) continue;
    const decimals = after?.uiTokenAmount?.decimals ?? before?.uiTokenAmount?.decimals ?? 0;
    const value = (entry: Balance | undefined): bigint =>
      BigInt(entry?.uiTokenAmount?.amount ?? '0');
    const delta = Number(value(after) - value(before)) / 10 ** decimals;
    if (mint === tokenMint) tokenDelta += delta;
    else if (
      mint === 'So11111111111111111111111111111111111111112' ||
      mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
    ) {
      quoteDelta += delta;
      quoteMint = mint;
    }
  }
  if (tokenDelta === 0 || quoteDelta === 0) return null;
  const blockTime = Number(tx.blockTime);
  const slot = Number(tx.slot);
  if (!Number.isFinite(blockTime) || !Number.isFinite(slot)) return null;
  return {
    signature,
    slot,
    blockTime,
    tokenMint,
    quoteMint: quoteMint === 'So11111111111111111111111111111111111111112' ? 'SOL' : quoteMint!,
    tokenAmount: Math.abs(tokenDelta),
    quoteAmount: Math.abs(quoteDelta),
    priceInQuote: Math.abs(quoteDelta / tokenDelta),
    direction: tokenDelta > 0 ? 'buy' : 'sell',
    timestampGapSeconds: blockTime - targetTimestamp,
    parser: 'spl_balance_delta',
    confidence: 'medium',
  };
};
