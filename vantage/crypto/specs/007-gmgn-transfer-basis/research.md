# Research: GMGN transfer-in accounting

## Decision

Use a shared chronological inventory resolver. `buy` creates known-cost inventory; incoming transfer events create unknown-cost inventory. Sells consume inventory in time order and split when needed. Any quantity sourced from unknown inventory is excluded from realized profitability and reported as uncertain.

## Rationale

The current evaluator trusts a positive sell-level `buy_cost_usd` without checking for a preceding buy row. Dune pairing is stricter, so a shared resolver is needed to keep local and delayed-copy results consistent. A conservative unknown-basis result is safer than assuming bought inventory was sold first.

## Alternatives considered

- Trust `buy_cost_usd`: rejected because it can create a profitable sell with no locally proven purchase.
- Treat transfers as buys at zero cost: rejected because it creates artificial profit.
- Always match bought lots before transfer lots: rejected because it can make transfer-contaminated positions look clean.
- Ignore transfer events entirely: rejected because the production screen would not know the position is uncertain.
