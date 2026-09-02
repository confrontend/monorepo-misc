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

## Amendment: authoritative-only Decision Lab

The Decision Lab exposes only the fixed `winner-policy-v2` evaluation. The experimental
Discovered Rules mode, its selector, request parameter, response mode fields, and adaptation
helpers are removed from the Decision Engine surface. Pattern Discovery remains available as
research input for analytical context, but it cannot be selected as an alternate Winner Policy.

Additional acceptance criteria:

9. Decision Lab has no Discovered Rules selector or mode-dependent loading path.
10. The Decision Lab endpoint accepts no `winnerPolicyMode` parameter and always returns the
    authoritative Winner Policy result.
11. Shared Winner Policy results no longer carry an experimental mode branch; existing
    authoritative gates and scores remain unchanged.
12. Tests, API documentation, and persisted-report adaptation code contain no active
    Discovered Rules Decision Engine path.

## Amendment: Winner Policy v2.1 wallet maturity risk

Winner Policy v2.1 preserves the v2 hard gates and Dune profitability calculation. It adds a
bounded GMGN wallet-age deduction (maximum 5 points) using the provider's `common.created_at`
value persisted as `copytrade_wallet_stats.created_at_ts`. Age is calculated point-in-time relative
to the evaluation timestamp and compared with the selected Decision Lab period.

13. `created_at_ts` provenance is verified as provider wallet-age context before scoring.
14. Wallet maturity deducts 5 points below 7 days, 4 points below half the selected period, 2
    points below the selected period, and 0 points at or above the selected period; missing age
    is neutral.
15. Decision Lab and Live Evaluation pass point-in-time wallet age into the same shared policy;
    the three hard gates and 70-point Dune profitability calculation remain unchanged.

## Amendment: Winner Policy v3 all-history recency model

Winner Policy v3 provides one operational winner view shared by Decision Lab and Live Evaluation.
All valid historical evidence is included; metrics that support recency weighting use a centralized
45-day exponential half-life. The 20 completed copied-buy gate remains the actual unweighted count,
and the canonical chronological $100 portfolio gate remains unweighted and must end above $100.
The delayed-copy median gate and profitability score use a robust recency-weighted median. GMGN risk
signals use the same decay where historical observations are available. Fixed 30/60/90-day scopes
remain diagnostic/research inputs only and do not create competing winner views.
