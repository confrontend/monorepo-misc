export const RESEARCH_QUESTION_ID = 'solana-gmgn-early-winner-v1';

export const RESEARCH_QUESTION = {
  id: RESEARCH_QUESTION_ID,
  title: 'Do GMGN signals identify early-winning Solana tokens?',
  primary:
    'Among tokens in the historical Solana cohort, does receiving a GMGN signal before the token reaches 10x its first-trade market-cap reference increase the probability of becoming an early winner compared with otherwise eligible cohort tokens without that signal?',
  earlyWinnerDefinition:
    'A token is an early winner when its maximum observed market cap reaches at least 5x its first-trade market-cap reference within 7 calendar days of first trade.',
  exposureDefinition:
    'The exposure is the first observed GMGN signal per token and signal type, with observed_at, signal_type, market_cap, triggering_wallet, and raw_wallet_labels preserved.',
  comparisonDefinition:
    'Compare each qualifying signaled token with cohort tokens eligible in the same calendar period and initial market-cap bucket that have no qualifying GMGN signal before the outcome window closes.',
  population: 'Solana token rows imported from the versioned Dune historical cohort export.',
  unitOfAnalysis: 'One token, with signal observations retained as a separate event-level table.',
  requiredCollection: [
    'Exact token address and first-trade timestamp from the Dune cohort.',
    'Every captured GMGN event, including unmatched events and complete raw payloads.',
    'UTC observed_at and captured_at timestamps.',
    'Signal type, trigger market cap, triggering wallet, and raw wallet labels when supplied.',
    'Immutable source file hashes and ZIP archive provenance.',
  ],
  exclusions: [
    'Do not delete or overwrite malformed, unmatched, or duplicate observations.',
    'Do not infer a signal from a token page, price movement, or wallet trade unless the source labels it as a GMGN event.',
    'Do not calculate scores, returns, alerts, or strategy performance in V1 capture.',
  ],
} as const;
