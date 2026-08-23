import { STRONGLY_NEGATIVE_PNL_PERCENT } from '../simulation/constants.js';

/** Judgment-call cutoffs picked from the live cohort's own distribution (each currently cuts a
 *  small single-digit slice) — unlike the tag and PnL checks below, which are not judgment
 *  calls. Exposed as named constants (rather than inline literals) so they can be revisited, and
 *  so this file is the one place to change them instead of a UI-only copy drifting from a
 *  backend one. */
export const HIGH_VOLUME_30D_THRESHOLD = 5000;
export const HIGH_CREATED_TOKEN_COUNT_THRESHOLD = 100;
export const THIN_SAMPLE_30D_THRESHOLD = 10;
export const WEAK_WIN_RATE_PERCENT = 20;
export const ONE_SIDED_IMBALANCE_PERCENT = 90;

export type WalletRiskStats30d = {
  tags: string[];
  realizedProfitPnlPercent: number | null;
  buyCount: number | null;
  sellCount: number | null;
  createdTokenCount: number | null;
  winRatePercent: number | null;
};

/**
 * Seven pre-Dune guardrail checks built entirely from data the official GMGN API already
 * returns on every regular wallet_stats fetch (no new request, no blocked web-cookie endpoint):
 * a wallet tagged wash_trader by GMGN itself, a strongly negative realized 30d PnL% (same bar
 * eliminationFilter.ts uses post-Dune, applied here pre-fetch instead), unusually high 30d trade
 * volume, a wallet that has itself created a large number of tokens (deployer/farmer signature,
 * not a trader worth copying), a very thin 30d trade sample, a weak win rate, and a near-total
 * buy/sell imbalance (one-sided activity, e.g. airdrop farming rather than round-trip trading).
 *
 * Pure function, no database/network access, so it can be called identically from the UI (a
 * pre-fetch scope filter), a future CLI/batch script, or a test — previously this existed only
 * as inline logic inside a React component body with no other caller able to reuse it.
 */
export const assessWalletRiskGuardrails = (stats30d: WalletRiskStats30d): string[] => {
  const reasons: string[] = [];
  if (stats30d.tags.includes('wash_trader')) reasons.push('GMGN-flagged wash trader');
  if (stats30d.realizedProfitPnlPercent !== null && stats30d.realizedProfitPnlPercent <= STRONGLY_NEGATIVE_PNL_PERCENT) {
    reasons.push(`30d PnL ${stats30d.realizedProfitPnlPercent.toFixed(0)}%`);
  }
  const buys30d = stats30d.buyCount ?? 0;
  const sells30d = stats30d.sellCount ?? 0;
  const volume30d = buys30d + sells30d;
  if (volume30d > HIGH_VOLUME_30D_THRESHOLD) reasons.push(`${volume30d.toLocaleString()} trades in 30d`);
  if (stats30d.createdTokenCount !== null && stats30d.createdTokenCount > HIGH_CREATED_TOKEN_COUNT_THRESHOLD) {
    reasons.push(`created ${stats30d.createdTokenCount.toLocaleString()} tokens`);
  }
  if (volume30d > 0 && volume30d < THIN_SAMPLE_30D_THRESHOLD) reasons.push(`only ${volume30d} trades in 30d`);
  if (stats30d.winRatePercent !== null && stats30d.winRatePercent < WEAK_WIN_RATE_PERCENT) reasons.push(`${stats30d.winRatePercent.toFixed(0)}% win rate`);
  if (volume30d > 0) {
    const imbalancePercent = Math.abs(buys30d - sells30d) / volume30d * 100;
    if (imbalancePercent > ONE_SIDED_IMBALANCE_PERCENT) reasons.push(`${imbalancePercent.toFixed(0)}% one-sided (${buys30d} buys / ${sells30d} sells)`);
  }
  return reasons;
};
