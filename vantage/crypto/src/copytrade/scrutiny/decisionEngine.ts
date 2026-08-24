/**
 * The single final 30-day table decision.
 *
 * This is deliberately pure: it only classifies already-collected evidence. Fetching and
 * Dune-budget triage belong elsewhere and must not silently change this formula.
 */
export type ThirtyDayDecision =
  | 'Tested candidate'
  | 'Watch'
  | 'Needs data'
  | 'Historical / stale'
  | 'Not copyable'
  | 'Historical screen failed';

export type ThirtyDayDecisionEvidence = {
  historyIncomplete: boolean;
  impossibleToCopy: boolean;
  hasGmgn30dStats: boolean;
  enoughDuneEvidence: boolean;
  gmgnStatsFresh: boolean;
  duneEvidenceFresh: boolean;
  gmgn30dPositive: boolean;
  delayedCopySurvived: boolean;
  delayedCopyMedianPositive: boolean;
  consistentlyProfitable: boolean;
  consistencyDataMissing: boolean;
};

export type ThirtyDayDecisionDetails = ThirtyDayDecisionEvidence & {
  historicalConsistency?: 'consistent' | 'inconsistent' | 'insufficient' | null;
  noLosingWeek?: boolean;
  measuredWeeks?: number;
  minimumMeasuredWeeks?: number;
};

/** Both required 30-day evidence sources use the same freshness window. */
export const THIRTY_DAY_DECISION_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export const isThirtyDayDecisionEvidenceFresh = (
  fetchedAt: string | null | undefined,
  now = Date.now(),
): boolean => {
  if (!fetchedAt) return false;
  const age = now - Date.parse(fetchedAt);
  return Number.isFinite(age) && age >= 0 && age <= THIRTY_DAY_DECISION_FRESHNESS_MS;
};

export const decideThirtyDayVerdict = (evidence: ThirtyDayDecisionEvidence): ThirtyDayDecision => {
  if (evidence.historyIncomplete) return 'Needs data';
  if (evidence.impossibleToCopy) return 'Not copyable';
  if (!evidence.hasGmgn30dStats || !evidence.enoughDuneEvidence) return 'Needs data';
  if (!evidence.gmgnStatsFresh || !evidence.duneEvidenceFresh) return 'Historical / stale';
  if (
    evidence.delayedCopySurvived &&
    evidence.gmgn30dPositive &&
    evidence.delayedCopyMedianPositive &&
    evidence.consistencyDataMissing
  )
    return 'Needs data';
  if (evidence.delayedCopySurvived && evidence.gmgn30dPositive && evidence.consistentlyProfitable)
    return 'Tested candidate';
  if (evidence.gmgn30dPositive) return 'Watch';
  return 'Historical screen failed';
};

export const thirtyDayDecisionPriority = (verdict: ThirtyDayDecision): number => {
  if (verdict === 'Tested candidate') return 0;
  if (verdict === 'Watch') return 1;
  if (verdict === 'Needs data') return 2;
  if (verdict === 'Historical / stale') return 3;
  return 4;
};

/** Explains the exact final gate(s) that kept this row from becoming a candidate. */
export const explainThirtyDayDecision = (evidence: ThirtyDayDecisionDetails): string[] => {
  const verdict = decideThirtyDayVerdict(evidence);
  if (verdict === 'Watch') {
    const reasons: string[] = [];
    if (!evidence.delayedCopySurvived)
      reasons.push(
        'The delayed-copy portfolio was not positive after delay, fees, slippage, and gas.',
      );
    if (!evidence.delayedCopyMedianPositive)
      reasons.push('The median copied trade was not positive.');
    if (evidence.historicalConsistency === 'inconsistent')
      reasons.push('The earlier and recent parts of the 30-day history were not both positive.');
    if (evidence.historicalConsistency === 'insufficient')
      reasons.push('Historical consistency could not be established from enough data.');
    if (evidence.noLosingWeek === false) {
      const measured = evidence.measuredWeeks ?? 0;
      const minimum = evidence.minimumMeasuredWeeks ?? 0;
      reasons.push(
        measured < minimum
          ? `Only ${measured} measured week${measured === 1 ? '' : 's'} were available; ${minimum} are required.`
          : 'At least one measured week was not positive.',
      );
    }
    return reasons.length > 0
      ? reasons
      : ['It passed the base data gates but did not pass the final consistency gates.'];
  }
  if (verdict === 'Needs data') {
    const reasons: string[] = [];
    if (evidence.historyIncomplete)
      reasons.push('The requested GMGN history window is incomplete.');
    if (!evidence.hasGmgn30dStats) reasons.push('The 30-day GMGN statistic is missing.');
    if (!evidence.enoughDuneEvidence) reasons.push('The 30-day Dune evidence gate is incomplete.');
    if (evidence.consistencyDataMissing)
      reasons.push('Historical consistency has not finished loading.');
    return reasons.length > 0 ? reasons : ['Required evidence is incomplete.'];
  }
  if (verdict === 'Historical / stale')
    return ['GMGN or Dune evidence is older than the current freshness window.'];
  if (verdict === 'Not copyable')
    return ['The typical holding time is shorter than the configured copy delay.'];
  if (verdict === 'Historical screen failed') return ['The 30-day GMGN result is not positive.'];
  return ['This row passed the current decision gates.'];
};
