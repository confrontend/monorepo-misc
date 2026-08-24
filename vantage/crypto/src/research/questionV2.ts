export const RESEARCH_QUESTION_V2_ID = 'solana-gmgn-early-winner-v2';
export const RESEARCH_QUESTION_V2_VERSION = 2 as const;

export const RESEARCH_QUESTION_V2 = {
  id: RESEARCH_QUESTION_V2_ID,
  version: RESEARCH_QUESTION_V2_VERSION,
  status: 'PROPOSED' as const,
  title: 'Prospectively observed GMGN signals and early-winning Solana tokens',
  collectorStartAt: null as string | null,
  primary:
    'Among eligible Solana cohort tokens first observed after the approved collector boundary, is an eligible GMGN signal associated with the preregistered early-winner outcome compared with tokens whose monitored exposure window contains no eligible signal?',
  population:
    'Cohort tokens first observed on or after an explicitly approved UTC collector_start_at.',
  observableExposure:
    'Only tokens with a verified successful collection window covering the relevant exposure period are eligible for comparison.',
  comparator:
    'Tokens with a verified exposure window and no eligible signal during that observed window; absence of a database row alone is never sufficient.',
  earlyWinnerMultiple: 5,
  outcomeWindowDays: 7,
  signalCutoffMultiple: 10,
  requiredCoverage: [
    'explicit collector boundary',
    'verified exposure windows',
    'documented gaps',
    'signal types 14–16 coverage',
    'archive provenance',
    'no secret leakage',
  ],
  exclusions: [
    'unknown exposure coverage',
    'missing first-trade reference',
    'missing required outcome observations',
  ],
  forbiddenInThisPhase: [
    'returns',
    'winner labels',
    'scoring',
    'ranking',
    'alerts',
    'trading',
    'strategy optimization',
  ],
} as const;

export const isApprovedResearchQuestionV2 = (value: {
  status: string;
  collectorStartAt: string | null;
}): boolean =>
  value.status === 'APPROVED' &&
  typeof value.collectorStartAt === 'string' &&
  value.collectorStartAt.endsWith('Z');
