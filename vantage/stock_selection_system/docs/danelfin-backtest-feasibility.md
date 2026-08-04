# Danelfin Historical Score Backtest Feasibility

Status: Phase 1 analysis completed; Phase 2 prototype implemented. Full institutional-grade validation remains out of scope.

## Recommendation

**IMPLEMENTABLE WITH LIMITATIONS**

The system can be extended to run a point-in-time backtest using Danelfin historical scores and EODHD prices. It cannot initially reproduce Danelfin's historical Best Stocks list exactly because `/v3/beststocks` returns only the latest 25-stock snapshot and does not accept a historical date. The first version should therefore backtest a clearly documented rule such as “top N stocks from `/ranking` on each rebalance date,” not claim to reproduce the Best Stocks Strategy.

This can produce a defensible prototype backtest of a Danelfin historical top-ranking strategy. It is not institutional-grade until score publication timing, historical-universe coverage, delisted-stock inclusion, and corporate-action handling are verified.

## 1. Current architecture

- Frontend: React 19 + TypeScript, built and served with Vite.
- Navigation: `ui/src/components/Sidebar.tsx` and screen selection in `ui/src/App.tsx`.
- Backend: FastAPI in `api/main.py`.
- Storage: SQLite, initialized from `schema.sql` through `src/db.py`.
- Existing provider clients:
- Danelfin: `src/ingestion/danelfin.py`.
  - EODHD: `src/ingestion/eodhd.py`.
  - Alpha Vantage: `src/ingestion/alpha_vantage.py`.
- Existing processing: candidate ingestion, required-input checks, frozen episode scoring, entry-price recording, and forward outcome tracking.
- Existing jobs: `src/jobs/entry_price_job.py` and `src/jobs/outcome_tracking_job.py`.
- Existing reports: text rendering in `src/reports.py`; no portfolio backtest report exists.
- Existing caching: browser localStorage for Candidate Intake snapshots; no historical provider-data cache exists yet.
- Existing tests: pytest tests for clients, ingestion, scoring, jobs, reports, API endpoints, and database behavior.

The newly added prototype is in `src/backtest.py`, exposed by `POST /api/actions/run-backtest`, and surfaced in the `Danelfin Backtest` sidebar page. It stores provider responses and run records in a separate `backtest/backtest.db`; the latest UI result is stored in browser localStorage.

## 2. Credentials detected

The local `.env` contains these key names:

```text
DANELFIN_API_KEY=present
ALPHA_VANTAGE_API_KEY=present
EODHD_API_KEY=present
FMP_API_KEY=missing
SHARADAR_API_KEY=missing
NASDAQ_DATA_LINK_API_KEY=missing
POLYGON_API_KEY=missing
FINNHUB_API_KEY=missing
```

No secret values were printed, logged, or copied into this report.

Minimal live calls were attempted for Danelfin `/ranking`, EODHD ATI EOD data, and Alpha Vantage earnings estimates. The current shell environment could not complete those requests and returned request-level failures, so the keys are presence-confirmed but not live-authentication-confirmed in this phase.

## 3. Danelfin capability

Danelfin's documented historical endpoint is `GET /ranking`. It requires a ticker or date. With only a date, it returns the top 100 tickers for that date, including AI, Technical, Fundamental, Sentiment, and Low Risk scores. The endpoint also exposes `buy_track_record` and `sell_track_record` as yes/no flags; it does not provide detailed historical win rates or returns in that response. The endpoint supports historical dates and a US market default. [Danelfin API documentation](https://danelfin.com/docs/api#ranking)

Danelfin advertises daily AI scores for US-listed stocks/ETFs and main European stocks since 2017. The advertised earliest period is therefore 2017, with January 3, 2017 used as the earliest date in Danelfin's published Best Stocks performance example. This still needs an authenticated sample request before being treated as the account's exact usable start date. [Danelfin API plans](https://danelfin.com/pricing/api/annual)

Important limitations:

- `/v3/beststocks` is latest-only: 25 US-listed stocks, no ETFs, not paginated, and no historical date parameter.
- Historical Best Stocks lists are not directly available from that endpoint.
- A historical ranking snapshot is not automatically the historical Best Stocks Strategy. Reproducing that strategy would require its exact historical rules, universe, exclusions, rebalance timing, and tie handling.
- The ranking endpoint documents a top-100 result when queried by date. It does not provide a documented one-call full-universe historical export in the current API documentation.
- Danelfin documentation does not establish that delisted securities, ticker changes, or historical point-in-time investable-universe membership are fully represented for a survivorship-bias-free reconstruction.
- The current application client is built for current Trade Ideas and current Best Stocks snapshots; it has no `/ranking` historical client yet.

Plan limits advertised by Danelfin are 500 calls/month and 10 calls/minute for API Free, 2,500/month and 60/minute for Basic, 10,000/month and 120/minute for Expert, and 50,000/month and 180/minute for Max. [Danelfin API pricing](https://danelfin.com/pricing/api/annual)

## 4. Market-price capability

EODHD is the appropriate current provider for the prototype because it is already integrated for daily EOD prices and replaces the Alpha Vantage MA200 gap. The existing EODHD client supports date-ranged daily EOD requests and ATI/SPY symbol mapping.

Classification:

- Prototype daily price history: **usable**.
- Reliable total-return backtest: **usable with additional verification and implementation**.
- Current application as-is for a backtest: **insufficient**.

The existing client currently normalizes raw OHLCV bars and has an optional adjusted-close parser in its diagnostic path, but the live daily interface and existing `price_signals` schema are not a complete corporate-action-aware portfolio-price model. A serious backtest needs an explicit decision about adjusted versus raw prices, dividends, splits, delisted tickers, ticker changes, missing bars, and execution prices.

SPY can be requested from EODHD and is already the application's benchmark source. The current project does not yet maintain a historical security master or a point-in-time list of securities that were investable on each historical date.

Alpha Vantage is not the selected historical-price provider for this feature. The project has already confirmed that the free Alpha Vantage tier gives only about 100 daily bars for the relevant daily endpoint and gates full history, which is insufficient for the application's 200-day requirements. Alpha Vantage remains useful for current earnings data, not as the historical backtest price source.

## 5. Look-ahead and survivorship risks

The implementation must prevent these errors:

- Selecting stocks using today's ranking for a historical date.
- Entering at the same close used to calculate the signal when the signal was not available until after that close.
- Using today's ticker list or today's surviving companies for historical dates.
- Using revised fundamentals or revised scores instead of the value available on the historical score date.
- Applying today's corporate-action adjustment inconsistently to historical entry and exit prices.
- Treating a missing price as a zero return.
- Using a historical Best Stocks result that cannot actually be retrieved for that historical date.

The safest first design is to record the score snapshot date, select from that snapshot, and assume the scores are tradable no earlier than the first trading-session open after the snapshot date. Danelfin's documentation does not state exactly when a date's scores became publicly available, so this timing assumption must be explicitly documented and later verified with the API or Danelfin. Every exclusion and missing-data decision should be stored in the backtest run output.

## 6. Estimated API usage

Assumptions: US trading dates, one `/ranking?date=...` call per rebalance date, and one EODHD price-history call per unique selected ticker plus one SPY call. These are planning estimates, not provider guarantees.

| Scope | Danelfin ranking calls | EODHD price calls before caching |
|---|---:|---:|
| One historical date | 1 | selected tickers + SPY |
| One month, weekly rebalance | about 4–5 | up to 25–100 unique tickers + SPY |
| One year, monthly rebalance | about 12 | up to 100–300 unique tickers + SPY |
| 2017–present, monthly rebalance | about 115–120 | potentially thousands of unique tickers + SPY |
| Top 25 per rebalance date | 1 per date | up to 25 new tickers per date + SPY |
| Top 100 per rebalance date | 1 per date | up to 100 new tickers per date + SPY |
| Full supported universe | not established by documented endpoint | not established |

Caching is mandatory. A cached response keyed by provider, endpoint, symbol, date range, and request parameters is required to avoid repeated calls and to preserve the exact input used by a run. The free Danelfin plan cannot support repeated daily historical retrieval across 2017–present within its advertised 500 calls/month limit; even monthly backtesting across the full period consumes roughly 120 ranking calls before retries or experiments.

## 7. Proposed fixed first backtest

Do not optimize parameters in the first version. Use one declared configuration:

- Universe: the top 100 stocks returned by Danelfin `/ranking` for each historical date, with ETFs excluded.
- Selection: top 10 by AI Score, with deterministic ticker sorting for ties.
- Rebalance: monthly on the first selected trading date of each month.
- Signal date: ranking snapshot date.
- Entry: first trading-session open after the new Danelfin snapshot date.
- Exit: the same session open used to enter the next rebalance portfolio, or the final available date.
- Weighting: equal weight.
- Benchmark: SPY, entered and exited on the same dates.
- Transaction costs: configurable fixed basis-point assumption, disabled only when explicitly comparing gross returns.
- Prices: EODHD raw open/high/low/close cannot be divided directly across split events. Use split-adjusted opens, or adjust share counts using split history; handle dividends as explicit cash flows. `adjusted_close` alone is not sufficient for an open-to-open portfolio calculation because it does not provide an adjusted open and dividends still need explicit treatment. [EODHD historical data](https://eodhd.com/financial-apis/api-for-historical-data-and-volumes), [EODHD technical indicators](https://eodhd.com/financial-apis/technical-indicators-api)
- Missing data: exclude and report; never silently substitute a zero return.

This is a proposed baseline only. It is not the historical Danelfin Best Stocks Strategy unless Danelfin's exact historical strategy rules are obtained and verified.

## 8. Proposed menu workflow

Add a new sidebar item after Candidate Intake:

```text
Danelfin Backtest
```

Suggested page sections:

1. Data availability and cache status.
2. Danelfin and EODHD API status.
3. Start date and end date.
4. Rebalance frequency.
5. AI score and universe filters.
6. Number of selected stocks.
7. Run Backtest button.
8. Performance summary: cumulative return, annualized return, volatility, drawdown, and hit rate.
9. SPY comparison.
10. Trade list with score date, entry date, exit date, ticker, weight, prices, and return.
11. Exclusions and data-quality warnings.
12. Export as CSV/JSON.

The page should use the existing React page pattern and call backend endpoints. It should not call Danelfin directly from the browser; the API key must remain server-side.

## 9. Proposed architecture

Likely new modules:

- `src/backtest/models.py`: immutable run configuration, snapshots, selections, trades, and summary types.
- `src/backtest/cache.py`: provider-response cache keyed by request identity.
- `src/backtest/danelfin_history.py`: `/ranking` historical retrieval and normalization.
- `src/backtest/market_data.py`: EODHD historical bars, adjusted-price policy, and trading-session alignment.
- `src/backtest/engine.py`: point-in-time selection, next-open entry, rebalance/exit logic, and benchmark comparison.
- `src/backtest/report.py`: summary, trade list, exclusions, and export structures.
- `ui/src/pages/DanelfinBacktestPage.tsx`: proposed page.

Likely changed modules:

- `ui/src/App.tsx` and `ui/src/components/Sidebar.tsx` for the menu item.
- `ui/src/api.ts` and `ui/src/types.ts` for backtest endpoints and result types.
- `api/main.py` for run/status/export endpoints.
- `schema.sql` for backtest runs, cached responses, selections, trades, and warnings, unless a separate SQLite file is intentionally chosen.

The frozen stock-selection tables should not be repurposed for backtest state. Backtest runs are operational analysis records and should be isolated from immutable episode/review tables.

## 10. Testing plan

- Unit-test historical response flattening and date normalization.
- Unit-test cache key stability and cache hits.
- Unit-test next-session entry logic around weekends and holidays.
- Unit-test no-look-ahead behavior with scores and prices arriving on different dates.
- Unit-test split/dividend adjustment policy.
- Unit-test missing-price exclusions and warning output.
- Unit-test deterministic tie handling and equal weighting.
- Unit-test SPY benchmark alignment.
- Add a small fixture-based end-to-end run with a few dates and tickers.
- Verify exports against stored trade rows.
- Run a live minimal sample only after the historical endpoint and price coverage are authenticated.

## 11. Complexity estimate

- Historical Danelfin client and normalization: medium.
- Provider cache and storage: medium.
- Point-in-time backtest engine: high.
- Corporate actions, ticker changes, and survivorship controls: high.
- Backend endpoints and exports: medium.
- React page and visualization: medium.
- Test fixtures and validation: medium-to-high.

## 12. Exact blockers

1. The available shell could confirm key presence but could not complete live provider requests, so authentication and account-specific coverage remain unverified.
2. Historical Danelfin scores are documented, but historical Best Stocks lists are not exposed by `/v3/beststocks`.
3. Danelfin does not document the exact score-publication time for a historical date.
4. EODHD supplies delisted histories and ticker-renaming data, but Danelfin's historical top-100 results must still be tested against known delisted securities.
5. The current project does not have a point-in-time security universe or corporate-action-aware portfolio return model.
6. A full 2017-present daily retrieval is too large for casual use on the advertised Danelfin Free plan and requires caching plus a deliberate sampling/rebalance strategy.

## 13. Phase 1 output

- Recommendation: **IMPLEMENTABLE WITH LIMITATIONS**.
- APIs detected in code: Danelfin, EODHD, Alpha Vantage.
- Keys detected: Danelfin, EODHD, Alpha Vantage present; no FMP, Sharadar/Nasdaq Data Link, Polygon, or Finnhub key detected.
- Minimal API test result: provider requests could not complete in the current shell environment; no secret values were exposed.
- Earliest advertised Danelfin score coverage: since 2017; exact account-confirmed first usable date remains pending.
- Historical coverage: Danelfin scores advertised since 2017; Best Stocks historical list not directly available; EODHD price coverage requires authenticated range testing and corporate-action verification.
- Selected market-data provider: EODHD.
- Proposed menu location: sidebar after Candidate Intake, labeled `Danelfin Backtest`.
- Proposed implementation: separate backtest modules and storage, server-side provider calls, cache-first retrieval, point-in-time engine, explicit warnings, and fixture-based verification.

Phase 2 implementation is complete for the conservative prototype. Before relying on results, verify the configured keys and run a small date range first. Do not interpret the output as a historical replay of Danelfin's proprietary Best Stocks Strategy.
