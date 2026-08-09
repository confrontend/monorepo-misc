# Unified ingestion plan — one folder, one button, one database

Status: **implemented.** See "What actually happened" at the end for where reality differed from
this plan — three things did, one of them a root cause worth knowing about.

## 1. The workflow you get

1. Drop any number of `.json` files into `backtest/input/` (nesting allowed — the scan is recursive).
2. Open the app. A **Data** tab shows every file in that folder with a status: `new`, `changed`, `imported`, or `unreadable`, plus what kind of data each one holds and how many records it contributes.
3. Press **Import**. Everything new or changed is parsed into the database in one transaction. Takes seconds.
4. Every tab reads the database. Nothing runs from a terminal.

The one exception you accepted: the persistence-screen statistics stay in Python, spawned by the server when you press their **Run analysis** button. No terminal, but Python + pandas must exist on the machine.

## 2. What exists today

Three ingestion paths, four file shapes, and no shared storage.

| Path | Reads | Writes | Feeds |
|---|---|---|---|
| `src/data.ts` — `import.meta.glob`, eager, at SSR module load | `input/*.json` (28), `input/3-year/*.json` (361), `benchmark/*.json` (27) | in-memory only | Ticker results, Overall, Strong Buy, Rating tiers, Rating accuracy |
| `scripts/import-3-year-data.mjs` — CLI | `input/3-year/*.json` | `.data/analysis.sqlite` → `historical_prices`, `ticker_changes` | **nothing** |
| `research/run_analysis.py` — CLI | `input/3-year/raw_*.json` | `research/report/*.csv` | Persistence screens |

The four shapes:

| Shape | Where | Structure |
|---|---|---|
| Hand-curated capture | `input/*.json` | `{schemaVersion, capturedAt, source, quantRatingHistory:{headers, records[], rowCount}}` |
| Raw API response, one endpoint per file | `input/3-year/*.json` | `{data[], included[], meta}` — kind currently inferred from the **filename** substring `_historical_prices_` / `_ticker_changes_` |
| Bundled capture array | `input/3-year/raw_*.json` | `[{_slug, _kind:"prices"\|"changes", body:{data[]}}]` |
| Benchmark prices | `benchmark/*.json` | `{ticker, source, fetchedAt, records:[{date, close, adjClose}]}` |

Three things are already broken or wasteful, independent of this migration:

- **The importer's output is orphaned.** Nothing in `src/`, `server/`, or `vite.config.ts` selects from `historical_prices` or `ticker_changes`. That table is written and never read.
- **Two database files.** `.data/analysis.sqlite` (640 MB, currently returning `disk I/O error`) and `server/.data/analysis.sqlite` (4 KB, holds the result tables) — leftovers from a path change in `client.ts`.
- **Kind detection by filename.** Rename a file and the importer silently ignores it.

Half of what you want already exists: `server/db/` defines `analysis_runs` plus ten result tables and writes computed output keyed by `(fingerprint, methodology_version)`. That layer caches *outputs*. This plan adds the missing half — storing *inputs* — and repoints everything at it.

## 3. Two findings this migration should fix

### 3.1 The reconstructed SPY series has 15 wrong days, and real data was already on disk

`research/spy_series_2023-07-31_2026-08-03.csv` was described as the expensive, fragile, don't-touch artifact. But `benchmark/SPY.json` already holds **real Yahoo adjusted closes covering exactly the same window** — 755 rows, 2023-07-31 to 2026-08-03, an exact row-for-row match on dates.

Comparing them: 740 of 755 rows agree to ~8 decimal places (median relative difference 2.3 × 10⁻⁸). Fifteen do not:

| Date | Reconstructed | Real | Error |
|---|---|---|---|
| 2025-04-08 | 518.74 | 489.59 | **+5.95%** |
| 2023-11-14 | 428.79 | 433.83 | −1.16% |
| 2025-06-05 | 589.24 | 584.82 | +0.76% |
| 2025-01-07 | 582.45 | 578.72 | +0.64% |
| 2025-08-05 | 625.05 | 621.09 | +0.64% |
| …10 more between 0.2% and 0.63% | | | |

Every trade whose entry or exit lands on one of those dates carries that error straight into its excess return. The 5.95% day is large enough to move individual trades materially. Since the benchmark series is only used through `spy_series.loc[date]` lookups, swapping the source is a one-line change once both live in the database — and it should be treated as a correctness fix, then the grid re-run and the results compared.

This does **not** invalidate the reconstruction's original validation (11 spot-checked closes matched exactly — consistent with 740/755 being near-perfect). It means the least-squares solve has a handful of poorly-constrained days, and there is no longer any reason to use it when real data exists for the whole window.

### 3.2 The 27-vs-187 ticker split is an accident of which glob was used

Ticker results and Overall use only the 27 hand-curated captures. Strong Buy, Rating tiers and Rating accuracy use `extendedDatasets` — 187 tickers. Persistence screens use a third set — 223. Same app, three different universes, and the difference is invisible in the UI.

Once everything comes from one database this has to become an explicit, labelled choice per tab rather than a side effect of which files a glob happened to match. Recommend surfacing the universe size in each tab's header.

## 4. Target architecture

```
input/**.json ──► [scan + hash] ──► source_files
                        │
                        ▼
              [content-based detector]
                        │
       ┌────────────────┼─────────────────┬──────────────────┐
       ▼                ▼                 ▼                  ▼
    prices        rating_changes     quant_history    benchmark_prices
       └────────────────┴─────────────────┴──────────────────┘
                        │  (raw layer — source of truth)
                        ▼
                   data_version ── bumped on every import
                        │
        ┌───────────────┴────────────────┐
        ▼                                ▼
  data.ts analyses                 Python pipeline
  (on demand, cached)              (spawned on demand)
        │                                │
        └────────► result tables ◄───────┘
                  keyed by (data_version, methodology_version)
                        │
                        ▼
                   /api/* ──► React
```

Two rules that keep it honest:

- **Raw tables are append-and-upsert only.** They are never derived from anything. Any result can be rebuilt by deleting the result tables.
- **Every result row carries the `data_version` and `methodology_version` that produced it.** A tab showing stale results can say so instead of silently serving them.

## 5. Database design

New raw tables:

```sql
source_files(
  id INTEGER PK, rel_path TEXT UNIQUE, sha256 TEXT, bytes INTEGER, mtime_ms REAL,
  kind TEXT,              -- capture | api_prices | api_changes | bundle | benchmark | unknown
  status TEXT,            -- imported | failed
  error TEXT,
  price_rows INTEGER, rating_rows INTEGER, quant_rows INTEGER, benchmark_rows INTEGER,
  imported_at TEXT
)

tickers(slug TEXT PK, name, exchange, currency, sector, first_seen, last_seen)

prices(ticker_slug, as_of_date, open, high, low, close, volume,
       div_adj_factor, adj_close, source_file_id,
       PRIMARY KEY (ticker_slug, as_of_date))

rating_changes(api_id TEXT PK, ticker_slug, created_at, new_rating, previous_rating,
               rating_new REAL, rating_previous REAL, market_cap, div_yield, analysts,
               sector_display, source_file_id)

quant_history(ticker_slug, as_of_date, price, quant_rating, quant_score,
              valuation, growth, profitability, momentum, eps_revisions, source_file_id,
              PRIMARY KEY (ticker_slug, as_of_date))

benchmark_prices(symbol, as_of_date, close, adj_close, source, source_file_id,
                 PRIMARY KEY (symbol, as_of_date))

data_version(id INTEGER PK CHECK (id = 1), version INTEGER, updated_at TEXT,
             file_count INTEGER, price_rows INTEGER, rating_rows INTEGER)
```

Notes:

- `adj_close` is stored computed (`close × div_adj_factor`) so every consumer uses one definition rather than each recomputing it.
- Provenance (`raw_record_json`) is what makes the current DB 640 MB. Recommend dropping it from the hot tables and keeping `source_file_id` + the file itself on disk as the audit trail. If full provenance is wanted, put it in a separate `raw_records` table nobody joins against.
- **Compatibility views** `historical_prices` and `ticker_changes` mapped onto the new tables mean the existing Python loader works against this database *unmodified* — no change to validated code just to change its input.

Result tables: keep the existing ten, add `screen_results`, `screen_concentration`, `screen_placebo` for the persistence grid, and add `data_version` to `analysis_runs`.

## 6. Import flow

On **Import**:

1. Recursively scan `input/` for `*.json`; `stat` + SHA-256 each file.
2. Diff against `source_files` → `new` / `changed` / `unchanged` / `missing`.
3. For each new-or-changed file, detect kind **by content**, not filename:
   - array whose elements have `_kind` and `body.data` → bundle
   - object with `quantRatingHistory.records` → capture
   - object with `records[].adjClose` and a `ticker` → benchmark
   - object with `data[].attributes` containing `as_of_date` + `close` → api_prices
   - object with `data[].attributes` containing `createdAt` + `newRating` → api_changes
   - otherwise `unknown` — recorded with a reason, never silently skipped
4. Parse and upsert inside one transaction per file. Conflicts on `(ticker_slug, as_of_date)` resolve last-write-wins with the newer `mtime`; log when values actually differ.
5. Write the `source_files` row.
6. Bump `data_version`, invalidate result tables for the old version.
7. Return a summary: files added/updated/failed, rows per table, elapsed.

`missing` files (in DB, gone from disk) are reported, not auto-deleted — deleting rows because a file moved is how you lose data quietly.

## 7. UI

New **Data** nav item, matching existing patterns (`nav-button`, `table-panel`, `data-badge`, `verdict-*` badges):

- Header strip: total files, tickers, price rows, rating events, date coverage, last import time, and a `data_version` badge.
- **Import** button — disabled with "Everything is up to date" when nothing is new; otherwise "Import 3 new files".
- File table: path, kind, status badge, record counts, last imported. Unreadable files show their reason inline.
- After import, a summary panel: what changed, and which tabs are now stale.

The existing 2-second `meta` poll already gives free change detection — the Data tab can light up when a file appears without any new polling machinery.

## 8. API surface

| Endpoint | Change |
|---|---|
| `GET /api/data/status` | **new** — folder-vs-DB diff, counts, `data_version`, last import |
| `POST /api/data/import` | **new** — runs the import, returns the summary |
| `POST /api/research/run` | **new** — spawns the Python pipeline, returns a job id |
| `GET /api/research/run/:id` | **new** — job status for polling |
| `GET /api/analysis?action=…` | contract unchanged; source becomes the DB |
| `GET /api/research` | contract unchanged; reads result tables instead of CSVs |

Everything stays in the Vite dev-server plugin, consistent with today. Worth noting: this only works under `npm run dev`, exactly like the current app.

## 9. Python integration

- **Input:** `--input .data/analysis.sqlite`. Already supported — `load_price_and_rating_data()` auto-detects sqlite with `historical_prices` / `ticker_changes` tables, which the compatibility views provide. No change to the loader.
- **Benchmark:** replace the `--spy` CSV with a read from `benchmark_prices` (see §3.1). Small, contained change to `load_spy_series()`.
- **Output:** keep writing `report/*.csv` to a temp directory; Node reads them and inserts into the result tables. Keeps the Python side almost untouched.
- **Execution:** `child_process.spawn`, ~40 s, tracked as a job with status polling. Not synchronous — the dev server is single-threaded and a blocking 40-second handler freezes every other request.
- **Failure surface:** missing Python, missing pandas, and non-zero exit each need a distinct, readable message in the UI. This is the main cost of choosing spawn-over-port.

## 10. Phases, each with a verification gate

| Phase | Work | Gate |
|---|---|---|
| **0** | Consolidate to one DB path; delete the 640 MB corrupt file; drop `raw_record_json` from hot tables | App still starts; `server/.data/` no longer used |
| **1** | Schema + importer module (no UI). Import all 417 existing files | Row counts match today's: 223 tickers / 166,933 prices / 6,999 rating events from the bundle; 27 captures; 8,434 benchmark rows |
| **2** | `/api/data/status`, `/api/data/import`, Data tab | Adding a file shows as `new`; import moves it to `imported`; re-import is a no-op |
| **3** | Repoint `data.ts` from globs to DB queries | **Every existing tab reproduces its current numbers exactly** — 48.7% predictive hit rate, 40.4% call hit rate, 187 tier tickers, and the Strong Buy outlier figures |

Phase 3 is contained by the recent `src/domains/*` split: the view components take typed props and don't touch the loader, so only `data.ts` and the API layer change. A per-domain data-access module under each `domains/<name>/` is the natural place for that tab's queries.
| **4** | Python reads the DB and real SPY; results land in result tables; UI trigger | Grid reproduces today's output when run on the reconstructed series; then re-run on real SPY and **document the difference** rather than quietly adopting it |
| **5** | Delete CLI scripts, globs, CSV artifacts, fingerprint machinery | `npm run dev` is the only command |

Phase 3 is the risky one and should not be merged without the parity gate. Phase 4's second half is a methodology change and deserves its own before/after record in `progress.md`.

## 11. What gets deleted

- `scripts/import-3-year-data.mjs`, `scripts/fetch-benchmark-prices.mjs` → become import kinds / a refresh button
- `npm run import:3-year`, `npm run fetch:benchmark`
- All three `import.meta.glob` calls in `data.ts`
- `buildFingerprint()`, `methodologyWatchPaths`, and the `ssrLoadModule` reload dance in `vite.config.ts` — `data_version` replaces all of it, and the module no longer needs Vite-only macros
- `research/report/*.csv` as the transport layer (kept as a Python-side temp artifact)
- `dist_verify*/`, `probe-scratch*.mjs`

## 12. Risks and open questions

**Risks**

- *Phase 3 parity.* `data.ts` currently gets typed objects from globs; DB rows arrive as `unknown`. Field-by-field mapping is where silent behaviour changes hide. Mitigated by the parity gate, not by care.
- *Python dependency.* The app now fails on any machine without pandas. Needs a clear error, and a note in the README.
- *Single-threaded dev server.* Import is fast, but a 417-file first run plus a 40-second analysis both need to be off the request path.
- *`node:sqlite` + WSL/Windows/FUSE.* The 640 MB `disk I/O error` and the `EPERM` unlink failures are all filesystem-boundary issues. Keeping the DB small helps; testing on both your WSL path and native Windows is necessary.

**Open questions**

1. Does `benchmark/` merge into `input/`, or stay a separate reference folder? One folder is what you asked for and the detector handles it; separate is arguably clearer since it's not Seeking Alpha data.
2. After §3.1, is the reconstructed SPY CSV retired entirely, or kept as a fallback for dates Yahoo lacks?
3. Should the three ticker universes (27 / 187 / 223) be unified into one, or kept distinct and clearly labelled? Unifying changes published numbers on five tabs.
4. Is there a real need for full `raw_record_json` provenance, or is the source file on disk enough?

---

## What actually happened

All five phases landed. Three things differed from the plan, and one of them explains a problem
this project has been working around for days.

### 1. WAL journal mode was the cause of the unreadable 640 MB database

The plan blamed size. Size was a contributing factor, not the cause.

`applySchema()` opened every database with `PRAGMA journal_mode = WAL`. On a Windows drive mounted
into WSL (`/mnt/c/...`) — and on the sandbox's FUSE mount — SQLite *accepts* that pragma, accepts a
probe write, and serves an entire session normally. The next process cannot open the file at all:
the header now records WAL, and the `-wal` file can never be check-pointed back in. That is exactly
the state `analysis.sqlite` was in: 640 MB of database beside a 216 MB orphaned `-wal`, returning
`disk I/O error` on open.

Detecting support at runtime does not work, because the failure is deferred past every check you
can make. The database now uses `TRUNCATE` unconditionally, which zeroes the journal in place
rather than unlinking it — the operation these filesystems do support. There is nothing to gain
from WAL in a single-process dev server anyway.

Two related settings came from the same investigation: `synchronous = OFF` and `temp_store = MEMORY`.
The same 170,000-row insert takes over three minutes with fsync on each commit and 1.3 seconds
without, and under load the fsyncs were producing outright I/O failures. The durability trade is
acceptable precisely because no row in this database is original — everything is derived from a
file in `input/`, so the worst case is pressing Import again.

### 2. The result-snapshot layer is now off by default

`server/db/runs.ts` writes a full snapshot of every tab's output per `(fingerprint, methodology)`
pair. Nothing has ever read it — no `SELECT` against `ticker_strategy_results` or its nine siblings
exists anywhere in `src/`, `server/`, or `vite.config.ts`; `/api/analysis` serves from an in-memory
cache. At 27 tickers that was a harmless 4 KB. At 379 it is 29,562 rows carrying full per-event
JSON: it took the database from 62 MB to **553 MB** and added ~40 s of background work per data
version, to produce rows no reader has.

It is gated behind `VANTAGE_PERSIST_RESULTS=1` rather than deleted, so it can come back the moment
a consumer exists.

### 3. Research results still travel as CSV

The plan had the Python pipeline's output land in database tables via Node. It still writes
`research/report/*.csv`, which `/api/research` reads. The user-visible requirement is met — the
analysis is a button, not a command — but the raw/results split is not yet symmetric for this one
producer. Worth closing if the persistence layer above is ever switched back on.

## Numbers before and after

Unifying the ticker universe changed published figures on five tabs, as expected. The conclusions
did not move, which is the useful part: they now rest on roughly twice the data.

| | Before (27 / 187 split) | After (379 unified) |
|---|---|---|
| Tickers per tab | 27 or 187, depending on tab | 379 everywhere |
| Predictive accuracy, scored calls | 2,995 | 6,331 |
| Predictive hit rate | 48.7% | 49.6% (CI 47.7–51.4) |
| Rating-call hit rate | 40.4% | 40.0% |
| Strong Buy completed trades | 854 across 151 tickers | 1,949 across 330 tickers |
| Strong Buy raw mean | +1.23% | +1.01% |
| Strong Buy 10% trimmed mean | −0.34% | −0.38% |
| Top 10% of trades' share of profit | 81.8% | 80.0% |
| Score-correlation points | 26 usable | 379 |

Still a coin flip. The trimmed mean still flips sign. Still outlier-driven.

The persistence grid, re-run on the database with **real** SPY closes instead of the reconstructed
series: 378 tickers, 22 testable cuts (up from 19), 3 cells clearing the pre-registered bar (up
from 2). The placebo control is unchanged in its verdict — observed mean 7.75pp against a random
median of 9.16pp, empirical p = 0.66. Random tickers on the same dates still do at least as well.

## Database

`.data/vantage.sqlite`, ~60 MB, holding 282,109 prices / 10,725 rating events / 29,772 daily
snapshots / 150,508 benchmark rows across 401 tickers, from 417 source files. The old
`analysis.sqlite` was 640 MB for less data, because it stored a verbatim JSON copy of every record.
