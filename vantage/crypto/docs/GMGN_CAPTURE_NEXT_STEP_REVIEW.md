# GMGN capture: proposed next step for review

**Date:** 2026-08-10  
**Status:** Proposed; awaiting review before implementation  
**Research contract:** `solana-gmgn-early-winner-v1`

## Decision requested

Approve the official GMGN `gmgn-cli market signal` integration as the source for the next capture phase, subject to one real redacted response fixture and an authorization check for this local research use.

The official source is preferable to website scraping because it is a documented GMGN integration path. The current official documentation describes the market signal route, API-key configuration, 50-result-per-group limit, signal event fields, and rate-limit handling.

## What is accepted now

- Source: official `gmgn-cli market signal` / `POST /v1/market/token_signal`.
- Chain for this project: Solana (`sol`).
- Access: API key only for market signal capture; never store a private key for this read-only collector.
- Capture mode: polling/live capture. There is no documented signal-event cursor, replay parameter, or historical backfill endpoint.
- Response ordering: newest `trigger_at` first.
- Timestamp: `trigger_at` is Unix seconds and must be normalized to UTC at ingestion.
- Event identity: use `source + chain + source_event_id`, where `source_event_id` is the documented event `id`.
- Signal types: request the unfiltered Solana feed, then filter locally. Do not explicitly request types 14, 15, or 16 until the current API behavior changes; the documentation says those filters can return HTTP 400.
- Raw preservation: retain every complete event object, including the opaque `data` snapshot.
- Query-time separation: `market_cap`, `ath`, and `cur_data` must not be stored as if they were trigger-time observations. `trigger_mc` and `first_trigger_mc` are the trigger-anchored fields.

## Gate before automatic collection

The source contract is not fully accepted until we have one real, redacted response fixture obtained through the authorized GMGN path.

The fixture must establish:

1. The actual top-level JSON shape returned by the installed CLI/API version.
2. The exact value types for `id`, `signal_type`, `trigger_at`, `trigger_mc`, and `first_trigger_mc`.
3. Whether `data` contains a triggering wallet or wallet-label fields.
4. Whether the API returns any source URL or event link.
5. The installed CLI version and the source documentation/repository commit used.
6. That the API key is not present in the saved fixture, logs, headers, or ZIP archive.

Do not fabricate the fixture and do not infer wallet paths from screenshots or undocumented examples.

## Proposed schema work

Extend the append-only GMGN observation model with source-native fields:

```text
source
chain
source_event_id
trigger_at
trigger_mc
first_trigger_mc
signal_times
signal_times_by_type
query_market_cap
query_ath
query_cur_data
request_group
poll_id
captured_at
ingestion_latency_ms
raw_payload
validation_errors
```

Add a unique constraint on `(source, chain, source_event_id)`. Keep the current nullable normalized fields for compatibility, but do not promote undocumented wallet fields until the fixture proves their paths.

Add append-only poll audit records containing:

- poll start/end time;
- request group and CLI/API version;
- HTTP outcome and rate-limit metadata;
- response item count;
- oldest and newest `trigger_at` in the response;
- previous response boundary;
- detected gap interval, if any;
- error text without secrets.

## Polling and gap policy

Start with a conservative configurable poll interval. Respect `X-RateLimit-Reset` and any documented `reset_at` value. Do not retry aggressively after a 429.

For each successful response, record the newest and oldest event timestamps. Flag a possible capture gap when the new response’s oldest timestamp is newer than the previous response’s newest timestamp. A gap is an audit result, not a reason to delete or rewrite events.

The pilot should measure whether the unfiltered 50-item window is sufficient for the target signal family, especially types 14–16. If those events are crowded out, report the loss explicitly rather than treating the remaining sample as complete.

## Revised research design implication

Because the source is live-only unless a documented replay mechanism is later found, the outcome study must be prospective:

> Among Solana tokens first observed after capture begins, does an eligible GMGN signal predict reaching the preregistered early-winner threshold?

The historical Dune cohort remains useful for population context and token identity, but an older token cannot be classified as “no GMGN signal” merely because this collector did not observe one.

This changes a load-bearing definition in `research/research-question.md`. The current `solana-gmgn-early-winner-v1` comparator remains the documented collection contract, but it is provisional for outcome analysis. If this live-only source plan is approved, publish a versioned research-question update (for example, `solana-gmgn-early-winner-v2`) with the prospective population and comparator before calculating any outcomes. Do not silently reinterpret the V1 comparator.

## Explicit non-goals for this step

Do not implement yet:

- website scraping or undocumented direct HTTP calls;
- wallet-label inference;
- historical signal backfill assumptions;
- signal scoring;
- trading or alerts;
- return/outcome calculation;
- strategy optimization;
- API-key storage in SQLite, raw payloads, logs, or archives.

## Acceptance checklist

- [ ] Reviewer approves the official source and local research use.
- [ ] One real redacted response fixture is captured.
- [ ] Fixture paths and value types are verified.
- [ ] Source event ID deduplication is tested.
- [ ] Trigger-time and query-time fields are stored separately.
- [ ] Poll audit and gap detection are tested.
- [ ] 429 handling respects reset metadata.
- [ ] A 48-hour pilot measures arrival rate, duplicates, gaps, and 14–16 coverage.
- [ ] The prospective research population and capture start timestamp are recorded.
- [ ] `research-question.md` is versioned to a prospective comparator before outcome analysis.
