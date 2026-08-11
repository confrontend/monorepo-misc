# Future implementation plan: review before build

**Date:** 2026-08-11  
**Status:** Proposed; no item below is approved for implementation by this document  
**Scope:** trustworthy local collection for the Solana/GMGN research dataset

**Related governance:** [GMGN capture review](GMGN_CAPTURE_NEXT_STEP_REVIEW.md) · [current research-question contract](../research/research-question.md)

## Current baseline

The application can import and archive Dune cohorts, connect to the official project-local GMGN CLI, perform a one-off Solana signal capture, store returned events append-only, and archive the raw response as a ZIP. A successful empty response (`[]`) is preserved as valid evidence that the feed was empty at that time.

## Decision requested

Approve the phased collection roadmap below. Each phase has an acceptance gate; later phases must not be started merely because an earlier one compiles.

## Phase 1 — Harden the one-off GMGN capture

**Purpose:** make a single capture fully auditable before unattended collection.

- Preserve source-native fields separately: `source`, `source_event_id`, `chain`, `trigger_at`, `trigger_mc`, `first_trigger_mc`, `signal_times`, `signal_times_by_type`, query-time market-cap fields, and the raw event.
- Map documented GMGN `trigger_at` to UTC `observed_at`; do not treat query-time `market_cap`, `ath`, or `cur_data` as trigger-time facts.
- Add a poll-audit table recording start/end time, CLI version, item count, archive SHA-256, result status, and safe error details.
- Apply shared secret redaction before any diagnostic record, UI error, or archive manifest is persisted.
- Add a fixture test based on a redacted non-empty official response. The fixture must contain no API key, private key, or session data.
- Keep malformed events: record validation issues rather than discarding them.

**Acceptance gate:** a reviewer can trace every saved signal to one raw event and one archived poll response without exposing a secret.

## Phase 2 — Source-event deduplication and coverage accounting

**Purpose:** prevent repeated polling from inflating the research dataset while retaining all poll evidence.

- Deduplicate normalized events by the documented source identity: `source + chain + source_event_id`.
- Keep every raw poll archive and poll-audit record, including polls that return only already-seen events or zero events.
- Surface counts for received, newly stored, repeated, malformed, and unmatched-to-cohort events.
- Record oldest and newest source trigger timestamps in each response.
- Flag potential coverage gaps; a gap flag is evidence for review, never a reason to rewrite history or mark a token as having no signal.

**Acceptance gate:** repeat captures do not create duplicate signal rows, but their distinct raw responses remain archived and auditable.

## Phase 3 — UI watch mode

**Purpose:** replace manual clicking with controlled, visible local polling.

- Add **Start watching** and **Stop watching** controls to the dashboard.
- Start with one conservative configurable interval; show the next scheduled poll, last result, total polls, new events, repeats, and current state.
- Run only while the local application is open. No cloud service, background task, alert, or trade action is introduced.
- Stop automatically after repeated failures and show an actionable local error state.
- Respect GMGN rate limits: do not retry aggressively after a `429`; record the documented reset time when available.
- Measure the 50-item window's coverage of types 14–16 explicitly; report possible crowd-out rather than assuming complete coverage.
- Keep secrets server-side and excluded from SQLite, raw payloads, diagnostics, and archives.

**Acceptance gate:** a 48-hour local pilot runs without duplicate inflation, secret leakage, uncontrolled retries, or unexplained gaps.

## Phase 4 — Research-data quality views

**Purpose:** make collection completeness visible without evaluating whether signals are good.

- Show poll history, empty-poll rate, arrivals by signal type, raw-archive links, and unmatched cohort addresses.
- Show capture coverage boundaries: collector start time, last successful poll, and flagged gap intervals.
- Export a read-only provenance report containing hashes, counts, and timestamps—not credentials.
- Keep any charts descriptive only. Do not rank tokens, calculate returns, score signals, or recommend trades.

**Acceptance gate:** a reviewer can determine what was observed, when it was observed, what was missed or uncertain, and where the underlying raw material is stored.

## Phase 5 — Version the research contract before analysis

**Purpose:** avoid invalid historical comparisons from a live-only signal source.

- Create a versioned prospective research contract, for example `solana-gmgn-early-winner-v2`.
- Define the prospective population as tokens first observed after the collector start time.
- Define the comparator only among tokens whose exposure window was actually observed by the collector.
- Preregister outcome definitions, exclusions, and required data-quality thresholds before calculating any outcomes.

**Acceptance gate:** the research question, comparator, and collection coverage rules are reviewed and versioned before any return or effectiveness analysis is coded.

## Explicitly deferred

The following remain out of scope until separately approved:

- trading, copy-trading, wallet actions, or transaction signing;
- alerts or recommendations;
- return calculations, signal scoring, winner labels, or strategy optimization;
- web scraping or undocumented GMGN endpoints;
- historical GMGN backfill assumptions;
- cloud synchronization or sending raw data off this machine.

## Credential decision before Phase 1

The collector is API-key-only and does not perform wallet actions or request signing. The reviewer must confirm that no unused private signing key remains in `.secrets/gmgn/`; retain one only after a separately approved, documented signing use case.

## Recommended approval order

1. Approve Phase 1 and capture one redacted non-empty fixture.
2. Approve Phase 2 after fixture review.
3. Approve Phase 3 for a 48-hour pilot.
4. Review pilot evidence before Phase 4 or any research-contract revision.
