import type { ThirtyDayDecision } from '../src/copytrade/scrutiny/decisionEngine.js';

export type DecisionState = 'passed' | 'watch' | 'rejected' | 'needs_data' | 'stale';

export const DECISION_STATES: Record<
  DecisionState,
  { label: string; tone: string; blurb: string }
> = {
  passed: {
    label: 'Consistently profitable (30d)',
    tone: 'pass',
    blurb:
      'Positive typical copied trade, positive in every measured week, and no decline between earlier and recent history.',
  },
  watch: {
    label: 'Watch',
    tone: 'watch',
    blurb:
      'Historically positive overall, but not consistently: it fails a final copy or consistency gate.',
  },
  rejected: {
    label: 'Rejected',
    tone: 'fail',
    blurb: 'Failed a check on evidence good enough to trust.',
  },
  needs_data: {
    label: 'Needs more evidence',
    tone: 'pending',
    blurb: 'Required evidence is missing or insufficient. Another fetch may or may not resolve it.',
  },
  stale: {
    label: 'Stale evidence',
    tone: 'warning',
    blurb:
      'Evidence exists, but GMGN stats or Dune evidence is older than 24 hours. Refresh it before trusting the verdict.',
  },
};

export const DECISION_ORDER: DecisionState[] = [
  'passed',
  'watch',
  'rejected',
  'needs_data',
  'stale',
];

export const decisionStateFor = (verdict: ThirtyDayDecision | string): DecisionState => {
  if (verdict === 'Tested candidate') return 'passed';
  if (verdict === 'Watch') return 'watch';
  if (verdict === 'Historical / stale') return 'stale';
  if (verdict === 'Needs data') return 'needs_data';
  return 'rejected';
};
