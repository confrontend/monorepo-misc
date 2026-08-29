# Feature Specification: GMGN-only Decision Engine

## Goal

Make Decision Lab and Live Evaluation depend only on saved GMGN wallet history and promoted
Pattern Discovery rules. Restrict Dune usage to Pattern Research and remove Wallet Data as a
standalone tab.

## Invariants

- Preserve the four Decision Lab groups and validated adaptive weights.
- Use only information available before the decision timestamp.
- Pattern Discovery may use Dune to discover and validate rules; applying promoted rules must use
  historical GMGN features only.
- Dune simulation may remain informational, but its coverage, portfolio, and stability values must
  not determine ranking or candidacy.
- Live Evaluation remains read-only and its history contract remains unchanged.

## Acceptance criteria

1. Decision Lab edge uses GMGN realized median return.
2. Decision Lab copyability uses GMGN holding time and promoted GMGN penalties, without a Dune
   coverage term.
3. Evidence sufficiency requires the minimum GMGN trade count and four non-null GMGN component
   scores; it does not require Dune evidence.
4. Candidacy uses the GMGN-only verdict rule: complete evidence and raw score at least 50.
5. Dune simulation can be displayed as optional diagnostics but cannot block or improve eligibility.
6. Wallet Data is removed from navigation; roster import and GMGN refresh controls are available
   from Decision Lab, while Dune refresh controls are available from Pattern Research.
7. Pattern Research shows the age of the last completed discovery run and warns when stale.
8. Build, tests, architecture checks, and browser smoke checks pass.
