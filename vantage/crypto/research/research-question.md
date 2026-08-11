# Research question contract

**ID:** `solana-gmgn-early-winner-v1`

**Status:** Collection contract; the comparator is provisional pending approval of the live GMGN source plan in [docs/GMGN_CAPTURE_NEXT_STEP_REVIEW.md](../docs/GMGN_CAPTURE_NEXT_STEP_REVIEW.md).

## Primary question

Among tokens in the historical Solana cohort, does receiving a GMGN signal before the token reaches 10x its first-trade market-cap reference increase the probability of becoming an early winner compared with otherwise eligible cohort tokens without that signal?

## Operational definitions

- **Population:** Solana token rows imported from the versioned Dune historical cohort export.
- **Unit of analysis:** One token. GMGN observations remain event-level rows and are never collapsed into the token row.
- **Exposure:** The first observed GMGN signal per token and signal type. Preserve every later signal too; the first-event designation belongs to a future analysis view, not ingestion.
- **Early winner:** A token whose maximum observed market cap reaches at least **5x** its first-trade market-cap reference within **7 calendar days** of first trade.
- **Exposure cutoff:** A signal is an eligible early signal only if it is observed before the token reaches **10x** its first-trade market-cap reference.
- **Comparator:** Cohort tokens eligible in the same calendar period and initial market-cap bucket that have no eligible GMGN signal before the outcome window closes.

This comparator is not valid for tokens whose potential GMGN exposure predates the collector start time. If the live-only source plan is approved, this contract must be versioned (for example, `solana-gmgn-early-winner-v2`) with a prospective comparator before any outcome analysis begins. The current V1 definition must not be silently reused or silently rewritten.

The 5x, 10x, and 7-day values are the V1 research defaults. They must be versioned and preregistered before any outcome analysis changes them. V1 does not calculate these outcomes; it stores the timestamps, addresses, source payloads, and provenance required to calculate them later.

## What the collector must preserve

1. Exact Dune `token_address` and `first_trade_time` source values.
2. Every GMGN event, including events whose token is not yet in the cohort.
3. UTC `observed_at` and local capture `captured_at`.
4. `signal_type`, trigger market cap, triggering wallet, raw wallet labels, source URL when available, and complete raw payload.
5. Source hashes, import counts, validation issues, and ZIP archive provenance.

## Explicit exclusions

The collection system must not score signals, calculate returns, issue alerts, trade, optimize a strategy, or silently discard malformed/unmatched records. Those belong to a separately versioned analysis phase.
