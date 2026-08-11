# Research question contract v2 (prospective)

**ID:** `solana-gmgn-early-winner-v2`  
**Status:** `PROPOSED — review required before outcome analysis`  
**Supersedes:** collection-comparison rules in [research-question.md](research-question.md) only for data collected after the approved boundary; V1 remains immutable historical documentation.

## Why this version exists

The live GMGN sources do not provide reliable historical backfill. Therefore, an older token cannot be classified as having “no GMGN signal” merely because this collector had not started yet. This version defines a prospective population whose GMGN exposure window is actually observable.

## Primary question

Among eligible Solana cohort tokens first observed after the approved collector boundary, is receiving an eligible GMGN signal before the outcome cutoff associated with a higher probability of meeting the preregistered early-winner outcome than comparable tokens whose monitored exposure window contains no eligible signal?

## Required boundary and observation rules

- **Collector boundary:** `collector_start_at` must be recorded as an explicit UTC timestamp after a reviewed pilot. It must not be inferred from the oldest signal row.
- **Population:** tokens whose first-trade/first-observed timestamp is on or after `collector_start_at`, using the approved cohort source and exact source timestamp.
- **Observable exposure:** a token is eligible for comparison only when its relevant monitoring window is covered by successful, timestamped collection evidence. Browser uploads alone do not prove continuous coverage.
- **Comparator:** tokens with a verified exposure window and no eligible signal during that observed window. “No signal row” is not sufficient when coverage is unknown or begins after the token’s exposure window.
- **Time standard:** all collector boundaries, event times, windows, and gaps use UTC ISO 8601 timestamps.

## Preregistered defaults (reviewable before analysis)

- **Early-winner outcome:** maximum observed market cap reaches at least 5x the first-trade market-cap reference within 7 calendar days of first trade.
- **Eligible-signal cutoff:** signal is observed before the token reaches 10x the first-trade market-cap reference.
- **Unit:** one token; all signal observations remain event-level records.
- **Signal source precedence:** preserve and report `gmgn-cli` and `gmgn-browser-extension` separately; never silently merge provenance.

These values are defaults, not analysis results. Any change requires a new contract version and preregistration.

## Required exclusions and missingness policy

- Exclude from outcome comparisons tokens without a usable first-trade reference, a verified exposure window, or the required outcome observations; retain their raw records and exclusion reason.
- Treat malformed, unmatched, duplicate, and gap-affected records as retained evidence with explicit status—not silent deletion.
- Record liquidity, honeypot, mint-authority, blacklist, and rug-pull checks as separate future observation fields. Do not infer a risk status from missing data.
- Do not treat query-time market cap, ATH, or current-data fields as trigger-time facts without an explicit source timestamp.

## Approval gate

Before any return, winner-label, or signal-effectiveness code is written, a reviewer must approve this contract after the Signal Integrity Report demonstrates: explicit collector boundary, verified exposure windows, documented gaps, no secret leakage, archive provenance, and adequate coverage of signal types 14–16.

## Out of scope

This contract does not implement return calculations, scoring, ranking, alerts, trading, optimization, or causal claims. Those require a separately approved analysis package.
