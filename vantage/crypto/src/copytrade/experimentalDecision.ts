import type { DatabaseSync } from 'node:sqlite';
import { computeCopyTradeReport, RULES, type CopyTradeRow } from './scrutiny/evaluate.js';
import { computeCopySimulationReport, type CopySimulationWalletReport } from './simulation/copySimulation.js';
import { computeLiquidityImpactReport } from './simulation/copySimulation.js';
import { computeCandidateScrutinyBatch, type CandidateScrutinyReport } from './scrutiny/candidateScrutiny.js';
import { readGmgnRiskResults } from './scrutiny/gmgnRisk.js';
import { hasReliableCopyEvidence } from './scrutiny/copyCandidates.js';

/**
 * A deliberately separate, read-only scoring experiment.
 *
 * This is not used by the production verdict engine. It is a transparent way to compare
 * several saved-evidence dimensions before we decide whether a new decision model is useful.
 * In particular, it must never fetch a provider or silently turn missing evidence into a zero.
 */
export type ExperimentalDecisionWallet = {
  walletAddress: string;
  name: string | null;
  rank: number | null;
  tags: string[];
  evidence: { level: 'complete' | 'partial' | 'insufficient' | 'missing'; detail: string };
  scores: { edge: number | null; consistency: number | null; robustness: number | null; copyability: number | null; overall: number | null };
  scoreDetails: Record<'edge' | 'consistency' | 'robustness' | 'copyability' | 'overall', { label: string; detail: string }>;
  facts: { gmgnMedianPercent: number | null; copyMedianPercent: number | null; copyCapitalUsd: number | null; duneCoveragePercent: number | null; matchedRoundTrips: number; roundTripsConsidered: number; medianHoldSeconds: number | null; under15SecondsPercent: number | null };
  scrutiny: { pass: number; fail: number; insufficient: number; checks: Array<{ label: string; verdict: string; detail: string }> } | null;
  riskDetails: { available: boolean; metrics: Record<string, unknown> | null };
  liquidity: { low: number | null; medium: number | null; high: number | null } | null;
  risks: string[];
};

export type ExperimentalDecisionReport = {
  generatedAt: string;
  periodDays: 30;
  readOnly: true;
  noProviderFetch: true;
  source: 'saved SQLite evidence';
  methodology: string[];
  wallets: ExperimentalDecisionWallet[];
};

const clamp = (value: number): number => Math.max(0, Math.min(100, Math.round(value * 10) / 10));
const COPY_DELAY_REFERENCE_SECONDS = 15;
const positiveReturnScore = (value: number | null): number | null => value === null ? null : clamp(50 + value * 1.25);
const holdScore = (seconds: number | null): number | null => seconds === null ? null : clamp((seconds / COPY_DELAY_REFERENCE_SECONDS) * 25 + (seconds >= COPY_DELAY_REFERENCE_SECONDS ? 50 : 0));

const consistencyScore = (row: CopyTradeRow): number | null => {
  const periods = [...row.weeklyPerformance, ...row.monthlyPerformance].filter((period) => period.medianReturnPercent !== null);
  if (periods.length === 0) return null;
  const positive = periods.filter((period) => (period.medianReturnPercent ?? 0) > 0).length;
  return clamp((positive / periods.length) * 100);
};

const robustnessScore = (row: CopyTradeRow): number | null => {
  const share = row.profitConcentration.bestThreeSharePositiveProfitPercent;
  const withoutBest = row.profitConcentration.excludingBestToken.medianReturnPercent;
  if (share === null || withoutBest === null) return null;
  return clamp((100 - share) * 0.65 + (withoutBest >= 0 ? 35 : Math.max(0, 35 + withoutBest)));
};

const evidenceFor = (row: CopyTradeRow, simulation: CopySimulationWalletReport | undefined): ExperimentalDecisionWallet['evidence'] => {
  if (!simulation) return { level: 'missing', detail: 'No saved 30-day Dune simulation.' };
  if (row.trades < RULES.minTrades) return { level: 'insufficient', detail: `Unrankable: only ${row.trades} GMGN trades; at least ${RULES.minTrades} are required for comparison.` };
  if (simulation.roundTripsConsidered === 0) return { level: 'partial', detail: 'Saved simulation has no eligible round trips.' };
  if (simulation.roundTripsConsidered < 30) return { level: 'insufficient', detail: `Unrankable: only ${simulation.roundTripsConsidered} eligible round trips; at least 30 are required for comparison.` };
  const coverage = simulation.coverageRatePercent ?? 0;
  if (!hasReliableCopyEvidence(simulation) || row.truncated || row.historyFailed || coverage < 90) return { level: 'partial', detail: `${coverage.toFixed(1)}% of eligible round trips have usable delayed-copy evidence.` };
  return { level: 'complete', detail: `${coverage.toFixed(1)}% of eligible round trips have usable delayed-copy evidence.` };
};

export const computeExperimentalDecisionReport = (database: DatabaseSync, options: { limit?: number; rosterSnapshotId?: number } = {}): ExperimentalDecisionReport => {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 100)));
  const screen = computeCopyTradeReport(database, { periodDays: 30, traderLimit: limit, rosterSnapshotId: options.rosterSnapshotId });
  const simulation = computeCopySimulationReport(database, { walletAddresses: screen.rows.map((row) => row.walletAddress), periodDays: 30 });
  const simulationByWallet = new Map(simulation.wallets.map((wallet) => [wallet.walletAddress, wallet]));
  const liquidity = computeLiquidityImpactReport(simulation);
  const scrutinyByWallet = new Map<string, CandidateScrutinyReport>();
  try {
    const reports = computeCandidateScrutinyBatch(database, screen.rows.map((row) => row.walletAddress), {
      rowsByWallet: new Map(screen.rows.map((row) => [row.walletAddress, row])), candidateCount: screen.rows.length,
      screenedCount: screen.rows.length, scopePeriodDays: 30,
    });
    for (const report of reports) scrutinyByWallet.set(report.walletAddress, report);
  } catch {
    // The experiment remains useful when optional scrutiny data is unavailable; it must not
    // turn a read-only inspection into a failed production decision.
  }
  const riskByWallet = new Map(readGmgnRiskResults(database, screen.rows.map((row) => row.walletAddress)).map((result) => [result.walletAddress, result]));
  const wallets = screen.rows.map((row) => {
    const sim = simulationByWallet.get(row.walletAddress);
    const evidence = evidenceFor(row, sim);
    const edge = positiveReturnScore(sim?.simulatedMedianReturnPercent ?? null);
    const consistency = consistencyScore(row);
    const robustness = robustnessScore(row);
    const copyability = sim ? clamp(((sim.coverageRatePercent ?? 0) * 0.6) + (holdScore(row.riskEvidence.medianHoldSeconds) ?? 0) * 0.4) : null;
    const overall = edge !== null && consistency !== null && robustness !== null && copyability !== null && evidence.level === 'complete'
      ? clamp(edge * 0.35 + consistency * 0.25 + robustness * 0.2 + copyability * 0.2) : null;
    const positivePeriods = [...row.weeklyPerformance, ...row.monthlyPerformance].filter((period) => period.medianReturnPercent !== null);
    const positivePeriodCount = positivePeriods.filter((period) => (period.medianReturnPercent ?? 0) > 0).length;
    const coverage = sim?.coverageRatePercent ?? null;
    const holdSeconds = row.riskEvidence.medianHoldSeconds;
    const scoreDetails: ExperimentalDecisionWallet['scoreDetails'] = {
      edge: { label: 'Delayed-copy edge', detail: sim?.simulatedMedianReturnPercent === null || sim?.simulatedMedianReturnPercent === undefined ? 'Missing saved delayed-copy median return.' : `Starts at 50 and adjusts with the saved delayed-copy median return (${sim.simulatedMedianReturnPercent.toFixed(1)}%).` },
      consistency: { label: 'Consistency', detail: positivePeriods.length === 0 ? 'No saved weekly or monthly periods.' : `${positivePeriodCount} of ${positivePeriods.length} saved weekly/monthly periods were positive.` },
      robustness: { label: 'Robustness', detail: row.profitConcentration.bestThreeSharePositiveProfitPercent === null || row.profitConcentration.excludingBestToken.medianReturnPercent === null ? 'Missing profit-concentration inputs.' : `Uses best-three profit share (${row.profitConcentration.bestThreeSharePositiveProfitPercent.toFixed(1)}%) and the median return after removing the best token (${row.profitConcentration.excludingBestToken.medianReturnPercent.toFixed(1)}%).` },
      copyability: { label: 'Copyability', detail: coverage === null || holdSeconds === null ? 'Missing Dune coverage or holding-time input.' : `Combines usable Dune coverage (${coverage.toFixed(1)}%) with median holding time (${(holdSeconds / 3600).toFixed(1)}h) against the 15-second delay reference.` },
      overall: { label: 'Overall', detail: overall === null ? 'Requires all four component scores and non-missing evidence.' : 'Weighted score: edge 35%, consistency 25%, robustness 20%, copyability 20%.' },
    };
    const risks: string[] = [];
    if (evidence.level !== 'complete') risks.push(evidence.detail);
    if (row.truncated) risks.push('GMGN history is truncated.');
    if (row.historyFailed) risks.push('GMGN history fetch failed.');
    if ((row.riskEvidence.under15SecondsPercent ?? 0) > 20) risks.push(`${row.riskEvidence.under15SecondsPercent?.toFixed(1)}% of paired trades are under 15 seconds.`);
    if (robustness !== null && robustness < 50) risks.push('Profit is concentrated or weak after removing the best token.');
    const scrutiny = scrutinyByWallet.get(row.walletAddress);
    const scrutinyChecks = scrutiny ? Object.values(scrutiny.checks).map((check) => ({ label: check.label, verdict: check.verdict, detail: check.detail })) : null;
    const risk = riskByWallet.get(row.walletAddress);
    const walletLiquidity = liquidity.byWallet.find((entry) => entry.walletAddress === row.walletAddress);
    return {
      walletAddress: row.walletAddress, name: row.name, rank: row.rankHistory.currentRank, tags: row.gmgnTags ?? [], evidence,
      scores: { edge, consistency, robustness, copyability, overall },
      scoreDetails,
      facts: { gmgnMedianPercent: row.medianReturnPercent, copyMedianPercent: sim?.simulatedMedianReturnPercent ?? null, copyCapitalUsd: sim?.portfolio.endingCapitalUsd ?? null, duneCoveragePercent: sim?.coverageRatePercent ?? null, matchedRoundTrips: sim?.copiedTrades ?? 0, roundTripsConsidered: sim?.roundTripsConsidered ?? 0, medianHoldSeconds: row.riskEvidence.medianHoldSeconds, under15SecondsPercent: row.riskEvidence.under15SecondsPercent ?? null },
      scrutiny: scrutinyChecks ? { pass: scrutinyChecks.filter((check) => check.verdict === 'pass').length, fail: scrutinyChecks.filter((check) => check.verdict === 'fail').length, insufficient: scrutinyChecks.filter((check) => check.verdict === 'insufficient').length, checks: scrutinyChecks } : null,
      riskDetails: { available: risk?.available === true, metrics: risk?.metrics && typeof risk.metrics === 'object' ? risk.metrics as Record<string, unknown> : null },
      liquidity: walletLiquidity ? { low: walletLiquidity.bands.find((band) => band.band === 'low')?.medianSimulatedReturnPercent ?? null, medium: walletLiquidity.bands.find((band) => band.band === 'medium')?.medianSimulatedReturnPercent ?? null, high: walletLiquidity.bands.find((band) => band.band === 'high')?.medianSimulatedReturnPercent ?? null } : null,
      risks,
    };
  });
  return {
    generatedAt: new Date().toISOString(), periodDays: 30, readOnly: true, noProviderFetch: true, source: 'saved SQLite evidence',
    methodology: ['30-day saved GMGN report plus saved Dune delayed-copy simulation.', `Overall scores require at least ${RULES.minTrades} GMGN trades, 30 eligible round trips, reliable coverage, and complete cost evidence; thinner samples are unrankable.`, 'Scores are exploratory, capped at 0–100, and missing inputs stay null.', 'This tab does not replace or modify the production decision engine.'],
    wallets,
  };
};
