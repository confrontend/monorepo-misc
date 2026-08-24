import type { DatabaseSync } from 'node:sqlite';
import { median, type CopyTradeRow } from './evaluate.js';
import {
  DORMANT_AFTER_DAYS,
  MAX_CONCENTRATION_PERCENT,
  MIN_MEDIAN_HOLD_SECONDS,
} from './copyCandidates.js';
import {
  computeCopySimulationReport,
  DEFAULT_COPIER_DELAY_SECONDS,
  MIN_COPY_SIMULATION_SAMPLE,
  TAIL_THRESHOLD_PERCENT,
  type CopySimulationTradeResult,
  type CopySimulationWalletReport,
} from '../simulation/copySimulation.js';
import {
  splitByDate,
  suggestSplitDate,
  type DatedObservation,
} from '../../platform/stats-utils/holdout.js';

/**
 * Interrogates individual pinned candidates against fixed thresholds. This is deliberately NOT a
 * re-ranking layer: every check below compares one wallet's own numbers to a constant, never to
 * another candidate. See research/prompts/copytrade-candidate-scrutiny-task.md for the incidents
 * that motivated each check. Read-only over data computeCopyTradeReport / computeCopySimulationReport
 * already produced (or can produce without any new Dune/GMGN request) — this module never mutates
 * copytrade_trades, never issues a Dune query, and never touches the gates in copyCandidates.ts.
 */

export const MAX_SCRUTINY_WALLETS = 100;

export type ScrutinyVerdict = 'pass' | 'fail' | 'insufficient';

export type ScrutinyCheck<M extends Record<string, unknown>> = {
  key: string;
  label: string;
  verdict: ScrutinyVerdict;
  /** Sample size behind this verdict. Every check carries one — a verdict without it is not
   *  shippable per this feature's own requirement. */
  n: number;
  detail: string;
  metrics: M;
};

/** Below this many observations in a group, a median is shown but not trusted as a verdict.
 *  Distinct from MIN_COPY_SIMULATION_SAMPLE (which gates the Dune-backed checks) because this
 *  guards purely descriptive, locally-computed groupings (repeat-entry vs single-entry tokens). */
export const MIN_GROUP_SAMPLE = 5;
/** Coverage below this share of a wallet's window is treated as a fail. Deliberately lenient —
 *  this project has decided to live with missing Dune data rather than chase verification
 *  completeness: the goal is picking directionally real winners (even a modest ~5%/month edge),
 *  not percentage-accurate copy-simulation figures. Only genuinely thin coverage fails. */
export const COVERAGE_FAIL_THRESHOLD_PERCENT = 25;
/** A gap this large between matched- and unmatched-trade win rates is treated as a directional
 *  bias worth flagging. Deliberately loose (not this project's originally-measured ~8.4pp gap,
 *  20.5% vs 12.1%) — a modest gap from ordinary missing data is expected and tolerated; only a
 *  gap large enough to plausibly matter for "is this wallet a real winner" should fail. */
export const COVERAGE_BIAS_GAP_THRESHOLD_PERCENTAGE_POINTS = 30;
/** A wallet whose top 3 simulated trades carry more than half of its total positive simulated
 *  return is flagged fragile. */
export const TAIL_FRAGILITY_SHARE_THRESHOLD_PERCENT = 50;
/** Scored legs (buy+sell rows in the scoring window) more lopsided than this split are flagged —
 *  a sanity check for the specific bug class already found in the Top Callers path, where sells
 *  were being scored as if they were independent wins. */
export const BUY_SHARE_MIN_PERCENT = 35;
export const BUY_SHARE_MAX_PERCENT = 65;
/** Derived, not invented: the project's own existing MIN_MEDIAN_HOLD_SECONDS gate (60s) already
 *  encodes "comfortably above the copier delay" as 4x DEFAULT_COPIER_DELAY_SECONDS (15s). Reused
 *  here as the scrutiny pass/fail line rather than picking a second, disagreeing number. */
export const COPYABILITY_MIN_DELAY_MULTIPLE =
  MIN_MEDIAN_HOLD_SECONDS / DEFAULT_COPIER_DELAY_SECONDS;

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const pct = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? round((numerator / denominator) * 100, 1) : null;

type ScrutinyTrade = {
  sourceId: number;
  timestamp: number;
  returnRatio: number;
  tokenAddress: string;
};

type RawTradeRow = {
  id: number;
  walletAddress: string;
  observedTimestamp: number;
  eventType: string;
  tokenAddress: string;
  costUsd: string | null;
  buyCostUsd: string | null;
};

const parseAmount = (value: string | null): number | null => {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A single wallet's raw buy/sell rows, optionally scoped to a cutoff. evaluate.ts's own reader is
 * folded into one whole-roster report and is not usable standalone for a single wallet on demand,
 * so this mirrors its exact parsing rule (a sell needs a positive cost basis to become a
 * completed trade; missing is excluded, never zeroed) rather than duplicating the whole report.
 */
const readWalletTrades = (
  database: DatabaseSync,
  walletAddress: string,
  chain: string,
  cutoffSeconds: number | null,
): {
  completed: ScrutinyTrade[];
  buyCount: number;
  sellCount: number;
  excludedNoCostBasis: number;
} => {
  const rows = (cutoffSeconds === null
    ? database
        .prepare(
          `SELECT id, wallet_address AS walletAddress, observed_timestamp AS observedTimestamp,
              event_type AS eventType, token_address AS tokenAddress, cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
       FROM copytrade_trades WHERE chain = ? AND wallet_address = ? AND event_type IN ('buy', 'sell')
       ORDER BY observed_timestamp ASC, id ASC`,
        )
        .all(chain, walletAddress)
    : database
        .prepare(
          `SELECT id, wallet_address AS walletAddress, observed_timestamp AS observedTimestamp,
              event_type AS eventType, token_address AS tokenAddress, cost_usd AS costUsd, buy_cost_usd AS buyCostUsd
       FROM copytrade_trades WHERE chain = ? AND wallet_address = ? AND event_type IN ('buy', 'sell') AND observed_timestamp >= ?
       ORDER BY observed_timestamp ASC, id ASC`,
        )
        .all(chain, walletAddress, cutoffSeconds)) as unknown as RawTradeRow[];

  const completed: ScrutinyTrade[] = [];
  let buyCount = 0;
  let sellCount = 0;
  let excludedNoCostBasis = 0;
  for (const row of rows) {
    if (row.eventType === 'buy') {
      buyCount += 1;
      continue;
    }
    if (row.eventType !== 'sell') continue;
    sellCount += 1;
    const proceeds = parseAmount(row.costUsd);
    const costBasis = parseAmount(row.buyCostUsd);
    if (proceeds === null || costBasis === null || costBasis <= 0) {
      excludedNoCostBasis += 1;
      continue;
    }
    completed.push({
      sourceId: row.id,
      timestamp: row.observedTimestamp,
      returnRatio: (proceeds - costBasis) / costBasis,
      tokenAddress: row.tokenAddress,
    });
  }
  return { completed, buyCount, sellCount, excludedNoCostBasis };
};

const medianOf = (trades: ScrutinyTrade[]): number | null => {
  const value = median(trades.map((t) => t.returnRatio));
  return value === null ? null : round(value * 100, 2);
};

// ---------------------------------------------------------------------------------------------

type DormancyMetrics = { daysSinceLastTrade: number | null; dormantAfterDays: number };
type CoverageMetrics = {
  inWindowMatched: number;
  inWindowTotal: number;
  inWindowPercent: number | null;
  fullHistoryMatched: number;
  fullHistoryTotal: number;
  fullHistoryPercent: number | null;
};
type CoverageBiasMetrics = {
  matchedBigWinPercent: number | null;
  matchedN: number;
  unmatchedBigWinPercent: number | null;
  unmatchedN: number;
  gapPercentagePoints: number | null;
  direction: 'conservative' | 'optimistic' | 'unclear' | 'no_gap';
};
type ConcentrationMetrics = {
  bestTokenSymbol: string | null;
  bestTokenSharePercent: number | null;
  medianWithToken: number | null;
  medianWithoutToken: number | null;
  tradesWithoutToken: number;
};
type RepeatEntryMetrics = {
  repeatEntryMedianReturnPercent: number | null;
  repeatEntryN: number;
  singleEntryMedianReturnPercent: number | null;
  singleEntryN: number;
};
type BuySellMetrics = { buyCount: number; sellCount: number; buySharePercent: number | null };
type DivergenceMetrics = {
  medianReturnPercent: number | null;
  averageReturnPercent: number | null;
  diverges: boolean;
};
type TailFragilityMetrics = {
  top3SharePercent: number | null;
  tradesAboveThreshold: number;
  thresholdPercent: number;
  simulatedTrades: number;
};
type CopyabilityMetrics = {
  medianHoldSeconds: number | null;
  copierDelaySeconds: number;
  delayMultiple: number | null;
  minRequiredMultiple: number;
};
type StabilityMetrics = {
  splitDate: string | null;
  earlyMedianReturnPercent: number | null;
  earlyN: number;
  lateMedianReturnPercent: number | null;
  lateN: number;
};

export type CandidateScrutinyReport = {
  walletAddress: string;
  name: string | null;
  computedAt: string;
  selectionContext: { candidateCount: number; screenedCount: number; note: string };
  checks: {
    dormancy: ScrutinyCheck<DormancyMetrics>;
    coverage: ScrutinyCheck<CoverageMetrics>;
    coverageBias: ScrutinyCheck<CoverageBiasMetrics>;
    concentration: ScrutinyCheck<ConcentrationMetrics>;
    repeatEntry: ScrutinyCheck<RepeatEntryMetrics>;
    buySellComposition: ScrutinyCheck<BuySellMetrics>;
    medianMeanDivergence: ScrutinyCheck<DivergenceMetrics>;
    tailFragility: ScrutinyCheck<TailFragilityMetrics>;
    copyability: ScrutinyCheck<CopyabilityMetrics>;
    outOfSampleStability: ScrutinyCheck<StabilityMetrics>;
  };
};

const bigWinShare = (
  trades: CopySimulationTradeResult[],
): { sharePercent: number | null; n: number } => {
  const withOwnReturn = trades.filter((t) => t.walletReturnPercent !== null);
  if (withOwnReturn.length === 0) return { sharePercent: null, n: 0 };
  const bigWins = withOwnReturn.filter(
    (t) => (t.walletReturnPercent as number) > TAIL_THRESHOLD_PERCENT,
  ).length;
  return { sharePercent: pct(bigWins, withOwnReturn.length), n: withOwnReturn.length };
};

export type CoverageGapDirection = 'conservative' | 'optimistic' | 'unclear' | 'no_gap';

/** How much the measured sample understates this wallet's real losing-trade rate. Judgment
 *  calls, but anchored to the decision they serve: the goal these gate is "don't lose money",
 *  so they are deliberately asymmetric — a wallet that looks WORSE than reality is never
 *  flagged, only one that looks BETTER. */
export const HIDDEN_LOSS_HIGH_PERCENTAGE_POINTS = 10;
export const HIDDEN_LOSS_MODERATE_PERCENTAGE_POINTS = 3;

export type HiddenLossRisk = 'high' | 'moderate' | 'negligible' | 'unknown';

export type CoverageGapAssessment = {
  matchedBigWinPercent: number | null;
  matchedN: number;
  unmatchedBigWinPercent: number | null;
  unmatchedN: number;
  gapPercentagePoints: number | null;
  direction: CoverageGapDirection;
  /** Raw big-win difference multiplied by the unmatched share. This is the comparable,
   * coverage-weighted quantity used for the hidden-upside classification. */
  upsideBiasWeightedPercentagePoints: number | null;
  /** Losing-trade rate the measured (Dune-matched) sample shows on its own. */
  shownLossRatePercent: number | null;
  /** Losing-trade rate over measured AND unmeasured trades together, using the wallet's own
   *  GMGN outcomes — which exist for every trade, matched or not. */
  trueLossRatePercent: number | null;
  /** trueLossRate - shownLossRate. Coverage-weighted by construction, which is the whole point:
   *  a 30pp difference between the two populations barely moves this when 99% of trades are
   *  measured, but dominates it when only 9% are. Measured live on this cohort, weighting flips
   *  which wallets look risky — only 1 of the top 5 by raw difference is still top 5 here. */
  lossRateUnderstatedPercentagePoints: number | null;
  hiddenLossRisk: HiddenLossRisk;
  /** Whether unmatched trades contain materially more big wins than the measured sample. */
  hiddenUpsideBias: HiddenLossRisk;
};

/**
 * Answers "does the Dune coverage gap actually matter for this wallet?" without inventing a
 * copier price for the unmatched trades.
 *
 * Dune's job is to price what a *copier* would have paid ~15s later; GMGN separately gives the
 * wallet's own realized return on EVERY trade, matched or not. So while the copier outcome is
 * genuinely unknown for unmatched trades, the wallet's own outcome is not — which makes it
 * possible to ask whether the unmeasured trades were ordinary for this wallet or were the
 * exceptional ones.
 *
 * Cohort-wide this project measured unmatched trades to be roughly twice as likely to be big
 * winners (20.5% vs 12.1%), because Dune fails to match thin, newly-launched tokens. That is a
 * population fact, not a per-wallet one: this function is what turns it into a per-wallet
 * reading, so a wallet whose gap is benign stops being lumped in with one whose gap hides its
 * entire edge.
 *
 * Never returns a "safe" answer from missing data: with no matched or no unmatched trades to
 * compare, the direction is `no_gap` and the caller must treat it as unknown, not as a pass.
 */
export const assessCoverageGap = (trades: CopySimulationTradeResult[]): CoverageGapAssessment => {
  const matchedTrades = trades.filter((t) => t.status === 'simulated');
  const unmatchedTrades = trades.filter((t) => t.status !== 'simulated');
  const matched = bigWinShare(matchedTrades);
  const unmatched = bigWinShare(unmatchedTrades);
  const gapPercentagePoints =
    matched.sharePercent !== null && unmatched.sharePercent !== null
      ? round(unmatched.sharePercent - matched.sharePercent, 1)
      : null;
  const upsideBiasWeightedPercentagePoints =
    gapPercentagePoints === null || matched.n + unmatched.n === 0
      ? null
      : round((gapPercentagePoints * unmatched.n) / (matched.n + unmatched.n), 1);
  const direction: CoverageGapDirection =
    matched.n === 0 || unmatched.n === 0
      ? 'no_gap'
      : gapPercentagePoints === null
        ? 'unclear'
        : gapPercentagePoints >= COVERAGE_BIAS_GAP_THRESHOLD_PERCENTAGE_POINTS
          ? 'conservative'
          : gapPercentagePoints <= -COVERAGE_BIAS_GAP_THRESHOLD_PERCENTAGE_POINTS
            ? 'optimistic'
            : 'unclear';

  // Loss side, coverage-weighted. Separate from the big-win direction above because they answer
  // different questions and were measured to disagree: on this cohort the pooled big-win figure
  // says unmatched trades do BETTER, while per-wallet the loss rate says unmatched trades lose
  // MORE in 68 of 93 wallets. Only the loss side speaks to "would copying this lose money".
  const losers = (list: CopySimulationTradeResult[]): { rate: number | null; n: number } => {
    const withOwnReturn = list.filter((t) => t.walletReturnPercent !== null);
    if (withOwnReturn.length === 0) return { rate: null, n: 0 };
    return {
      rate: pct(
        withOwnReturn.filter((t) => (t.walletReturnPercent as number) < 0).length,
        withOwnReturn.length,
      ),
      n: withOwnReturn.length,
    };
  };
  const shown = losers(matchedTrades);
  const overall = losers([...matchedTrades, ...unmatchedTrades]);
  // Only "nothing was measured" is unknown. "Nothing is missing" is the opposite: with zero
  // unmatched trades the shown and true rates are the same number by construction, so the
  // understatement is exactly 0 and the risk is genuinely negligible. Treating a fully covered
  // wallet as unassessable would reject the best-evidenced wallets in the cohort.
  const comparable = shown.n > 0 && shown.rate !== null && overall.rate !== null;
  const lossRateUnderstatedPercentagePoints = comparable
    ? round((overall.rate as number) - (shown.rate as number), 1)
    : null;
  const hiddenLossRisk: HiddenLossRisk =
    !comparable || lossRateUnderstatedPercentagePoints === null
      ? 'unknown'
      : lossRateUnderstatedPercentagePoints > HIDDEN_LOSS_HIGH_PERCENTAGE_POINTS
        ? 'high'
        : lossRateUnderstatedPercentagePoints > HIDDEN_LOSS_MODERATE_PERCENTAGE_POINTS
          ? 'moderate'
          : 'negligible';
  // For elimination, a gap that makes a wallet look worse is also unsafe: the measured Dune
  // subset may be hiding the upside that would justify spending more budget. Track both sides.
  // Use the same coverage-weighted scale as hiddenLossRisk. A raw 100pp difference from two
  // unmatched trades is not equivalent to a raw 100pp difference across hundreds of trades.
  const hiddenUpsideBias: HiddenLossRisk =
    unmatched.n === 0
      ? 'negligible'
      : upsideBiasWeightedPercentagePoints === null || matched.n === 0
        ? 'unknown'
        : upsideBiasWeightedPercentagePoints > HIDDEN_LOSS_HIGH_PERCENTAGE_POINTS
          ? 'high'
          : upsideBiasWeightedPercentagePoints > HIDDEN_LOSS_MODERATE_PERCENTAGE_POINTS
            ? 'moderate'
            : 'negligible';

  return {
    matchedBigWinPercent: matched.sharePercent,
    matchedN: matched.n,
    unmatchedBigWinPercent: unmatched.sharePercent,
    unmatchedN: unmatched.n,
    gapPercentagePoints,
    upsideBiasWeightedPercentagePoints,
    direction,
    shownLossRatePercent: shown.rate,
    trueLossRatePercent: overall.rate,
    lossRateUnderstatedPercentagePoints,
    hiddenLossRisk,
    hiddenUpsideBias,
  };
};

/** Computes every scrutiny check for one wallet. `row` is that wallet's already-computed
 *  CopyTradeReport row (periodDays: 90, the same scope /api/copytrade/winners uses) — reused
 *  wholesale rather than recomputed, so this view can never disagree with the pipeline it is
 *  describing. `simInWindow`/`simFullHistory` are computeCopySimulationReport results for this
 *  wallet at, respectively, the same 90-day scope and no period filter (full history); both are
 *  pure reads over already-stored Dune matches, no network call. */
export const computeCandidateScrutiny = (
  database: DatabaseSync,
  walletAddress: string,
  context: {
    row: CopyTradeRow;
    simInWindow: CopySimulationWalletReport;
    simFullHistory: CopySimulationWalletReport;
    candidateCount: number;
    screenedCount: number;
    chain?: string;
    scopePeriodDays: number;
    now?: Date;
  },
): CandidateScrutinyReport => {
  const { row, simInWindow, simFullHistory } = context;
  const chain = context.chain ?? 'sol';
  const now = context.now ?? new Date();

  // --- 1. Dormancy ---------------------------------------------------------------------------
  const dormancy: ScrutinyCheck<DormancyMetrics> = {
    key: 'dormancy',
    label: 'Dormancy',
    n: row.lastTradeAt === null ? 0 : 1,
    verdict:
      row.daysSinceLastTrade === null
        ? 'insufficient'
        : row.daysSinceLastTrade > DORMANT_AFTER_DAYS
          ? 'fail'
          : 'pass',
    detail:
      row.daysSinceLastTrade === null
        ? 'No completed trades on record.'
        : `Last completed trade ${row.daysSinceLastTrade} day(s) ago (dormant past ${DORMANT_AFTER_DAYS}).`,
    metrics: { daysSinceLastTrade: row.daysSinceLastTrade, dormantAfterDays: DORMANT_AFTER_DAYS },
  };

  // --- 2. Coverage, both denominators --------------------------------------------------------
  const inWindowPercent = pct(simInWindow.copiedTrades, simInWindow.roundTripsConsidered);
  const fullHistoryPercent = pct(simFullHistory.copiedTrades, simFullHistory.roundTripsConsidered);
  // Verdict is driven by the in-window (scoped) percentage — matching every other check here —
  // with the full-history percentage kept alongside purely as context (see the check's own
  // purpose: a wallet reading 100% in-window can still sit on a much thinner full history).
  const noInWindowCoverage = simInWindow.copiedTrades === 0;
  const coverage: ScrutinyCheck<CoverageMetrics> = {
    key: 'coverage',
    label: 'Dune coverage',
    n: simInWindow.roundTripsConsidered,
    verdict:
      simInWindow.roundTripsConsidered === 0 || noInWindowCoverage
        ? 'insufficient'
        : (inWindowPercent ?? 0) >= COVERAGE_FAIL_THRESHOLD_PERCENT
          ? 'pass'
          : 'fail',
    detail:
      simInWindow.roundTripsConsidered === 0
        ? 'No round trips with a resolvable buy exist for this wallet in the scoring window.'
        : noInWindowCoverage
          ? 'No Dune match exists yet within the scoring window.'
          : `${simInWindow.copiedTrades}/${simInWindow.roundTripsConsidered} matched in-window (${inWindowPercent}%); ${simFullHistory.copiedTrades}/${simFullHistory.roundTripsConsidered} matched across full history (${fullHistoryPercent}%).`,
    metrics: {
      inWindowMatched: simInWindow.copiedTrades,
      inWindowTotal: simInWindow.roundTripsConsidered,
      inWindowPercent,
      fullHistoryMatched: simFullHistory.copiedTrades,
      fullHistoryTotal: simFullHistory.roundTripsConsidered,
      fullHistoryPercent,
    },
  };

  // --- 3. Coverage bias direction -------------------------------------------------------------
  const gapAssessment = assessCoverageGap(simInWindow.trades);
  const matchedShare = {
    sharePercent: gapAssessment.matchedBigWinPercent,
    n: gapAssessment.matchedN,
  };
  const unmatchedShare = {
    sharePercent: gapAssessment.unmatchedBigWinPercent,
    n: gapAssessment.unmatchedN,
  };
  const gap = gapAssessment.gapPercentagePoints;
  const biasInsufficient = noInWindowCoverage || matchedShare.n === 0 || unmatchedShare.n === 0;
  const direction: CoverageBiasMetrics['direction'] = biasInsufficient
    ? 'no_gap'
    : gapAssessment.direction;
  const coverageBias: ScrutinyCheck<CoverageBiasMetrics> = {
    key: 'coverageBias',
    label: 'Coverage bias direction',
    n: matchedShare.n + unmatchedShare.n,
    verdict: biasInsufficient ? 'insufficient' : direction === 'unclear' ? 'pass' : 'fail',
    detail: biasInsufficient
      ? 'Not enough verified and unverified trades to compare.'
      : direction === 'conservative'
        ? `The trades we couldn't verify won big more often (${unmatchedShare.sharePercent}%) than the ones we could (${matchedShare.sharePercent}%) — so this wallet's real results are probably even better than shown.`
        : direction === 'optimistic'
          ? `The trades we couldn't verify won big less often (${unmatchedShare.sharePercent}%) than the ones we could (${matchedShare.sharePercent}%) — so this wallet's real results are probably a bit worse than shown.`
          : `Verified (${matchedShare.sharePercent}%) and unverified (${unmatchedShare.sharePercent}%) trades won big at about the same rate — no sign of bias either way.`,
    metrics: {
      matchedBigWinPercent: matchedShare.sharePercent,
      matchedN: matchedShare.n,
      unmatchedBigWinPercent: unmatchedShare.sharePercent,
      unmatchedN: unmatchedShare.n,
      gapPercentagePoints: gap,
      direction,
    },
  };

  // --- 4. Token concentration ------------------------------------------------------------------
  const concentrationShare = row.profitConcentration.bestTokenSharePositiveProfitPercent;
  const concentration: ScrutinyCheck<ConcentrationMetrics> = {
    key: 'concentration',
    label: 'Token concentration',
    n: row.trades,
    verdict:
      concentrationShare === null
        ? 'insufficient'
        : concentrationShare > MAX_CONCENTRATION_PERCENT
          ? 'fail'
          : 'pass',
    detail:
      concentrationShare === null
        ? 'No positive profit to attribute to any token.'
        : `Best token (${row.profitConcentration.bestToken?.tokenSymbol ?? 'unknown'}) is ${concentrationShare}% of positive profit; median without it is ${row.profitConcentration.excludingBestToken.medianReturnPercent ?? '—'}% (with it: ${row.medianReturnPercent ?? '—'}%) over ${row.profitConcentration.excludingBestToken.trades} remaining trades.`,
    metrics: {
      bestTokenSymbol: row.profitConcentration.bestToken?.tokenSymbol ?? null,
      bestTokenSharePercent: concentrationShare,
      medianWithToken: row.medianReturnPercent,
      medianWithoutToken: row.profitConcentration.excludingBestToken.medianReturnPercent,
      tradesWithoutToken: row.profitConcentration.excludingBestToken.trades,
    },
  };

  // --- 5. Repeat-entry dependence ---------------------------------------------------------------
  const scoped = readWalletTrades(
    database,
    walletAddress,
    chain,
    cutoffSecondsFor(context.scopePeriodDays, now),
  );
  const byToken = new Map<string, ScrutinyTrade[]>();
  for (const trade of scoped.completed) {
    const list = byToken.get(trade.tokenAddress) ?? [];
    list.push(trade);
    byToken.set(trade.tokenAddress, list);
  }
  // Disjoint by construction: every completed trade belongs to exactly one token's group, and a
  // token contributes to repeatEntry XOR singleEntry depending on its own trade count — together
  // they reconstruct scoped.completed exactly.
  const repeatEntryTrades: ScrutinyTrade[] = [];
  const singleEntryTrades: ScrutinyTrade[] = [];
  for (const trades of byToken.values())
    (trades.length > 1 ? repeatEntryTrades : singleEntryTrades).push(...trades);
  const repeatMedian = medianOf(repeatEntryTrades);
  const singleMedian = medianOf(singleEntryTrades);
  const repeatInsufficient =
    repeatEntryTrades.length < MIN_GROUP_SAMPLE || singleEntryTrades.length < MIN_GROUP_SAMPLE;
  const repeatEntry: ScrutinyCheck<RepeatEntryMetrics> = {
    key: 'repeatEntry',
    label: 'Repeat-entry dependence',
    n: repeatEntryTrades.length + singleEntryTrades.length,
    verdict: repeatInsufficient
      ? 'insufficient'
      : repeatMedian !== null && repeatMedian > 0 && singleMedian !== null && singleMedian <= 0
        ? 'fail'
        : 'pass',
    detail: repeatInsufficient
      ? `Not enough trades on one side to compare, in the last ${context.scopePeriodDays} days (re-bought: n=${repeatEntryTrades.length}, bought once: n=${singleEntryTrades.length}).`
      : `In the last ${context.scopePeriodDays} days, tokens it bought more than once averaged ${repeatMedian}% (n=${repeatEntryTrades.length}); tokens it only bought once averaged ${singleMedian}% (n=${singleEntryTrades.length}).`,
    metrics: {
      repeatEntryMedianReturnPercent: repeatMedian,
      repeatEntryN: repeatEntryTrades.length,
      singleEntryMedianReturnPercent: singleMedian,
      singleEntryN: singleEntryTrades.length,
    },
  };

  // --- 6. Buy/sell composition -------------------------------------------------------------------
  const totalLegs = scoped.buyCount + scoped.sellCount;
  const buySharePercent = pct(scoped.buyCount, totalLegs);
  const buySellComposition: ScrutinyCheck<BuySellMetrics> = {
    key: 'buySellComposition',
    label: 'Buy/sell composition',
    n: totalLegs,
    verdict:
      totalLegs < MIN_COPY_SIMULATION_SAMPLE
        ? 'insufficient'
        : buySharePercent !== null &&
            buySharePercent >= BUY_SHARE_MIN_PERCENT &&
            buySharePercent <= BUY_SHARE_MAX_PERCENT
          ? 'pass'
          : 'fail',
    detail:
      totalLegs < MIN_COPY_SIMULATION_SAMPLE
        ? `Only ${totalLegs} scored legs in the scoring window.`
        : `${scoped.buyCount} buys / ${scoped.sellCount} sells (${buySharePercent}% entries) of ${totalLegs} scored legs.`,
    metrics: { buyCount: scoped.buyCount, sellCount: scoped.sellCount, buySharePercent },
  };

  // --- 7. Median vs mean divergence ---------------------------------------------------------------
  const diverges =
    row.medianReturnPercent !== null &&
    row.averageReturnPercent !== null &&
    Math.sign(row.medianReturnPercent) !== 0 &&
    Math.sign(row.averageReturnPercent) !== 0 &&
    Math.sign(row.medianReturnPercent) !== Math.sign(row.averageReturnPercent);
  const medianMeanDivergence: ScrutinyCheck<DivergenceMetrics> = {
    key: 'medianMeanDivergence',
    label: 'Median vs mean divergence',
    n: row.trades,
    verdict:
      row.medianReturnPercent === null || row.averageReturnPercent === null
        ? 'insufficient'
        : diverges
          ? 'fail'
          : 'pass',
    detail:
      row.medianReturnPercent === null || row.averageReturnPercent === null
        ? 'Median or mean could not be computed.'
        : diverges
          ? `Median ${row.medianReturnPercent}% and mean ${row.averageReturnPercent}% disagree in sign — this wallet's edge, if any, depends on rare outliers.`
          : `Median ${row.medianReturnPercent}% and mean ${row.averageReturnPercent}% agree in sign.`,
    metrics: {
      medianReturnPercent: row.medianReturnPercent,
      averageReturnPercent: row.averageReturnPercent,
      diverges,
    },
  };

  // --- 8. Tail fragility -----------------------------------------------------------------------
  const simulatedFull = simInWindow.trades.filter(
    (t) => t.status === 'simulated' && t.simulatedReturnPercent !== null,
  );
  const positiveContributions = simulatedFull
    .map((t) => t.simulatedReturnPercent as number)
    .filter((v) => v > 0);
  const totalPositive = positiveContributions.reduce((sum, v) => sum + v, 0);
  const top3Sum = [...positiveContributions]
    .sort((a, b) => b - a)
    .slice(0, 3)
    .reduce((sum, v) => sum + v, 0);
  const top3SharePercent = totalPositive > 0 ? round((top3Sum / totalPositive) * 100, 1) : null;
  const tailFragility: ScrutinyCheck<TailFragilityMetrics> = {
    key: 'tailFragility',
    label: 'Tail fragility',
    n: simulatedFull.length,
    verdict:
      totalPositive <= 0 || simulatedFull.length === 0
        ? 'insufficient'
        : top3SharePercent !== null && top3SharePercent > TAIL_FRAGILITY_SHARE_THRESHOLD_PERCENT
          ? 'fail'
          : 'pass',
    detail:
      totalPositive <= 0 || simulatedFull.length === 0
        ? 'No positive simulated return to attribute to any trades in the scoring window.'
        : `Top 3 simulated trades are ${top3SharePercent}% of total positive simulated return; ${simInWindow.tradesAbove100Percent} trade(s) exceed +${TAIL_THRESHOLD_PERCENT}% out of ${simulatedFull.length} simulated.`,
    metrics: {
      top3SharePercent,
      tradesAboveThreshold: simInWindow.tradesAbove100Percent,
      thresholdPercent: TAIL_THRESHOLD_PERCENT,
      simulatedTrades: simulatedFull.length,
    },
  };

  // --- 9. Copyability --------------------------------------------------------------------------
  const holdSeconds = row.riskEvidence.medianHoldSeconds;
  const delayMultiple =
    holdSeconds === null ? null : round(holdSeconds / DEFAULT_COPIER_DELAY_SECONDS, 2);
  const copyability: ScrutinyCheck<CopyabilityMetrics> = {
    key: 'copyability',
    label: 'Copyability',
    n: row.trades,
    verdict:
      holdSeconds === null
        ? 'insufficient'
        : delayMultiple !== null && delayMultiple >= COPYABILITY_MIN_DELAY_MULTIPLE
          ? 'pass'
          : 'fail',
    detail:
      holdSeconds === null
        ? 'No hold time could be computed.'
        : `Median hold ${holdSeconds}s is ${delayMultiple}x the assumed ${DEFAULT_COPIER_DELAY_SECONDS}s copier delay (an unverified assumption — never measured against a real fill); needs at least ${round(COPYABILITY_MIN_DELAY_MULTIPLE, 1)}x.`,
    metrics: {
      medianHoldSeconds: holdSeconds,
      copierDelaySeconds: DEFAULT_COPIER_DELAY_SECONDS,
      delayMultiple,
      minRequiredMultiple: round(COPYABILITY_MIN_DELAY_MULTIPLE, 2),
    },
  };

  // --- 10. Out-of-sample stability ---------------------------------------------------------------
  // Split the same 30-day-scoped population every other check uses (`scoped`, built in step 5)
  // rather than reaching into full history — early/late halves of a shorter window are still a
  // real chronological split, just over less data (and MIN_GROUP_SAMPLE below still guards
  // against reading too little of it as a verdict).
  const observations: (DatedObservation & { returnRatio: number })[] = scoped.completed.map(
    (t) => ({
      observedAt: new Date(t.timestamp * 1000).toISOString(),
      returnRatio: t.returnRatio,
    }),
  );
  const splitDate = suggestSplitDate(observations);
  let split: ReturnType<typeof splitByDate<DatedObservation & { returnRatio: number }>> | null =
    null;
  if (splitDate) split = splitByDate(observations, splitDate);
  const earlyMedian = split ? median(split.discovery.map((o) => o.returnRatio)) : null;
  const lateMedian = split ? median(split.test.map((o) => o.returnRatio)) : null;
  const stabilityInsufficient =
    !split || split.discovery.length < MIN_GROUP_SAMPLE || split.test.length < MIN_GROUP_SAMPLE;
  const earlyMedianPct = earlyMedian === null ? null : round(earlyMedian * 100, 2);
  const lateMedianPct = lateMedian === null ? null : round(lateMedian * 100, 2);
  const outOfSampleStability: ScrutinyCheck<StabilityMetrics> = {
    key: 'outOfSampleStability',
    label: 'Out-of-sample stability',
    n: observations.length,
    verdict: stabilityInsufficient
      ? 'insufficient'
      : earlyMedianPct !== null &&
          lateMedianPct !== null &&
          earlyMedianPct > 0 &&
          lateMedianPct <= 0
        ? 'fail'
        : 'pass',
    detail: stabilityInsufficient
      ? split
        ? `Too few trades on one side of the split (early n=${split.discovery.length}, late n=${split.test.length}).`
        : 'Fewer than 2 distinct trading dates — no chronological split is meaningful.'
      : `Early half median ${earlyMedianPct}% (n=${split!.discovery.length}) vs late half median ${lateMedianPct}% (n=${split!.test.length}), split at ${splitDate}.`,
    metrics: {
      splitDate,
      earlyMedianReturnPercent: earlyMedianPct,
      earlyN: split?.discovery.length ?? 0,
      lateMedianReturnPercent: lateMedianPct,
      lateN: split?.test.length ?? 0,
    },
  };

  // --- 11. Selection context ---------------------------------------------------------------------
  const selectionContext = {
    candidateCount: context.candidateCount,
    screenedCount: context.screenedCount,
    note: `This wallet was selected as one of ${context.candidateCount} candidates from ${context.screenedCount} wallets scanned. No statistical correction is applied to that selection.`,
  };

  return {
    walletAddress,
    name: row.name,
    computedAt: now.toISOString(),
    selectionContext,
    checks: {
      dormancy,
      coverage,
      coverageBias,
      concentration,
      repeatEntry,
      buySellComposition,
      medianMeanDivergence,
      tailFragility,
      copyability,
      outOfSampleStability,
    },
  };
};

const cutoffSecondsFor = (periodDays: number, now: Date): number =>
  Math.floor(now.getTime() / 1000) - periodDays * 86_400;

/**
 * Batch entry point for the route: computes scrutiny for up to MAX_SCRUTINY_WALLETS wallets. The
 * caller supplies the already-computed CopyTradeReport rows (periodDays: 90, matching /winners)
 * and candidate/screened counts (from computeCopyCandidates); this function only adds the two
 * per-wallet computeCopySimulationReport calls (in-window and full-history) needed for the
 * coverage-dependent checks, and the wallet-scoped local queries for checks 5/6/10.
 */
export const computeCandidateScrutinyBatch = (
  database: DatabaseSync,
  walletAddresses: string[],
  context: {
    rowsByWallet: Map<string, CopyTradeRow>;
    candidateCount: number;
    screenedCount: number;
    scopePeriodDays: number;
    chain?: string;
    now?: Date;
  },
): CandidateScrutinyReport[] => {
  const capped = walletAddresses.slice(0, MAX_SCRUTINY_WALLETS);
  // Batched across all wallets, not called per-wallet: computeCopySimulationReport already accepts
  // a wallet-address list and internally reloads/reparses every completed Dune run's raw result
  // (readAllCopySimulationMatches) on every call, regardless of how many wallets were asked for.
  // Calling it once per wallet (as this used to, twice each for in-window/full-history) reloaded
  // that table up to 2x MAX_SCRUTINY_WALLETS times for one Scrutiny page load -- with ~97 pinned
  // wallets that is what pushed a cold (uncached) load past the client's 45s timeout, not the
  // browser-cache removal itself. Per-wallet output is unaffected: each wallet's round trips, open
  // positions, and coverage rows are already scoped to that wallet inside the shared report.
  const inWindowByWallet = new Map(
    computeCopySimulationReport(database, {
      walletAddresses: capped,
      periodDays: context.scopePeriodDays,
    }).wallets.map((w) => [w.walletAddress, w]),
  );
  const fullHistoryByWallet = new Map(
    computeCopySimulationReport(database, { walletAddresses: capped }).wallets.map((w) => [
      w.walletAddress,
      w,
    ]),
  );
  const reports: CandidateScrutinyReport[] = [];
  for (const walletAddress of capped) {
    const row = context.rowsByWallet.get(walletAddress);
    if (!row) continue;
    const simInWindow = inWindowByWallet.get(walletAddress);
    const simFullHistory = fullHistoryByWallet.get(walletAddress);
    if (!simInWindow || !simFullHistory) continue;
    reports.push(
      computeCandidateScrutiny(database, walletAddress, {
        row,
        simInWindow,
        simFullHistory,
        candidateCount: context.candidateCount,
        screenedCount: context.screenedCount,
        chain: context.chain,
        scopePeriodDays: context.scopePeriodDays,
        now: context.now,
      }),
    );
  }
  return reports;
};
