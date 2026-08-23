export const COMPARISON_PRIMARY_HORIZON = '+1d';
export const COMPARISON_MIN_SAMPLE_SIZE = 30;
export const COMPARISON_COST_SCENARIO = '25' as const;

export type ComparisonRuleOutcome = {
  horizon: string;
  sampleSize: number;
  averageExcessPct: number | null;
  afterCostsPct: Record<'10' | '25' | '50', number | null>;
  status: 'insufficient' | 'descriptive' | 'unavailable';
};

export type ComparisonRuleSignal = {
  signalId: string;
  label: string;
  outcomes: readonly ComparisonRuleOutcome[];
};

export type ComparisonLeader = {
  status: 'candidate' | 'early' | 'none';
  horizon: string;
  signalId: string | null;
  label: string | null;
  afterCostsPct: number | null;
  message: string;
};

export type ComparisonWarningInput = {
  coverageStatus: string;
  rawEvents: number;
  tickers: number;
  primaryOutcome: Pick<ComparisonRuleOutcome, 'sampleSize' | 'status' | 'afterCostsPct'>;
};

/**
 * Returns explicit evidence-quality warnings. These are intentionally warnings,
 * not profitability conclusions: a signal can be a candidate while still
 * requiring broader coverage and out-of-sample validation.
 */
export const comparisonWarnings = (input: ComparisonWarningInput): string[] => {
  const warnings: string[] = [];
  if (input.coverageStatus !== 'ready') warnings.push(`Source coverage is ${input.coverageStatus}; this signal is not fully validated.`);
  if (input.rawEvents < COMPARISON_MIN_SAMPLE_SIZE) warnings.push(`Fewer than ${COMPARISON_MIN_SAMPLE_SIZE} raw events are available.`);
  if (input.rawEvents > 0 && input.tickers < 10) warnings.push('Fewer than 10 distinct tickers are represented.');
  if (input.primaryOutcome.status === 'unavailable') warnings.push('No usable +1d outcome is available.');
  else if (input.primaryOutcome.status === 'insufficient') warnings.push(`Fewer than ${COMPARISON_MIN_SAMPLE_SIZE} usable +1d outcomes are available.`);
  if (input.primaryOutcome.afterCostsPct[COMPARISON_COST_SCENARIO] === null && input.primaryOutcome.sampleSize > 0) warnings.push('The 25 bps/side cost-adjusted result is unavailable.');
  warnings.push('Any leader remains a candidate only; out-of-sample validation is required.');
  return warnings;
};

const hasMinimumEvidence = (outcome: ComparisonRuleOutcome) =>
  outcome.status === 'descriptive'
  && outcome.sampleSize >= COMPARISON_MIN_SAMPLE_SIZE
  && outcome.afterCostsPct[COMPARISON_COST_SCENARIO] !== null
  && outcome.afterCostsPct[COMPARISON_COST_SCENARIO] >= 0;

/**
 * Applies the preregistered evidence gate shared by SQLite and PostgreSQL reads.
 * A candidate must be a non-negative, cost-adjusted +1d result. If that gate is
 * not met, only a shorter-horizon descriptive result with benchmark excess data
 * may be shown as an early leader.
 */
export const selectComparisonLeader = (signals: readonly ComparisonRuleSignal[]): ComparisonLeader => {
  const matureCandidates = signals.flatMap((row) => {
    const outcome = row.outcomes.find((entry) => entry.horizon === COMPARISON_PRIMARY_HORIZON);
    return outcome && hasMinimumEvidence(outcome) ? [{ row, outcome }] : [];
  }).sort((a, b) => (b.outcome.afterCostsPct[COMPARISON_COST_SCENARIO] as number)
    - (a.outcome.afterCostsPct[COMPARISON_COST_SCENARIO] as number));

  const earlyCandidates = signals.flatMap((row) => row.outcomes
    .filter((outcome) => outcome.horizon !== COMPARISON_PRIMARY_HORIZON
      && hasMinimumEvidence(outcome)
      && outcome.averageExcessPct !== null)
    .map((outcome) => ({ row, outcome })))
    .sort((a, b) => (b.outcome.averageExcessPct as number) - (a.outcome.averageExcessPct as number));

  if (matureCandidates.length > 0) {
    const { row, outcome } = matureCandidates[0];
    return {
      status: 'candidate',
      horizon: COMPARISON_PRIMARY_HORIZON,
      signalId: row.signalId,
      label: row.label,
      afterCostsPct: outcome.afterCostsPct[COMPARISON_COST_SCENARIO],
      message: 'Best-supported +1d result after estimated costs; still requires out-of-sample validation.',
    };
  }

  if (earlyCandidates.length > 0) {
    const { row, outcome } = earlyCandidates[0];
    return {
      status: 'early',
      horizon: outcome.horizon,
      signalId: row.signalId,
      label: row.label,
      afterCostsPct: outcome.afterCostsPct[COMPARISON_COST_SCENARIO],
      message: 'Early descriptive leader only; +1d evidence is not mature yet.',
    };
  }

  return {
    status: 'none',
    horizon: COMPARISON_PRIMARY_HORIZON,
    signalId: null,
    label: null,
    afterCostsPct: null,
    message: 'No reliable leader yet: no signal has enough mature, usable +1d observations.',
  };
};
