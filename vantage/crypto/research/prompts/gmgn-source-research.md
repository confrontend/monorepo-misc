# Research prompt: identify the real GMGN signal source

You are researching the data source needed for `solana-gmgn-early-winner-v1`. Do not implement scraping or invent a payload shape.

## Objective

Find one authorized, reproducible way to obtain raw Solana GMGN signal events for smart-money, KOL, large-buy, multi-buy, price, or other GMGN-labelled signals. Prefer an official API, official CLI/skill, documented export, or an explicitly authorized browser/network capture.

## Return a source contract

Return a short evidence-backed report containing:

1. Source name, official URL/repository, access method, authentication requirements, and rate limits.
2. One real redacted raw JSON response captured from the source.
3. Exact JSON paths for token address, event timestamp, signal type, trigger market cap, triggering wallet, wallet labels, and source URL.
4. Timestamp timezone and precision rules.
5. Pagination, polling, replay, deduplication, and retention behavior.
6. Whether historical/backfill events are available or only live events.
7. Terms/authorization constraints and any fields that must not be stored.
8. A proposed adapter mapping into `storeGmgnSignal`, with unknown fields left in `raw_payload`.

## Acceptance rules

- Do not treat a token page, wallet trade feed, or price movement as a GMGN signal unless the source explicitly identifies it as one.
- Do not guess field names from a screenshot or an undocumented response.
- Do not expose API keys, private keys, cookies, or session tokens in the report or raw payload fixture.
- If no authorized source is available, say so and recommend continuing with manual raw-event capture; do not bypass login, rate limits, or access controls.

