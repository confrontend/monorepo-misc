import type { CopyTradeReport } from './evaluate.js';
import type { HistoricalConsistencyReport, HistoricalConsistencyRow } from './historicalConsistency.js';

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
/** The historical-consistency bar for a "winner": both the early and recent slice of the
 *  wallet's own stored history must be positive — not just a recent burst (recent_only) and
 *  not a wallet whose earlier edge has faded (declining). */
const REQUIRED_HISTORICAL_CONSISTENCY_VERDICT = 'consistent';

export type CopyCandidateExclusionReason =
  | 'not_screen_pass'
  | 'not_historically_consistent'
  | 'hold_too_short'
  | 'fast_round_trip'
  | 'concentrated_in_one_token';

export type CopySurvivalStatus = 'survives' | 'fails_copy_survival' | 'not_yet_simulated';

export type CopyCandidate = {
  walletAddress: string;
  name: string | null;
  rankPosition: number | null;
  medianReturnPercent: number | null;
  winRatePercent: number | null;
  trades: number;
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
};

/** A CopyCandidate plus the copy-simulation verdict that gates final Winner status. Kept as a
 *  separate type (rather than folding these fields into CopyCandidate) because
 *  computeScreenPassCandidates legitimately has no simulation data yet to report — that
 *  function's callers (including the simulation-run route itself) need the pre-gate list
 *  without pretending a verdict exists before it's been computed. */
export type CopyCandidateWithSurvival = CopyCandidate & {
  copySurvivalStatus: CopySurvivalStatus;
  simulatedMedianReturnPercent: number | null;
  copySimulationCoverageRatePercent: number | null;
};

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
};

const gmgnProfileUrl = (walletAddress: string): string => `https://gmgn.ai/sol/address/${walletAddress}`;

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
    if (evidence.medianHoldSeconds === null || evidence.medianHoldSeconds < MIN_MEDIAN_HOLD_SECONDS) continue;
    if (evidence.fastRoundTripPercent !== null && evidence.fastRoundTripPercent > MAX_FAST_ROUND_TRIP_PERCENT) continue;
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
      fastRoundTripPercent: evidence.fastRoundTripPercent,
      concentrationPercent: concentration,
      bestTokenSymbol: row.profitConcentration.bestToken?.tokenSymbol ?? null,
      historicalConsistencyVerdict: hcRow.verdict,
      gmgnProfileUrl: gmgnProfileUrl(row.walletAddress),
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

export type CopySimulationSurvivalInput = { simulatedMedianReturnPercent: number | null; coverageRatePercent: number | null };

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

  const withSurvival: CopyCandidateWithSurvival[] = screenPass.candidates.map((candidate) => {
    const sim = copySimulationByWallet.get(candidate.walletAddress);
    const copySurvivalStatus: CopySurvivalStatus = !sim || sim.simulatedMedianReturnPercent === null
      ? 'not_yet_simulated'
      : sim.simulatedMedianReturnPercent > 0 ? 'survives' : 'fails_copy_survival';
    return {
      ...candidate,
      copySurvivalStatus,
      simulatedMedianReturnPercent: sim?.simulatedMedianReturnPercent ?? null,
      copySimulationCoverageRatePercent: sim?.coverageRatePercent ?? null,
    };
  });

  const candidates = withSurvival.filter((candidate) => candidate.copySurvivalStatus === 'survives');

  // Ranked by median return among wallets that already cleared every copy-viability gate,
  // copy-survival included — return only decides ordering once speed/concentration/consistency/
  // survival have already qualified the wallet, never before, so the fastest-looking number can
  // never outrank a real gate.
  candidates.sort((left, right) => (right.medianReturnPercent ?? -Infinity) - (left.medianReturnPercent ?? -Infinity));

  return {
    computedAt: now.toISOString(),
    thresholds: screenPass.thresholds,
    screenedCount: screenPass.screenedCount,
    candidates,
    excludedCount: report.rows.filter((row) => row.verdict === 'screen_pass').length - candidates.length,
    pendingCopySimulationCount: withSurvival.filter((c) => c.copySurvivalStatus === 'not_yet_simulated').length,
    failedCopySurvivalCount: withSurvival.filter((c) => c.copySurvivalStatus === 'fails_copy_survival').length,
  };
};
