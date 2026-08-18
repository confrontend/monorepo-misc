# Research prompt: verify GMGN Top Callers sources before building anything

You are researching the data sources needed for a proposed CopyTrade → Top Callers feature. Do
not implement capture, storage, scoring, or UI during this research. Do not guess field names
from the proposal below — every field path must come from a real, redacted response you actually
captured.

## Context

This app already has a working pattern for GMGN capture and outcome measurement:
`src/copytrade/fetch.ts` (wallet trade capture, rate-limit pacing via `waitForGmgnRequest`),
`src/dune/outcomes.ts` (checkpoint-based outcome measurement with premature-invalidation
handling), and `src/copytrade/copySimulation.ts` (real vs. proxy measurement, kept explicitly
separate). Top Callers should reuse these patterns, not reinvent them — but only after the
sources below are actually verified, since the candidate endpoints have not yet been confirmed
against real captured payloads.

## Objective

For each candidate endpoint, confirm it is real, understand its exact shape, and answer whether
it's fit for the proposed feature:

1. Top Caller rankings — `/api/v1/notification/callout/rank`
2. Caller history — `/api/v1/notification/call_out/get_record`
3. Follow/Callout activity — `/vas/api/v1/follow/multi_chain_follow_wallet_trade_list`
4. Twenty-four-hour token cards — `/vas/api/v1/follow_cards/cards/sol/24h`
5. Current token prices — `/api/v1/token_prices`

## Required report, per endpoint

1. Confirm it is reachable via the already-configured `gmgn-cli` / GMGN API key, or state what
   auth it actually needs if different.
2. One real, redacted raw JSON response (strip caller PII beyond what GMGN already makes public,
   strip any session/device identifiers).
3. Exact JSON paths for: caller identity, caller wallet address (if any), token address, call
   timestamp, call price, call market cap, message/thesis text, GMGN's own multiplier/profit
   fields, and a stable per-call source ID if one exists.
4. Timestamp timezone and precision.
5. Pagination, page size limits, and how far back history actually goes (does `get_record`
   return a caller's full history, or only a recent window?).
6. Rate-limit behavior for this specific endpoint family — is it the same leaky-bucket limiter
   already fought with in `wallet_activity`/`wallet_stats`, or separate quota? State how many
   calls were made and whether a 429/ban was hit during this research.

## Specific open questions to resolve with evidence, not assumption

1. **Canonical Callout source.** Is `get_record` a complete per-caller archive, or does it also
   only show a recent window? Does `multi_chain_follow_wallet_trade_list` return the same calls,
   a superset, or a different/rotating feed? Determine which one (or which combination) a daily
   capture needs to hit to avoid silently missing calls.
2. **Dedup grain.** Does a real caller ever call the same token twice in one day? Pull evidence
   from actual `get_record` output rather than assuming. Does the source provide a stable call ID
   field, or does dedup genuinely need to fall back to caller + token + timestamp?
3. **Live vs. historical fields.** Is "current price change" (or any other field on a call
   record) a value fixed at call time, or does it drift depending on when you query it? This
   matters the same way `query_cur_data`'s live fields already do elsewhere in this project — a
   drifting field must never be treated as "value at call time" without its own capture
   timestamp. Prove this by querying the same call record twice, hours apart, and diffing it.
4. **`/token_prices` vs. Dune.** Is this endpoint historical-at-time or current-only (like GMGN's
   `liquidity` field turned out to be earlier in this project — live-only, unusable for
   backfill)? If current-only, it cannot serve the +1h/+6h/+24h/+3d/+7d checkpoints and Dune
   remains the only real historical source for those; confirm which is actually true rather than
   assuming parity with the token-info endpoint already characterized.
5. **Rate-limit budget.** Given the leaderboard can have many callers, each with many calls, each
   needing multiple checkpoint prices, estimate real request volume for a plausible v1 scope
   (e.g. top 20 callers, last 30 days of calls) and check it against what's already known about
   this account's rate limits from prior sessions. State whether v1 must restrict to a
   tracked/selected subset of callers rather than the full leaderboard.

## Acceptance rules

- Do not invent or assume a field exists because the proposal names it — every field in the
  final report must be traced to a real captured response.
- Do not treat a live/current value as a historical one without verifying it doesn't drift.
- Do not expose API keys, cookies, device IDs, or session tokens in the report or any fixture.
- Do not exceed a small number of low-volume probe calls; stop and report if a 429 or ban is hit,
  do not retry through it.
- If an endpoint cannot be confirmed as documented or behaves differently than the proposal
  assumed, say so plainly rather than reconciling the discrepancy silently.

## Final decision

Recommend: the canonical Callout source, the dedup key design, whether `/token_prices` has any
role beyond a live display value, a realistic v1 caller scope given rate-limit reality, and the
smallest next implementation step. Keep schema design, scoring, and UI out of scope until this
source contract is reviewed and approved — same gate this project already applies to every other
GMGN-sourced feature.
