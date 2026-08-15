# Premature-query indexing-lag audit

## Finding

The risk was reproduced against the stored research database. We identified 774 completed Dune runs with 483 runs that queried at least one signal less than six hours after capture, covering 11,872 signal/checkpoint rows. A read-only re-execution of the exact SQL stored for run 1 was then compared with its archived result: 25 signals, 125 checkpoints, and 100 changed rows (80%). The changes included materially different prices and newly available historical rows, so the effect is not merely theoretical.

The pilot did not modify SQLite, archived files, or any stored Dune run. The historical comparison was deliberately performed as a separate read-only execution. The pilot sample did not expose transaction IDs for the changed rows, so it demonstrates changed indexed results but cannot attribute every change to a particular trade.

## Implemented protection

`src/dune/outcomes.ts` now keeps the raw Dune response immutable but marks an interpreted checkpoint as `premature query — needs re-verification` when its run was requested before the signal had reached the existing 24-hour observation buffer. Its price and trade provenance are withheld from the interpreted outcome until a later valid measurement is available. A later post-buffer `received` checkpoint replaces the provisional interpretation through the existing append-only merge path.

This is intentionally conservative: it does not guess whether a changed result is caused by indexing delay, venue coverage, or a data correction. It prevents an early `received` value from silently entering Patterns as fresh evidence. The existing planner can therefore treat the interpreted checkpoint as unresolved and schedule a later measurement according to its normal retry policy; no new automatic polling loop was added.

## Evidence and provenance

- Raw `raw_result`, query SQL, execution metadata, archive, and hashes remain unchanged.
- The interpreted view carries the run ID and matched-trade provenance when a checkpoint is accepted.
- A stable tie-break (`block_time`, transaction ID, outer index, inner index) remains in the Dune query so same-second trades are selected deterministically.
- A regression test verifies that premature interpretation hides the price/trade fields while preserving the raw response.

## Scope and limitations

This change does not alter the 24-hour prescreen policy, retry delays, scoring, returns, or verdict thresholds. It only prevents premature historical observations from being treated as verified. The initial re-query was one representative 25-signal pilot; future audits may expand the sample and quantify which Pattern groups change after re-verification.
