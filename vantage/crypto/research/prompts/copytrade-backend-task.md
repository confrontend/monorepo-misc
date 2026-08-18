# Task (Backend): CopyTrade — fetch, persist, and evaluate top-trader trade history

You are the **backend** agent. A **frontend** agent is working in parallel from
`copytrade-frontend-task.md`. You own the server, database, and analysis. You must **not**
touch `ui/main.tsx` or `ui/styles.css` — those belong to the frontend agent.

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

---

## Goal

Add a `CopyTrade` feature that answers one question: **if we had copied a top-ranked GMGN
trader's trades, what would $100 have become?**

Three steps, all server-side:

1. **Fetch** — pull each top trader's full trade history from the official GMGN API.
2. **Persist** — store every trade append-only in SQLite.
3. **Evaluate** — compute per-trader median / average return and the ending value of $100,
   plus a pass/fail "should you copy this person" verdict.

---

## Background you need (already verified — do not re-derive)

**The trade-history endpoint works today with the existing key.** Confirmed live:

```bash
GMGN_API_KEY="$(tr -d '\r\n' < .secrets/gmgn/gmgn-api-key.txt)" \
  node node_modules/gmgn-cli/dist/index.js portfolio activity \
  --chain sol --wallet <addr> --type buy --type sell --limit 5 --raw
```

Returns `{"activities":[ ... ]}`. Each activity row carries:

| Field | Meaning |
|---|---|
| `wallet`, `chain`, `tx_hash` | identity |
| `timestamp` | Unix seconds |
| `event_type` | `buy` / `sell` / `transfer_in` / `transfer_out` |
| `token.address`, `token.symbol` | the token |
| `token_amount`, `quote_amount` | sizes |
| `cost_usd` | USD value of this leg |
| `buy_cost_usd` | **on sells only** — the original cost basis of what was sold |
| `price_usd` | per-token USD price |
| `gas_usd`, `dex_usd`, `priority_fee`, `tip_fee` | costs |
| `launchpad_platform` | e.g. `Pump.fun` |

`buy_cost_usd` on a sell is what makes per-trade return computable directly:
`return = (cost_usd - buy_cost_usd) / buy_cost_usd`.

**Rate limits** (from `node_modules/gmgn-cli/skills/gmgn-portfolio/SKILL.md`, authoritative):
leaky bucket `rate=20`, `capacity=20`; `portfolio activity` has **weight 3** → roughly
**6.7 requests/second sustained**. On HTTP 429 the body carries `reset_at` (Unix seconds).
**Retrying during a cooldown extends the ban by 5s each time, up to 5 minutes.** Implement
strict backoff: on 429, stop that wallet, honor `reset_at`, never spam.

**Auth:** `portfolio activity` needs `GMGN_API_KEY` only. **Never configure, request, or use
`GMGN_PRIVATE_KEY`.** Never call `swap`, `cooking`, `order`, or any trade-submitting command.
This feature is read-only and must stay incapable of moving funds.

**The trader roster** comes from `gmgn_wallet_rank_snapshots` (already in the database, 2 rows,
100 wallets each). Parse `raw_payload.data.rank[]`; each item has `wallet_address`, `name`,
`pnl_30d`, `winrate_30d`, `realized_profit_30d`, `txs_30d`, and `tags[]`.

---

## Follow existing patterns — do not invent new ones

- **CLI invocation:** copy the shape in `src/gmgn/capture.ts:38-48` — `execFile` against
  `node_modules/gmgn-cli/dist/index.js` with `GMGN_API_KEY` injected via `env`, `windowsHide: true`,
  a timeout, and a generous `maxBuffer`. The key must never reach SQLite, logs, or an archive.
- **Credentials:** reuse `src/gmgn/credentials.ts`'s `keyPath` convention. Never log the secret.
- **Raw storage:** reuse `snapshotPayload` / `insertByHash` / `asOptionalString` from
  `src/gmgn/rawSnapshot.ts` where they fit.
- **Migrations:** append-only, at the end of the list in `src/db/schema.ts`. Never edit an
  applied migration — see the comment at `schema.ts:334` explaining exactly why that broke before.
- **Archiving:** if you archive raw responses, follow `src/gmgn/archives.ts` + the
  `zipStored` + SHA-256 + manifest pattern already used by `captureGmgnSignals`.

---

## Hard lessons from this repo that apply directly

These are real bugs already paid for. Do not repeat them.

1. **Median, not average.** One outlier once made a group show +111% average while its median
   was −44%. Report both, but the verdict must key off median.
2. **`tx_hash` is not a unique row key.** One Solana transaction can contain several DEX legs.
   The Dune tie-break bug (`progress.md` entries 44–49) was exactly this. Your dedup key must
   include more than `tx_hash`.
3. **Don't measure immature data.** Dune's Solana tables lag; 80% of early checkpoints changed
   on re-run. If you verify against Dune, only trust rows older than 24h.
4. **Deterministic ordering.** Any SQL you send to Dune must have a total-order `ORDER BY`.
5. **Gate by endpoint before parsing.** `browserImport.ts` once ran every capture through the
   signal parser. Be explicit about what you parse.

---

## Work to do

### 1. Schema (`src/db/schema.ts`, new append-only migrations)

```sql
CREATE TABLE copytrade_wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  name TEXT,
  source_snapshot_id INTEGER,        -- gmgn_wallet_rank_snapshots.id
  rank_position INTEGER,
  reported_pnl_30d TEXT,             -- keep source values verbatim as TEXT
  reported_winrate_30d TEXT,
  risk_flags TEXT,                   -- JSON array, e.g. ["wash_trader"]
  added_at TEXT NOT NULL,
  UNIQUE(wallet_address, chain, source_snapshot_id)
);

CREATE TABLE copytrade_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet_address TEXT NOT NULL,
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  event_type TEXT NOT NULL,
  token_address TEXT NOT NULL,
  token_symbol TEXT,
  observed_timestamp INTEGER NOT NULL,   -- Unix seconds, from source
  token_amount TEXT,
  cost_usd TEXT,
  buy_cost_usd TEXT,
  price_usd TEXT,
  gas_usd TEXT,
  dex_usd TEXT,
  launchpad_platform TEXT,
  raw_payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  dedup_key TEXT NOT NULL UNIQUE
);
CREATE INDEX idx_copytrade_trades_wallet ON copytrade_trades(wallet_address, observed_timestamp);

CREATE TABLE copytrade_fetch_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,              -- running | completed | failed | rate_limited
  wallet_total INTEGER NOT NULL,
  wallet_done INTEGER NOT NULL,
  trades_fetched INTEGER NOT NULL,
  requests_made INTEGER NOT NULL,
  rate_limited_until TEXT,
  error TEXT
);

CREATE TABLE copytrade_result_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  computed_at TEXT NOT NULL,
  params_json TEXT NOT NULL,
  report_json TEXT NOT NULL
);
```

`dedup_key` = `wallet|tx_hash|token_address|event_type|token_amount|observed_timestamp`.
This handles the multi-leg-per-transaction case. Insert with `INSERT OR IGNORE` so re-fetching
an overlapping window is a safe no-op.

Update `tests/schema.test.ts`'s expected table list.

### 2. Roster (`src/copytrade/roster.ts`, new)

Read the newest `gmgn_wallet_rank_snapshots` row, parse `data.rank[]`, upsert into
`copytrade_wallets`. Derive `risk_flags` from `tags[]` — at minimum flag `wash_trader`.

### 3. Fetcher (`src/copytrade/fetch.ts`, new)

For each selected wallet, page `portfolio activity` with `--cursor` until `next` is empty or
the period window is exhausted. Respect the rate budget (weight 3, ≤ ~6 concurrent-equivalent
per second — a simple serial loop with a small delay is fine and safer). Persist each page's
rows immediately so a 429 mid-run never loses completed work. Update `copytrade_fetch_runs`
as you go so the frontend can poll progress.

### 4. Evaluation (`src/copytrade/evaluate.ts`, new)

Pair each `sell` with its own `buy_cost_usd` to get a per-trade return. Then compute per wallet:

- `trades` — number of completed (sell) trades used
- `winRatePercent` — share of trades with return > 0
- `medianReturnPercent`, `averageReturnPercent`
- `endingCapitalUsd` — start at $100 and **compound** each trade's return in timestamp order.
  Round to cents. Floor at 0.
- `verdict` — `yes` only if **all four** pass:
  `trades >= 100`, span `>= 7` days, `medianReturnPercent > 0`, and no risk flags.
  Otherwise: `flagged` if risk flags exist, `thin` if the sample gates fail, else `no`.
- `failedRules` — machine-readable list of which gates failed.

Also compute an `overall` row across all wallets using the same functions — do not write a
second implementation (this repo has been bitten by two implementations drifting apart).

Add a `POST /api/copytrade/results/snapshot` that freezes the current report into
`copytrade_result_snapshots`, mirroring `signal_pattern_snapshots`.

### 5. Routes (`src/scripts/server.ts`)

Implement exactly the contract in the next section.

---

## API contract — IMPLEMENT EXACTLY (the frontend is coded against this)

```
GET /api/copytrade/summary
→ { traders: number, trades: number, historyDays: number,
    verifiedPercent: number | null, lastRunAt: string | null }

POST /api/copytrade/fetch
   body: { limit: number, periodDays: number }
→ { runId: number, status: "running" }
   409 if a run is already active.

GET /api/copytrade/fetch/status
→ { running: boolean, runId: number | null, walletDone: number, walletTotal: number,
    tradesFetched: number, rateLimitedUntil: string | null,
    status: "idle" | "running" | "completed" | "failed" | "rate_limited",
    message: string }

GET /api/copytrade/results
→ { computedAt: string, startingCapitalUsd: 100, periodDays: number,
    rows: Array<{
      walletAddress: string, name: string | null, trades: number,
      winRatePercent: number | null, medianReturnPercent: number | null,
      averageReturnPercent: number | null, endingCapitalUsd: number | null,
      verdict: "yes" | "no" | "thin" | "flagged",
      riskFlags: string[], failedRules: string[]
    }>,
    overall: { trades: number, winRatePercent: number | null,
               medianReturnPercent: number | null, averageReturnPercent: number | null,
               endingCapitalUsd: number | null },
    rules: { minTrades: number, minDays: number, requiresPositiveMedian: boolean } }

POST /api/copytrade/results/snapshot
→ { snapshotId: number, computedAt: string }
```

Every numeric field is nullable — return `null` for "not computable", never `0` or a guess.
An empty database must return a valid, empty-but-well-formed payload, not a 500.

---

## Verification required before you report done

- `npx tsc -b --noEmit` clean.
- `npm test` passing, with new tests for: dedup key behavior on a repeated fetch, median vs
  average on an outlier-heavy fixture, the $100 compounding math, and each verdict gate.
- **Run the real fetch against at least one real wallet** and report actual row counts.
  Use `4uCT4g7YHH4xxfmfNfKUDenwGrRNGoZ9Ay1XFxfUGhQG` — it is real, high-volume, and
  `wash_trader`-flagged, so it exercises the flagged path.
- Curl every route and paste the real responses into your progress entry.

## Out of scope

No UI. No trading. No autonomous scheduling. Dune verification is a **later** step — design
the schema so it can be added, but do not build it now.

Append your `progress.md` entry before finishing.
