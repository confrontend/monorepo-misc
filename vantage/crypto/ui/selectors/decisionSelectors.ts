// Shared derived-state helpers for the copy-trade decision UI. These exist so the same
// wallet-level decision concept (Dune fetch progress, usable coverage, why a wallet still
// needs evidence) is computed once and cannot silently drift into subtly different wording
// or logic at different call sites — see progress.md for the concrete bug history this fixes.

type DuneSimTargets = {
  pendingDuneTargets?: number;
  duneNoMatchTargets?: number;
  duneMatchedTargets?: number;
};

type DuneSimCoverage = {
  copiedTrades: number;
  roundTripsConsidered: number;
};

/**
 * Percentage of a wallet's current Dune trade legs that have already been queried (matched or
 * confirmed no-match), regardless of whether the query produced a usable price. This is
 * operational fetch progress only — it is not a measure of decision confidence. Canonical
 * implementation moved from the activity-table row logic in ui/main.tsx, which was the only
 * remaining place this was computed.
 */
export function computeDuneQueriedPercent(sim: DuneSimTargets | null | undefined): number | null {
  if (!sim) return null;
  const total =
    (sim.pendingDuneTargets ?? 0) + (sim.duneNoMatchTargets ?? 0) + (sim.duneMatchedTargets ?? 0);
  if (total <= 0) return null;
  return Math.round(
    (((sim.duneNoMatchTargets ?? 0) + (sim.duneMatchedTargets ?? 0)) / total) * 100,
  );
}

/**
 * Human-readable sentence describing Dune fetch progress (queried vs. total current legs).
 * Deliberately separate from usable-coverage text below: fetch progress and decision
 * confidence are different concepts and must not be worded as if they were the same thing.
 */
export function buildDuneFetchProgressText(duneQueriedPercent: number | null): string {
  if (duneQueriedPercent === null) return 'Dune fetch progress is not available.';
  return `Dune fetch status: ${duneQueriedPercent}% of current trade legs queried; ${
    duneQueriedPercent >= 100
      ? 'all current trade legs were already queried, so another normal fetch cannot add unqueried Dune data.'
      : 'unqueried Dune legs may still be fetchable.'
  }`;
}

/**
 * Human-readable sentence describing usable Dune coverage (copied trades over eligible round
 * trips) with its numerator/denominator. Canonical version keeps one decimal place and shows
 * the fraction, matching the main decision table's "decision" and "Dune coverage" column
 * tooltips, which agreed with each other; the "Evidence" column tooltip had independently
 * drifted to a whole-number percentage with no fraction shown — that call site is migrated to
 * this shared text as part of this change (see decisionSelectors usage in ui/main.tsx).
 */
export function buildUsableCoverageText(
  coverage: number | null | undefined,
  sim: DuneSimCoverage | null | undefined,
): string {
  if (coverage === null || coverage === undefined) return 'Dune usable coverage is not available.';
  return `Dune usable coverage is ${coverage.toFixed(1)}% (${sim?.copiedTrades ?? 0} matched of ${sim?.roundTripsConsidered ?? 0} eligible round trips).`;
}

/**
 * Full "why does this wallet still need more decision evidence" tooltip text: the wallet's own
 * decision reasons, plus usable-coverage and Dune-fetch-progress context. Canonical
 * implementation moved from the activity-table row logic in ui/main.tsx.
 */
export function buildEvidenceReason(params: {
  needsMoreEvidence: boolean;
  decisionReasons: string[] | null | undefined;
  coverage: number | null | undefined;
  sim: (DuneSimTargets & DuneSimCoverage) | null | undefined;
}): string {
  if (!params.needsMoreEvidence)
    return 'This wallet does not currently need more decision evidence.';
  const reasonsText =
    params.decisionReasons && params.decisionReasons.length > 0
      ? params.decisionReasons.join('\n')
      : 'Required decision evidence is incomplete.';
  const coverageText = buildUsableCoverageText(params.coverage, params.sim);
  const queryText = buildDuneFetchProgressText(computeDuneQueriedPercent(params.sim));
  return `${reasonsText}\n\n${coverageText}\n${queryText}`;
}
