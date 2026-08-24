/**
 * ORIENTATION FOR FUTURE AGENTS — "is this wallet worth pursuing" is answered in four places,
 * at four different pipeline stages, deliberately NOT unified into one function (they run on
 * different available data and answer different questions):
 *
 *  1. walletRiskGuardrails.ts — assessWalletRiskGuardrails(). Pre-fetch, GMGN-stats-only. Cheap
 *     red flags (wash_trader tag, extreme volume, thin sample, weak win rate, imbalance, strongly
 *     negative PnL) checked BEFORE spending any Dune budget on a wallet.
 *  2. eliminationFilter.ts — computeEliminationReport(). Post-GMGN, pre/mid-Dune triage: which
 *     already-fetched wallets can be dropped from FURTHER Dune investment right now. Forks its
 *     own thresholds from this file's (e.g. a lower min-trade bar) for reasons documented at each
 *     constant — an elimination only costs a wasted fetch, so it can tolerate a lower bar than a
 *     real Winner needs.
 *  3. candidateScrutiny.ts — assessCoverageGap(). Not a pass/fail gate itself; quantifies whether
 *     a wallet's UNMEASURED (Dune-missing) trades would flip its verdict if they were measured.
 *     Consumed by eliminationFilter.ts's `trustworthy` check.
 *  4. THIS FILE — computeCopyCandidates()/computeScreenPassCandidates(). The final, authoritative
 *     "Winner" gate: screen-pass + historical consistency + hold time + concentration + a real
 *     copy-simulation survival check. This is the only one of the four that risks presenting a
 *     wallet as safe to actually copy — the other three only ever narrow what gets investigated.
 *
 * eliminationFilter.ts already imports hasReliableCopyEvidence/STRONGLY_NEGATIVE_PNL_PERCENT
 * from here rather than redefining them — follow that pattern before adding a fifth decision path.
 */
import type { CopyTradeReport } from './evaluate.js';
import type {
  HistoricalConsistencyReport,
  HistoricalConsistencyRow,
} from './historicalConsistency.js';

/**
 * "Winners" — traders that pass the descriptive screen, look practically copyable, AND whose
 * edge actually survives a realistic copy-trading simulation (delay, fees, slippage, gas — see
 * copySimulation.ts). Three thresholds below were derived from this project's own live wallet
 * data (not guessed): dropping sub-60s median holds, >50% fast-round-trip rates, and >40%
 * single-token profit concentration took a 13-wallet screen-pass list down to 5 wallets whose
 * numbers survive contact with what copying actually requires. The copy-survival gate was added
 * after live simulation of the resulting 3 wallets showed only 1 of 3 actually stayed profitable
 * once delay/fees/slippage/gas were applied — a real edge on paper is not the same as an edge
 * that survives copying it, and the earlier gates alone could not tell the two apart.
 */
export const MIN_MEDIAN_HOLD_SECONDS = 60;
export const MAX_FAST_ROUND_TRIP_PERCENT = 50;
export const MAX_CONCENTRATION_PERCENT = 40;
/** Tail candidates need enough copied trades to make a positive mean interpretable. */
export const MIN_HIGH_UPSIDE_COVERAGE_PERCENT = 70;
export const MIN_HIGH_UPSIDE_BIG_WINS = 1;
/** Shared 30-day copy-evidence gates used by final candidates and triage. */
export const MIN_COPY_EVIDENCE_COVERAGE_PERCENT = 90;
export const MIN_COPY_EVIDENCE_ROUND_TRIPS = 30;

/** Shared evidence-quality gate.  Candidate ranking and Dune-budget triage may answer
 * different questions, but they must agree on what counts as a sufficiently measured
 * 30-day copy simulation. */
export const hasReliableCopyEvidence = (
  simulation: CopySimulationSurvivalInput | null | undefined,
): boolean =>
  Boolean(
    simulation &&
    simulation.gasCostComplete === true &&
    (simulation.coverageRatePercent ?? 0) >= MIN_COPY_EVIDENCE_COVERAGE_PERCENT &&
    (simulation.roundTripsConsidered ?? 0) >= MIN_COPY_EVIDENCE_ROUND_TRIPS,
  );
/** The historical-consistency bar for a "winner": both the early and recent slice of the
 *  wallet's own stored history must be positive — not just a recent burst (recent_only) and
 *  not a wallet whose earlier edge has faded (declining). */
const REQUIRED_HISTORICAL_CONSISTENCY_VERDICT = 'consistent';

export type CopySurvivalStatus = 'survives' | 'fails_copy_survival' | 'not_yet_simulated';

export type CopyCandidate = {
  walletAddress: string;
  name: string | null;
  rankPosition: number | null;
  medianReturnPercent: number | null;
  winRatePercent: number | null;
  trades: number;
  endingCapitalUsd: number | null;
  endingCapitalUsdCompounded: number | null;
  coveredDays: number | null;
  analysisPeriodDays: number;
  medianHoldSeconds: number | null;
  fastRoundTripPercent: number | null;
  concentrationPercent: number | null;
  bestTokenSymbol: string | null;
  historicalConsistencyVerdict: HistoricalConsistencyRow['verdict'] | null;
  /** GMGN's own wallet-profile URL, copied directly from the href pattern GMGN's leaderboard
   *  itself renders (`/sol/address/{wallet}`) — not a fabricated deep link. This project never
   *  executes a trade or copy action itself; this link is where the human does that, on GMGN's
   *  own product. */
  gmgnProfileUrl: string;
  /** How long since this wallet last traded. A strong historical record says nothing about
   *  whether the wallet is still active — see CopyTradeRow.lastTradeAt for the real case that
   *  motivated surfacing this. Null when the wallet has no completed trades. */
  daysSinceLastTrade: number | null;
  /** True past DORMANT_AFTER_DAYS. Deliberately does NOT remove the wallet from the list or
   *  change its returns — those numbers are still real history. It only stops a dormant wallet
   *  from being presented as a live, actionable candidate. */
  dormant: boolean;
};

/** A wallet with no trades for this long is reported as dormant. Set at two weeks: long enough
 *  that a normal quiet stretch or a fetch gap won't trip it, short enough to catch a wallet that
 *  has genuinely stopped. */
export const DORMANT_AFTER_DAYS = 14;

/** A CopyCandidate plus the copy-simulation verdict that gates final Winner status. Kept as a
 *  separate type (rather than folding these fields into CopyCandidate) because
 *  computeScreenPassCandidates legitimately has no simulation data yet to report — that
 *  function's callers (including the simulation-run route itself) need the pre-gate list
 *  without pretending a verdict exists before it's been computed. */
export type CopyCandidateWithSurvival = CopyCandidate & {
  copySurvivalStatus: CopySurvivalStatus;
  simulatedMedianReturnPercent: number | null;
  simulatedMeanReturnPercent: number | null;
  tradesAbove100Percent: number;
  tailShareOfMeanPercent: number | null;
  copySimulationCoverageRatePercent: number | null;
};

/** A separate tail-oriented classification. These are not mixed into the median winners: their
 * typical trade may be flat/negative, while a small number of large wins produces a positive
 * mean. The UI must present them as high-upside candidates, not as equally reliable winners. */
export type HighUpsideCandidate = CopyCandidateWithSurvival;

export type ScreenPassCandidatesReport = {
  computedAt: string;
  thresholds: {
    minMedianHoldSeconds: number;
    maxFastRoundTripPercent: number;
    maxConcentrationPercent: number;
    requiredHistoricalConsistencyVerdict: string;
  };
  screenedCount: number;
  candidates: CopyCandidate[];
  excludedCount: number;
};

export type CopyCandidatesReport = {
  computedAt: string;
  thresholds: ScreenPassCandidatesReport['thresholds'];
  screenedCount: number;
  candidates: CopyCandidateWithSurvival[];
  excludedCount: number;
  /** Passed screen/hc/hold/fastRT/concentration but has no copy-simulation result yet — an
   *  actionable count, distinct from a wallet that was checked and failed, since this one only
   *  needs the "Run simulation" action to potentially resolve. */
  pendingCopySimulationCount: number;
  /** Passed every other gate, was actually simulated, and did not survive (non-positive
   *  simulated median) — a verified negative, not an absence of data. */
  failedCopySurvivalCount: number;
  /** Tail-oriented candidates kept separate from the consistent median winners. */
  highUpsideCandidates: HighUpsideCandidate[];
  highUpsidePendingSimulationCount: number;
};

const gmgnProfileUrl = (walletAddress: string): string =>
  `https://gmgn.ai/sol/address/${walletAddress}`;

/**
 * Every gate EXCEPT copy-survival: screen_pass, historical consistency, hold time,
 * fast-round-trip, concentration. Exported on its own because the copy-simulation pipeline
 * needs exactly this list — the wallets that are worth spending Dune queries verifying — before
 * it can know who to check. Feeding the *final* (post-survival-gate) Winners list back into
 * "who should we simulate" would be circular: a wallet can never earn a first simulation if only
 * already-verified wallets get simulated.
 */
export const computeScreenPassCandidates = (
  report: CopyTradeReport,
  historicalConsistency: HistoricalConsistencyReport,
  now = new Date(),
): ScreenPassCandidatesReport => {
  const hcByWallet = new Map(historicalConsistency.rows.map((row) => [row.walletAddress, row]));
  const screenPassRows = report.rows.filter((row) => row.verdict === 'screen_pass');

  const candidates: CopyCandidate[] = [];
  for (const row of screenPassRows) {
    const hcRow = hcByWallet.get(row.walletAddress);
    if (hcRow?.verdict !== REQUIRED_HISTORICAL_CONSISTENCY_VERDICT) continue;
    const evidence = row.riskEvidence;
    if (evidence.medianHoldSeconds === null || evidence.medianHoldSeconds < MIN_MEDIAN_HOLD_SECONDS)
      continue;
    if (
      evidence.fastRoundTripPercent !== null &&
      evidence.fastRoundTripPercent > MAX_FAST_ROUND_TRIP_PERCENT
    )
      continue;
    const concentration = row.profitConcentration.bestTokenSharePositiveProfitPercent;
    if (concentration !== null && concentration > MAX_CONCENTRATION_PERCENT) continue;

    candidates.push({
      walletAddress: row.walletAddress,
      name: row.name,
      rankPosition: row.rankHistory.currentRank,
      medianReturnPercent: row.medianReturnPercent,
      winRatePercent: row.winRatePercent,
      trades: row.trades,
      medianHoldSeconds: evidence.medianHoldSeconds,
      endingCapitalUsd: row.endingCapitalUsd,
      endingCapitalUsdCompounded: row.endingCapitalUsdCompounded,
      coveredDays: row.coveredDays,
      analysisPeriodDays: report.periodDays,
      fastRoundTripPercent: evidence.fastRoundTripPercent,
      concentrationPercent: concentration,
      bestTokenSymbol: row.profitConcentration.bestToken?.tokenSymbol ?? null,
      historicalConsistencyVerdict: hcRow.verdict,
      gmgnProfileUrl: gmgnProfileUrl(row.walletAddress),
      daysSinceLastTrade: row.daysSinceLastTrade,
      dormant: row.daysSinceLastTrade !== null && row.daysSinceLastTrade > DORMANT_AFTER_DAYS,
    });
  }

  return {
    computedAt: now.toISOString(),
    thresholds: {
      minMedianHoldSeconds: MIN_MEDIAN_HOLD_SECONDS,
      maxFastRoundTripPercent: MAX_FAST_ROUND_TRIP_PERCENT,
      maxConcentrationPercent: MAX_CONCENTRATION_PERCENT,
      requiredHistoricalConsistencyVerdict: REQUIRED_HISTORICAL_CONSISTENCY_VERDICT,
    },
    screenedCount: report.rows.length,
    candidates,
    excludedCount: screenPassRows.length - candidates.length,
  };
};

/** Candidate rows eligible for a tail/upside simulation. This deliberately does not require a
 * positive historical median: that is the exact population the second classification exists to
 * expose. It still requires enough history, complete collection, consistency, and the same
 * copyability gates as the median path. */
export const computeHighUpsideEligibleCandidates = (
  report: CopyTradeReport,
  historicalConsistency: HistoricalConsistencyReport,
): CopyCandidate[] => {
  const hcByWallet = new Map(historicalConsistency.rows.map((row) => [row.walletAddress, row]));
  const candidates: CopyCandidate[] = [];
  for (const row of report.rows) {
    if (
      row.verdict === 'flagged' ||
      row.truncated ||
      row.trades < report.rules.minTrades ||
      (row.coveredDays ?? 0) < report.rules.minDays
    )
      continue;
    if (row.averageReturnPercent === null || row.averageReturnPercent <= 0) continue;
    // Keep the groups mutually exclusive: a positive-median row belongs in Consistent winners.
    if (row.medianReturnPercent !== null && row.medianReturnPercent > 0) continue;
    const hcRow = hcByWallet.get(row.walletAddress);
    if (hcRow?.verdict !== REQUIRED_HISTORICAL_CONSISTENCY_VERDICT) continue;
    const evidence = row.riskEvidence;
    if (evidence.medianHoldSeconds === null || evidence.medianHoldSeconds < MIN_MEDIAN_HOLD_SECONDS)
      continue;
    if (
      evidence.fastRoundTripPercent !== null &&
      evidence.fastRoundTripPercent > MAX_FAST_ROUND_TRIP_PERCENT
    )
      continue;
    const concentration = row.profitConcentration.bestTokenSharePositiveProfitPercent;
    if (concentration !== null && concentration > MAX_CONCENTRATION_PERCENT) continue;
    candidates.push({
      walletAddress: row.walletAddress,
      name: row.name,
      rankPosition: row.rankHistory.currentRank,
      medianReturnPercent: row.medianReturnPercent,
      winRatePercent: row.winRatePercent,
      trades: row.trades,
      endingCapitalUsd: row.endingCapitalUsd,
      endingCapitalUsdCompounded: row.endingCapitalUsdCompounded,
      coveredDays: row.coveredDays,
      analysisPeriodDays: report.periodDays,
      medianHoldSeconds: evidence.medianHoldSeconds,
      fastRoundTripPercent: evidence.fastRoundTripPercent,
      concentrationPercent: concentration,
      bestTokenSymbol: row.profitConcentration.bestToken?.tokenSymbol ?? null,
      historicalConsistencyVerdict: hcRow.verdict,
      gmgnProfileUrl: gmgnProfileUrl(row.walletAddress),
      daysSinceLastTrade: row.daysSinceLastTrade,
      dormant: row.daysSinceLastTrade !== null && row.daysSinceLastTrade > DORMANT_AFTER_DAYS,
    });
  }
  return candidates;
};

export type CopySimulationSurvivalInput = {
  simulatedMedianReturnPercent: number | null;
  simulatedMeanReturnPercent?: number | null;
  tradesAbove100Percent?: number;
  tailShareOfMeanPercent?: number | null;
  coverageRatePercent: number | null;
  portfolioRealizedPnlUsd?: number | null;
  gasCostComplete?: boolean;
  roundTripsConsidered?: number;
};

/**
 * Pure combination over three already-computed inputs — no database access here. The caller
 * (see the /api/copytrade/winners route) is responsible for computing copySimulationByWallet
 * from computeScreenPassCandidates' own output, so the join by wallet address means something.
 *
 * A wallet with no entry in copySimulationByWallet at all (never simulated) is excluded, not
 * silently passed — "we don't know yet" must never look the same as "it survives". Same for a
 * simulatedMedianReturnPercent of exactly null (queried, but nothing matched within the
 * staleness gate): still excluded, still distinguishable in the report as 'not_yet_simulated'
 * vs the wallet actually having a verified non-positive result ('fails_copy_survival').
 */
export const computeCopyCandidates = (
  report: CopyTradeReport,
  historicalConsistency: HistoricalConsistencyReport,
  copySimulationByWallet: Map<string, CopySimulationSurvivalInput> = new Map(),
  now = new Date(),
): CopyCandidatesReport => {
  const screenPass = computeScreenPassCandidates(report, historicalConsistency, now);
  const highUpsideEligible = computeHighUpsideEligibleCandidates(report, historicalConsistency);

  const withSurvival: CopyCandidateWithSurvival[] = screenPass.candidates.map((candidate) => {
    const sim = copySimulationByWallet.get(candidate.walletAddress);
    const usesFullDecisionModel =
      sim?.portfolioRealizedPnlUsd !== undefined || sim?.gasCostComplete !== undefined;
    const survives = usesFullDecisionModel
      ? sim?.portfolioRealizedPnlUsd != null &&
        sim.portfolioRealizedPnlUsd > 0 &&
        hasReliableCopyEvidence(sim)
      : sim?.simulatedMedianReturnPercent != null && sim.simulatedMedianReturnPercent > 0;
    const copySurvivalStatus: CopySurvivalStatus =
      !sim ||
      (!usesFullDecisionModel && sim.simulatedMedianReturnPercent === null) ||
      (usesFullDecisionModel && sim.portfolioRealizedPnlUsd === null)
        ? 'not_yet_simulated'
        : survives
          ? 'survives'
          : 'fails_copy_survival';
    return {
      ...candidate,
      copySurvivalStatus,
      simulatedMedianReturnPercent: sim?.simulatedMedianReturnPercent ?? null,
      simulatedMeanReturnPercent: sim?.simulatedMeanReturnPercent ?? null,
      tradesAbove100Percent: sim?.tradesAbove100Percent ?? 0,
      tailShareOfMeanPercent: sim?.tailShareOfMeanPercent ?? null,
      copySimulationCoverageRatePercent: sim?.coverageRatePercent ?? null,
    };
  });

  const candidates = withSurvival.filter(
    (candidate) => candidate.copySurvivalStatus === 'survives',
  );

  const highUpsideWithSurvival = highUpsideEligible.map((candidate) => {
    const sim = copySimulationByWallet.get(candidate.walletAddress);
    const usesFullDecisionModel =
      sim?.portfolioRealizedPnlUsd !== undefined || sim?.gasCostComplete !== undefined;
    const survives = usesFullDecisionModel
      ? sim?.portfolioRealizedPnlUsd != null &&
        sim.portfolioRealizedPnlUsd > 0 &&
        hasReliableCopyEvidence(sim)
      : sim?.simulatedMeanReturnPercent != null && sim.simulatedMeanReturnPercent > 0;
    return {
      ...candidate,
      copySurvivalStatus:
        !sim ||
        (!usesFullDecisionModel && sim.simulatedMedianReturnPercent === null) ||
        (usesFullDecisionModel && sim.portfolioRealizedPnlUsd === null)
          ? ('not_yet_simulated' as const)
          : survives
            ? ('survives' as const)
            : ('fails_copy_survival' as const),
      simulatedMedianReturnPercent: sim?.simulatedMedianReturnPercent ?? null,
      simulatedMeanReturnPercent: sim?.simulatedMeanReturnPercent ?? null,
      tradesAbove100Percent: sim?.tradesAbove100Percent ?? 0,
      tailShareOfMeanPercent: sim?.tailShareOfMeanPercent ?? null,
      copySimulationCoverageRatePercent: sim?.coverageRatePercent ?? null,
    };
  });
  const highUpsideCandidates = highUpsideWithSurvival
    .filter(
      (candidate) =>
        candidate.copySurvivalStatus === 'survives' &&
        (candidate.simulatedMeanReturnPercent ?? 0) > 0 &&
        (candidate.copySimulationCoverageRatePercent ?? 0) >= MIN_HIGH_UPSIDE_COVERAGE_PERCENT &&
        candidate.tradesAbove100Percent >= MIN_HIGH_UPSIDE_BIG_WINS,
    )
    .sort(
      (left, right) =>
        (right.simulatedMeanReturnPercent ?? -Infinity) -
        (left.simulatedMeanReturnPercent ?? -Infinity),
    );

  // Ranked by portfolio net P&L when the full simulation is available; legacy callers fall back
  // to the historical median until they provide the new fields.
  // copy-survival included — return only decides ordering once speed/concentration/consistency/
  // survival have already qualified the wallet, never before, so the fastest-looking number can
  // never outrank a real gate.
  candidates.sort((left, right) => {
    const leftSim = copySimulationByWallet.get(left.walletAddress);
    const rightSim = copySimulationByWallet.get(right.walletAddress);
    const leftUsesFullModel =
      leftSim?.portfolioRealizedPnlUsd !== undefined || leftSim?.gasCostComplete !== undefined;
    const rightUsesFullModel =
      rightSim?.portfolioRealizedPnlUsd !== undefined || rightSim?.gasCostComplete !== undefined;
    const leftValue = leftUsesFullModel
      ? (leftSim?.portfolioRealizedPnlUsd ?? -Infinity)
      : (left.medianReturnPercent ?? -Infinity);
    const rightValue = rightUsesFullModel
      ? (rightSim?.portfolioRealizedPnlUsd ?? -Infinity)
      : (right.medianReturnPercent ?? -Infinity);
    return rightValue - leftValue;
  });

  return {
    computedAt: now.toISOString(),
    thresholds: screenPass.thresholds,
    screenedCount: screenPass.screenedCount,
    candidates,
    excludedCount:
      report.rows.filter((row) => row.verdict === 'screen_pass').length - candidates.length,
    pendingCopySimulationCount: withSurvival.filter(
      (c) => c.copySurvivalStatus === 'not_yet_simulated',
    ).length,
    failedCopySurvivalCount: withSurvival.filter(
      (c) => c.copySurvivalStatus === 'fails_copy_survival',
    ).length,
    highUpsideCandidates,
    highUpsidePendingSimulationCount: highUpsideWithSurvival.filter(
      (c) => c.copySurvivalStatus === 'not_yet_simulated',
    ).length,
  };
};
