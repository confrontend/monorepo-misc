# Handover — Seeking Alpha backtest app

Written for the next agent picking this up. Covers a single work session that did three things:
finished a dashboard for the persistence-screen research, added a plain-language summary to it, and
then migrated the whole app from file-glob loading to a database with a UI import button.

Read §6 before touching anything statistical, and §7 before touching SQLite.

---

## 1. What this project is

A statistical reliability study of Seeking Alpha's Quant Rating as a stock-picking signal, plus a
React/TypeScript app that presents it. The standard is academic-grade defensibility: **an honest
"no edge" or "insufficient data" conclusion is a valid, expected outcome.** The whole project is
built around not rounding weak or outlier-driven results up into false positives. Keep that posture.

Stack: Vite 6 + React 18 + plain TypeScript, hand-written CSS in `src/styles.css` (no Tailwind, no
component library, no router — navigation is an `ActiveView` string union persisted to
localStorage). All APIs are middleware inside `vite.config.ts`, so **the app only works under
`npm run dev`**; a built `dist/` has no backend. That predates this session.

---

## 2. Current architecture

```
input/**.json ──► Import button ──► server/db/ingest.ts ──► .data/vantage.sqlite
                                                                  │
                    ┌─────────────────────────────────────────────┤
                    ▼                                             ▼
        server/db/datasets.ts                          research/pipeline.py
        (builds CaptureDataset[])                      (via compatibility views)
                    │                                             │
                    ▼                                             ▼
              src/data.ts                              research/report/*.csv
        (all analysis, unchanged)                                 │
                    │                                             │
                    ▼                                             ▼
            /api/analysis                                  /api/research
                    └──────────────► React ◄──────────────────────┘
```

**Key files**

| File | Role |
|---|---|
| `server/db/ingest.ts` | Scan/hash/detect/parse/upsert. Only writer of raw tables. |
| `server/db/datasets.ts` | DB rows → the in-memory shapes `data.ts` used to glob. |
| `server/db/schema.ts` | Migrations via `PRAGMA user_version`, append-only. Journal/pragma setup. |
| `server/db/client.ts` | Opens `.data/vantage.sqlite`. |
| `src/data.ts` | ~1600 lines of analysis. Receives data via `initialiseDatasets()`. |
| `vite.config.ts` | All four API plugins + the Python spawn job. |
| `research/pipeline.py` | Validated statistics: wild cluster bootstrap-t, Holm/BH, concentration, placebo. |
| `research/run_analysis.py` | CLI that runs the grid; defaults to the app database. |
| `src/domains/*/components/` | One view component per tab. |

**Endpoints** (all dev-server middleware)

- `GET /api/data/status`, `POST /api/data/import`
- `GET /api/analysis?action=…` — meta, tickerRows, aggregate, strongBuy, tiers, accuracy, …
- `GET /api/research`, `POST /api/research/run`, `GET /api/research/job`

---

## 3. What changed this session

### 3a. Persistence-screen dashboard (new "Persistence screens" tab)
- `src/domains/research/components/ResearchView.tsx` — headline verdict, full 48-cut grid table,
  concentration bar chart, placebo comparison, run-details disclosure, and a **$100 matrix** at the
  top translating the three strongest screens into plain language.
- The `$100` figures are "one average trade for the hold period", explicitly **not** compounded.
  Confidence labels reuse existing thresholds only — no new bar was invented.
- `research/pipeline.py` gained `trade_outcomes()` and `cluster_bootstrap_ci()` (descriptive only,
  they do **not** feed the discovery bar), and `full_results.csv` gained five columns.
- `run_analysis.py` now also writes `report/run_meta.json` with the thresholds/grid the run used, so
  the UI can never display a bar that differs from the one the results were judged against.

### 3b. Loader robustness in `pipeline.py`
- `load_price_and_rating_data()` now reads **three** shapes: sqlite (tables *or views*), flat CSV
  exports, and raw JSON API dumps. Recognised by content, never by filename.
- Skipped files are reported by name and reason instead of silently ignored. This mattered: a
  "pandas problem" turned out to be that the CSVs had been deleted from the input folder.

### 3c. The ingestion migration (the big one)
Five phases, all landed. See `docs/unified-ingestion-plan.md` for the full plan and a
"What actually happened" section at the end.

- New raw tables: `source_files`, `tickers`, `prices`, `rating_changes`, `quant_history`,
  `benchmark_prices`, `data_version`. Migration #3 in `schema.ts`.
- Compatibility **views** `historical_prices` / `ticker_changes` so `pipeline.py`'s sqlite loader
  runs against the app database unmodified.
- `data.ts`'s three `import.meta.glob` calls are gone. It exposes `initialiseDatasets()`, called by
  the vite plugin after `ssrLoadModule`.
- `buildFingerprint()` (hashing directory mtimes on every request) replaced by `data_version`.
- New **Data** tab: per-file status badges, counts, Import button, failure reasons inline.
- Python pipeline is spawned by `POST /api/research/run` as a tracked job with status polling.
  `python3` with a `python` fallback on ENOENT; missing-module errors are parsed into readable text.
- Benchmark files moved into `input/benchmark/`. `npm run import:3-year` removed; the script file
  remains as a signpost that errors out with instructions.

---

## 4. Decisions the user made (don't silently revisit)

| Decision | Choice |
|---|---|
| Benchmark data location | One folder — `input/`, detected by content |
| SPY source | Real Yahoo closes only; reconstruction retired |
| Ticker universe | **Unified** — every tab uses all tickers |
| Provenance | Source-file reference only, no raw JSON per row |
| Python statistics | Spawned from the UI, not ported to TypeScript |
| Import button scope | Ingest only; analysis runs on demand |

---

## 5. Two data findings

**The reconstructed SPY series was redundant and wrong on 15 days.** `benchmark/SPY.json` already
held real Yahoo adjusted closes for exactly the same window (755 rows, same dates). 740 of 755 match
to eight decimal places; 15 disagree, worst is **2025-04-08: 518.74 reconstructed vs 489.59 real,
+5.95%**. Those errors land directly in the excess return of any trade touching those dates. The
pipeline now reads real closes from `benchmark_prices` by default. This does not invalidate the
original 11-close spot check — it means the least-squares solve has a few poorly-constrained days.

**The 27 / 187 / 223 ticker split was an accident of which glob each function referenced**, and was
invisible in the UI. Now unified at ~379.

---

## 6. Statistical posture — read before changing numbers

The discovery bar is **|t| ≥ 3.0 AND Holm-corrected p < 0.05**, pre-registered across the entire
48-cell grid as one family, with a 15-ticker cluster floor. Constants live at the top of
`pipeline.py`. **Do not lower the bar, drop the concentration/placebo diagnostics, or hide thin
cuts to make the page look more decisive.** Rows below the cluster floor are shown and flagged
"Too thin to trust" on purpose — the point is to make weak evidence visibly weak.

Current state on the unified data: 3 of 48 cells clear the bar (2 distinct trade sets), **but the
placebo control kills it** — observed mean 7.75pp against a random-ticker median of 9.16pp,
empirical p = 0.66. Random tickers on the same entry dates do at least as well. The page leads with
that, not with the big number.

Note also: several grid cells are exact duplicates (1% dip tolerance over a 63-day window rounds to
"no days below floor", identical to the strict cell). The UI reports distinct trade sets separately
from raw cell counts. The correction is left exactly as the pipeline computes it.

Other standing conclusions, now on ~2× the data: predictive accuracy 49.6% (CI 47.7–51.4, crosses
50), rating-call hit rate 40.0%, Strong Buy raw mean +1.01% but 10% trimmed mean **−0.38%** (sign
flip persists), top 10% of trades = 80% of profit.

---

## 7. SQLite gotchas — read before touching the database

**Never enable WAL.** On a Windows drive mounted into WSL (`/mnt/c/...`) and on FUSE mounts, SQLite
*accepts* `PRAGMA journal_mode = WAL`, accepts a probe write, serves a whole session — and then the
file cannot be reopened by the next process, because the header says WAL and the `-wal` can never
be check-pointed. This is what made the old 640 MB `analysis.sqlite` unreadable (216 MB orphaned
`-wal` beside it). Runtime detection does not work; the failure is deferred past every check you
can make. `schema.ts` now sets `TRUNCATE` unconditionally and explains why.

Also set, for the same environment: `synchronous = OFF` (a 170k-row insert is 1.3 s vs 3+ minutes),
`temp_store = MEMORY`, `cache_size = -64000`. Safe because every row is derived from a file in
`input/` — worst case is pressing Import again.

**Result-snapshot layer is off by default.** `server/db/runs.ts` writes ten result tables that
nothing has ever read (no `SELECT` against them exists anywhere). At 379 tickers it added 490 MB and
~40 s per data version. Gated behind `VANTAGE_PERSIST_RESULTS=1`.

**Repairing a corrupt DB when you can't delete files:** truncate in place —
`: > .data/vantage.sqlite` — then re-import. Deletion is blocked on some mounts; truncation isn't.

---

## 8. Sandbox quirks (if you're in the same environment)

- `rm` fails with `Operation not permitted` on the mounted folder. Truncate (`: > file`) instead.
- `vite build` fails at `emptyOutDir` for the same reason — build to `/tmp` to verify.
- `npx vite` fails to start because it can't unlink `node_modules/.vite`. Workaround used:
  ```
  cat > /tmp/vite.verify.config.mts <<EOF
  import base from '<abs>/vite.config.ts';
  export default { ...(base as any), root: '<abs>', cacheDir: '/tmp/vite-cache-verify' };
  EOF
  npx vite --config /tmp/vite.verify.config.mts --port 5199 --strictPort
  ```
- **Background servers do not survive between bash calls.** Start the server and run every curl in
  the *same* call, or you'll get empty responses and chase ghosts.
- No headless browser. Views were verified by SSR-rendering the component via
  `server.ssrLoadModule('/@fs/tmp/probe.tsx')` and stripping tags — good enough to check content,
  not layout.

---

## 9. Open items

**Left for the user** (sandbox can't delete):
- `benchmark/` — contents copied to `input/benchmark/`, old folder still present
- `input/zztest-prices.json`, `input/zztest-changes.json` — my end-to-end test fixtures; delete and
  re-import, they add a synthetic ZZTEST ticker
- `.data/analysis.sqlite*` — 640 MB + 216 MB of dead weight
- `dist/` is stale; `npm run build` on a normal filesystem fixes it

**Known gaps**
- Research results still travel as CSV rather than DB tables — the one asymmetry left in the
  raw/results split. Worth closing if the persistence layer is ever re-enabled.
- Tabs don't yet display which universe they used; unification made them all the same, but the plan
  recommended surfacing it.
- First `aggregate` request after a data change takes ~40 s (13 windows × 3 policies × 379
  tickers), then caches in memory. Not a problem, but noticeable.
- Import of all 417 files takes ~2 min, dominated by hashing and parsing the 94 MB bundle.
  Incremental imports are ~2.5 s.

**Verification commands that should stay true**
```
npx tsc -b                       # clean
npx vite build                   # clean
POST /api/data/import twice      # second: 0 imported, N unchanged, version unchanged
```
