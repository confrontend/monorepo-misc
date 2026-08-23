import type { DatabaseSync } from 'node:sqlite';
import type { CopyTradeRow } from './evaluate.js';
import { DEFAULT_COPIER_DELAY_SECONDS, type CopySimulationWalletReport } from '../simulation/copySimulation.js';
import { assessCoverageGap, type CoverageGapAssessment } from './candidateScrutiny.js';
import { hasReliableCopyEvidence } from './copyCandidates.js';
import { STRONGLY_NEGATIVE_PNL_PERCENT } from '../simulation/constants.js';
export { STRONGLY_NEGATIVE_PNL_PERCENT } from '../simulation/constants.js';

/**
 * Pre-simulation triage over an already-fetched cohort: which wallets can be dropped from
 * further Dune investment right now, using data already in hand, versus which still need it.
 *
 * A wallet is only ever eliminated when BOTH halves hold:
 *  1. `trustworthy` — the data is complete enough that a bad-looking number can be believed.
 *     Without this, a wallet sitting at 50-60% Dune coverage must never be eliminated on its
 *     visible numbers alone: this project measured that unmatched trades are ~2x more likely
 *     to be >100% winners (20.5% vs 12.1%), so a mid-coverage "loser" could be hiding exactly
 *     the trades that would flip the verdict.
 *  2. at least one bad-outcome signal fires.
 *
 * Silent GMGN omissions (rows GMGN never returned at all, not flagged truncated) are a known
 * unmeasured risk — see progress.md — and are deliberately NOT modeled here. This filter only
 * acts on gaps this project can currently see and quantify.
 */

/** A 30-day realized-PnL reading this far underwater is treated as "strongly negative" — a
 *  judgment call, not a measured threshold. Exposed as a constant so it can be revisited. */
/**
 * Coverage floor before a bad result is trusted. Was 100%, which turned out to be the single
 * gate blocking almost everything: measured on the live cohort, 57 wallets cleared every other
 * bar and failed on coverage alone — including one rejected over 3 missing round trips out of
 * 144. A flat 100% also cannot tell a 3-trade gap from a 300-trade one.
 *
 * 100% is no longer the right instrument because the thing it was protecting against is now
 * measured directly. `assessCoverageGap` reports what the wallet's real losing-trade rate is
 * across measured AND unmeasured trades — and that is a measurement, not an estimate, because
 * GMGN gives the wallet's own outcome for every trade whether Dune matched it or not. So
 * `trustworthy` now pairs this floor with a negligible hidden-loss reading, which is the check
 * that actually protects against losing money.
 *
 * 90 keeps a hard ceiling on how much of the copy-simulation median (which IS matched-only, and
 * therefore genuinely a sample) can be missing. Verified against real data: of the wallets this
 * floor newly admits, nearly all understate their true loss rate by under 2pp, and the two that
 * do not (+3.8pp, +3.9pp) are caught by the risk check rather than by this number.
 */
export const TRUSTED_DUNE_COVERAGE_PERCENT = 90;
/**
 * Deliberately FORKED from `RULES.minTrades` (100), which the candidacy gates keep. Two reasons
 * this view warrants a lower bar, and one reason it must not go lower still:
 *
 * 1. The window narrowed. That 100 was written against a 90-day window; this view now runs on
 *    30 days, so the same number silently became roughly three times harder to clear. Measured
 *    live: 15 wallets were blocked by this bar ALONE while holding 93-100% Dune coverage, a
 *    real round-trip sample, and a negligible hidden-loss reading — including two of this
 *    project's standouts (`2rD4gB`, 46 trades at 100% coverage; `7JFSAQ`, 69 trades at 99%).
 *
 * 2. The decision this gate serves is cheap to get wrong in both directions. Nothing here
 *    risks money: `trustworthy` only ever permits an *elimination*, and an elimination only
 *    means "stop spending Dune budget on this wallet". Being wrong costs a missed candidate or
 *    some wasted budget. The gate that actually protects capital is `computeCopyCandidates`,
 *    which is untouched and still requires the full `RULES.minTrades`.
 *
 * 3. But not lower than this. The column reads "Trustworthy", and a reader can reasonably carry
 *    that word further than this view intends. This project has already been burned once by a
 *    "+819%" winner resting on four trades, so the bar stays high enough that no such wallet is
 *    ever labelled trustworthy here: at 50 the thinnest cases (17 and 23 trades, both showing
 *    triple-digit copy medians) remain excluded. Lowering to 30 would admit only ~4 more
 *    wallets while letting those back in — a bad trade.
 */
export const ELIMINATION_MIN_TRADES = 50;
/** ELIMINATION_MIN_TRADES counts GMGN trade rows; coverage is a percentage of completed round
 *  trips, a much smaller and entirely separate denominator. Without this, "100% covered" could
 *  mean a handful of round trips all matched — a full-looking bar over a sample too thin to
 *  eliminate anyone on. Mirrors MIN_RELIABLE_SAMPLE, the bar used elsewhere in this project. */
export const ELIMINATION_MIN_DUNE_ROUND_TRIPS = 30;
/** Matches the 24-hour freshness window the stats fetcher itself uses to decide a stored row is
 *  still current (see statsFetch.ts). A stats snapshot older than this must not drive an
 *  elimination: the wallet may have traded since, and this view would be judging stale numbers. */
export const ELIMINATION_STATS_MAX_AGE_HOURS = 24;

export type EliminationReason =
  | 'strongly_negative_30d_pnl'
  | 'negative_delayed_copy_result'
  | 'hold_time_shorter_than_copy_delay';

export type WalletEliminationEntry = {
  walletAddress: string;
  name: string | null;
  trades: number;
  truncated: boolean;
  duneCoveragePercent: number | null;
  /** Round trips this wallet has that still lack a Dune fill. Null when the wallet has never
   *  been simulated at all, which is a stronger form of "unknown" than a low percentage. */
  duneMissedTrades: number | null;
  gmgnPnl30dPercent: number | null;
  simulatedMedianReturnPercent: number | null;
  medianHoldSeconds: number | null;
  /** Does this wallet's Dune coverage gap actually matter? Compares the wallet's OWN (GMGN)
   *  outcomes on measured vs unmeasured trades, so a wallet whose gap is benign is visibly
   *  different from one whose unmeasured trades are where all its big wins are. Null when the
   *  wallet has no simulation data at all. Descriptive only — this never eliminates a wallet. */
  coverageGap: CoverageGapAssessment | null;
  /** Whether the data behind this wallet is complete enough to trust a bad-looking verdict. */
  trustworthy: boolean;
  eliminated: boolean;
  reasons: EliminationReason[];
};

export type EliminationReport = {
  generatedAt: string;
  totalWallets: number;
  eliminated: WalletEliminationEntry[];
  surviving: WalletEliminationEntry[];
  /** Survivors that still need more Dune coverage before they could even be considered for
   *  elimination or promotion — this is the queue the refetch-time estimate is sized against. */
  survivorsNeedingDune: WalletEliminationEntry[];
  /** Among those, how many have never been simulated even once — duneMissedTrades is null for
   *  these, so they are excluded from the target count below and it undercounts real work by
   *  design rather than guessing a number for them. */
  survivorsNeverSimulatedCount: number;
  /** Sum of duneMissedTrades over survivors that DO have simulation data. A deliberate lower
   *  bound on remaining Dune work, not a full estimate — see survivorsNeverSimulatedCount. */
  measuredDuneTargetsRemaining: number;
};

export const computeEliminationReport = (
  rows: CopyTradeRow[],
  simulationByWallet: Map<string, CopySimulationWalletReport>,
  now = new Date(),
): EliminationReport => {
  const entries: WalletEliminationEntry[] = rows.map((row) => {
    const sim = simulationByWallet.get(row.walletAddress);
    const duneCoveragePercent = sim?.coverageRatePercent ?? null;
    const duneMissedTrades = sim?.missedTrades ?? null;
    const gmgnPnl30dPercent = row.gmgnAggregate?.realizedProfitPnlPercent ?? null;
    const simulatedMedianReturnPercent = sim?.simulatedMedianReturnPercent ?? null;
    const medianHoldSeconds = row.riskEvidence.medianHoldSeconds;

    const coverageGap = sim ? assessCoverageGap(sim.trades) : null;

    // `historyFailed` is a distinct failure from `truncated`: truncated means "we stopped early
    // at a known cap", failed means "GMGN errored and we do not know what we are missing".
    // The second is strictly worse, so it must disqualify a wallet from being eliminated too.
    //
    // The last clause is the one carrying the safety weight. Coverage alone only says HOW MUCH
    // is unmeasured; the hidden-loss reading says whether what is unmeasured actually changes
    // the wallet's real losing-trade rate. A wallet is only judged here when both hold: enough
    // was measured, and what was missed provably did not flatter it.
    const trustworthy = !row.truncated
      && row.historyFailed !== true
      && row.trades >= ELIMINATION_MIN_TRADES
      && hasReliableCopyEvidence(sim)
      && coverageGap?.hiddenLossRisk === 'negligible'
      && coverageGap?.hiddenUpsideBias === 'negligible';

    // Freshness is checked per-reason rather than folded into `trustworthy`, because only this
    // one reason reads the GMGN stats snapshot; the copy-result and hold-time reasons come from
    // stored trades and stay valid regardless of how old the stats row is.
    const statsAgeHours = row.gmgnAggregate
      ? (now.getTime() - Date.parse(row.gmgnAggregate.fetchedAt)) / 3_600_000 : null;
    const statsFresh = statsAgeHours !== null && Number.isFinite(statsAgeHours) && statsAgeHours <= ELIMINATION_STATS_MAX_AGE_HOURS;

    const reasons: EliminationReason[] = [];
    if (statsFresh && gmgnPnl30dPercent !== null && gmgnPnl30dPercent <= STRONGLY_NEGATIVE_PNL_PERCENT) reasons.push('strongly_negative_30d_pnl');
    if (simulatedMedianReturnPercent !== null && simulatedMedianReturnPercent <= 0) reasons.push('negative_delayed_copy_result');
    if (medianHoldSeconds !== null && medianHoldSeconds < DEFAULT_COPIER_DELAY_SECONDS) reasons.push('hold_time_shorter_than_copy_delay');

    return {
      walletAddress: row.walletAddress,
      name: row.name,
      trades: row.trades,
      truncated: row.truncated,
      duneCoveragePercent,
      duneMissedTrades,
      gmgnPnl30dPercent,
      simulatedMedianReturnPercent,
      medianHoldSeconds,
      coverageGap,
      trustworthy,
      eliminated: trustworthy && reasons.length > 0,
      reasons,
    };
  });

  const eliminated = entries.filter((entry) => entry.eliminated);
  // Judged wallets first. The surviving list runs to ~98 rows and the handful that are actually
  // decidable were previously buried a dozen rows down, so the table read as "everything is
  // undecided" from the top. Ordering is presentation only — it changes no verdict.
  const surviving = entries.filter((entry) => !entry.eliminated).sort((left, right) => {
    if (left.trustworthy !== right.trustworthy) return left.trustworthy ? -1 : 1;
    return (right.duneCoveragePercent ?? -1) - (left.duneCoveragePercent ?? -1);
  });
  // "Needs Dune" means exactly: not yet judgeable, AND more Dune data would actually change
  // that. Filtering on the coverage floor alone got both halves wrong. It missed wallets sitting
  // above 90% whose hidden-loss reading is not yet negligible — those are blocked by a
  // Dune-resolvable problem too, since fetching the remaining matches shrinks the unmeasured
  // population and therefore the understatement. And it counted wallets that more Dune cannot
  // help at all: one live wallet sits at 100% coverage with zero missing targets and is still
  // not trustworthy, because its blocker is trade count, not coverage. Requiring outstanding
  // targets covers both cases, and keeps the time estimate honest in both directions.
  const survivorsNeedingDune = surviving.filter((entry) => !entry.trustworthy
    && (entry.duneMissedTrades === null || entry.duneMissedTrades > 0));
  const survivorsNeverSimulatedCount = survivorsNeedingDune.filter((entry) => entry.duneMissedTrades === null).length;
  const measuredDuneTargetsRemaining = survivorsNeedingDune.reduce((sum, entry) => sum + (entry.duneMissedTrades ?? 0), 0);

  return {
    generatedAt: now.toISOString(),
    totalWallets: entries.length,
    eliminated,
    surviving,
    survivorsNeedingDune,
    survivorsNeverSimulatedCount,
    measuredDuneTargetsRemaining,
  };
};

export type DuneRefetchEstimate = {
  targetsNeeded: number;
  secondsPerTarget: number;
  estimatedSeconds: number;
  basis: 'measured' | 'seeded';
  runsCounted: number;
};

/** This project's own run history is the seed: a 150-target batch completed in 2,941s
 *  (progress.md), giving ~19.6s/target under GMGN's leaky-bucket limiter. Replaced by a
 *  measured rate the moment any completed runs exist to compute one from. */
const SEEDED_SECONDS_PER_DUNE_TARGET = 2_941 / 150;
const MAX_RUNS_CONSIDERED = 20;

export const estimateDuneRefetchDuration = (database: DatabaseSync, targetsNeeded: number): DuneRefetchEstimate => {
  const rows = database.prepare(
    `SELECT requested_at AS requestedAt, completed_at AS completedAt, trade_refs AS tradeRefs
     FROM copytrade_copy_simulation_runs
     WHERE status = 'completed' AND completed_at IS NOT NULL
     ORDER BY id DESC LIMIT ?`,
  ).all(MAX_RUNS_CONSIDERED) as Array<{ requestedAt: string; completedAt: string; tradeRefs: string }>;

  let totalSeconds = 0;
  let totalTargets = 0;
  for (const row of rows) {
    const start = Date.parse(row.requestedAt);
    const end = Date.parse(row.completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    let targetCount = 0;
    try {
      const refs = JSON.parse(row.tradeRefs) as unknown;
      targetCount = Array.isArray(refs) ? refs.length : 0;
    } catch { continue; }
    if (targetCount <= 0) continue;
    totalSeconds += (end - start) / 1000;
    totalTargets += targetCount;
  }

  const secondsPerTarget = totalTargets > 0 ? totalSeconds / totalTargets : SEEDED_SECONDS_PER_DUNE_TARGET;
  return {
    targetsNeeded,
    secondsPerTarget: Math.round(secondsPerTarget * 10) / 10,
    estimatedSeconds: Math.round(secondsPerTarget * targetsNeeded),
    basis: totalTargets > 0 ? 'measured' : 'seeded',
    runsCounted: rows.length,
  };
};
