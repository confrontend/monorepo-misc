# Research prompt: find the missing data needed to evaluate GMGN signals

You are researching how to obtain the additional data needed to evaluate captured Solana GMGN signals. Do not implement scoring, trading, scraping, or API integration during this research. Do not invent fields or assume that current token metadata is historical.

## Objective

Find authorized, reproducible sources for each missing observation:

1. Signal timestamp and trigger-time market cap.
2. Token price or market cap at the signal and at +1h, +6h, +24h, and +7d.
3. Liquidity at the signal and at each outcome checkpoint.
4. Token-risk observations: mint/freeze authority, holder concentration, blacklist/transfer restrictions, pool state, and rug/liquidity-removal indicators.
5. Explicit outcomes for missing, untradeable, delisted, or provider-error cases.

## Sources to investigate

Investigate official documentation and authorized access for:

- Dune Solana curated tables and query exports;
- GMGN’s official API/CLI and authorized browser capture;
- Birdeye historical price/OHLCV data;
- DEX Screener pool, price, liquidity, and market-cap data;
- direct Solana RPC/indexer data where needed for authority and holder checks.

## Required report

For every proposed source, return:

1. Official URL/repository and access method.
2. Authentication, pricing, quotas, and rate limits.
3. Historical coverage and minimum time resolution.
4. Exact request and response examples with secrets removed.
5. Exact JSON/SQL paths for token address, timestamp, price, market cap, liquidity, pool, and risk fields.
6. Whether values are historical-at-time or current snapshots.
7. Timestamp timezone, precision, and interpolation rules.
8. Missing-data, no-liquidity, untradeable, delisted, and API-error behavior.
9. Deduplication, pagination, retention, and reproducibility considerations.
10. A proposed normalized schema that keeps source-specific raw payloads intact.

## Outcome-data design

Propose a normalized observation record containing at least:

- signal ID and token address;
- source and source request identifier;
- target offset (`signal`, `+1h`, `+6h`, `+24h`, `+7d`);
- observed timestamp and requested timestamp;
- price, market cap, liquidity, and volume when available;
- tradability/status code;
- missingness or failure reason;
- raw payload and archive/provenance hash.

## Acceptance rules

- Prefer primary official documentation and reproducible exports.
- Do not use current price or liquidity as a substitute for historical values.
- Do not calculate market cap from today’s supply for an old timestamp without labeling the limitation.
- Do not infer that missing data means a failed or successful signal.
- Do not silently interpolate, drop, or overwrite observations.
- Do not expose API keys, cookies, device IDs, private keys, or session tokens.
- Do not bypass authentication, rate limits, robots controls, or terms of service.
- If a field cannot be obtained reliably, state that clearly and recommend an explicit `unknown` status.

## Final decision

Recommend one primary source and one fallback for price/liquidity history, explain why, and identify the smallest next implementation step for this local SQLite application. Keep return analysis and signal scoring out of scope until this source contract is reviewed and approved.
