# Top Callers research proposal

Status: **Proposed — review before implementation**

## Decision requested

Approve a separate **Top Callers** submenu under CopyTrade. Top Callers should be treated as a distinct GMGN source, not mixed into the existing wallet-rank winner score.

## Why this is worth testing

The GMGN TopCallers view ranks wallets by call history rather than by the ordinary wallet leaderboard. It exposes measures such as average multiplier, number of calls, number of calls reaching 2×, rank movement, and the tokens associated with those calls. These could identify a different kind of early signal, but they must be verified against timestamped market outcomes before being used as a selection rule.

## Evidence in the supplied investigation export

Source file:

`C:\Users\hamed\Downloads\gmgn-investigation-2026-08-17T03-58-44-971Z.json`

The export contains three responses from:

`/api/v1/notification/callout/rank`

Each response contains a `data.list` with **30 callers**. The observed fields include:

`rank`, `wallet`, `avg_multiplier`, `total_calls`, `hit_2x_count`, `top_tokens`, `prev_rank`, `tier`, and follower metadata.

This proves that the browser capture contains TopCallers data. It does **not** yet prove that the same caller or token appears consistently across snapshots, or that the reported multiples can be reproduced from historical prices.

## Current application behavior

The application currently preserves this endpoint inside the investigation JSON archive, but does not normalize `/api/v1/notification/callout/rank` into the database. It is therefore not included in CopyTrade historical consistency, winner selection, forward validation, or copy simulation.

The existing wallet-rank and wallet-activity pipelines remain unchanged by this proposal.

## Proposed UI

Add a CopyTrade submenu named **Top Callers** with three areas:

1. **Snapshots** — capture time, GMGN period/filter, number of callers, and source archive.
2. **Caller history** — rank, wallet, calls, hit-2× rate, average multiplier, and snapshot-to-snapshot rank movement.
3. **Historical verification** — outcomes for calls that can be matched to a token and timestamp.

Every row should show data status explicitly: verified, partially matched, pending, or insufficient data.

## Proposed storage

Use append-only records:

- `top_caller_snapshots`: capture time, source URL, request parameters, raw payload, archive/hash reference.
- `top_caller_rows`: snapshot ID, wallet, rank, average multiplier, total calls, hit-2× count, token list, and raw row.
- `top_caller_call_outcomes`: only after a call-level timestamp/token representation is available; store target timestamps, Dune matched trade IDs/times, prices, and outcome status.

Do not overwrite a later snapshot over an earlier one.

## Verification and backtest method

For each TopCaller row that includes a token and call timestamp:

1. Freeze the caller snapshot time and all source filters.
2. Match the call to a token address and observed call time.
3. Query Dune only after the configured maturity buffer.
4. Record price at the call and at fixed checkpoints such as +10m, +30m, +1h, +3h, +1d, and +7d.
5. Keep unmatched, stale, and not-yet-matured calls as explicit states; never treat them as zero return.
6. Compare reported GMGN multiplier with independently measured Dune return.
7. Report coverage, median return, win rate, capture-date count, and mismatch rate.

The historical report answers whether TopCallers' past calls were followed by favorable outcomes. A separate prospective report is required before claiming that the ranking predicts future calls.

## Acceptance gates

Do not use TopCallers in the existing winner gate until:

- at least three independently captured snapshots exist;
- caller and token identifiers are parsed without relying on display names;
- call timestamps are available for a documented fraction of rows;
- GMGN multiplier and Dune-derived return agree within a documented tolerance on matched examples;
- coverage and missingness are shown separately from performance;
- raw payloads, filters, timestamps, and archive hashes remain reproducible.

## Explicitly out of scope

- trading or copy execution;
- alerts;
- replacing the current wallet-rank winner logic;
- treating `avg_multiplier` or `hit_2x_count` as proof of profitability;
- silently imputing missing prices, liquidity, or call timestamps.

## Review questions

1. Should TopCallers be evaluated per call, per wallet, or both?
2. What minimum call-level timestamp coverage is acceptable for a backtest?
3. Which maturity buffer should be preregistered before Dune requests begin?
4. Should TopCallers remain descriptive until prospective evidence exists, even if historical results look strong?
