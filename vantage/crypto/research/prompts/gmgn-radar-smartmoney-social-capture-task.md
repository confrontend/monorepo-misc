# Implementation task: store GMGN's radar/smart-money/wallet-rank/Twitter endpoints

**Status as of 2026-08-14: extension-side capture (the old "step 1") is already done — see
"Extension capture — already done" below before reading anything else. This task is now
backend-only: schema + import (steps 2-3).**

You are implementing a backend change to this local SQLite research app (`vantage/crypto`).
Read `CLAUDE.md` first and follow its `progress.md` logging rules exactly (append-only, log
after every meaningful action, no secrets).

## Background

Two "investigation sampling" exports (extension's discovery-only mode, see
`docs/GMGN_BROWSER_CAPTURE_HANDOFF.md`'s "Investigation sampling" section) were reviewed by hand
against a real logged-in GMGN session. Of ~70-85 endpoints seen, most are private
account/wallet/config plumbing (skip — see "Explicitly out of scope" below). A handful carry
genuinely new _public-ish_ market/social signal data this app does not capture yet:

| Endpoint                                                                    | What it is                                                                                                                                                                                                 | Captured by the extension?                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /vas/api/v1/radar/detail?chain=sol&period=1d&type=<category>`          | GMGN's own curated trending-token lists, keyed by category (`gold_dog` observed; others likely exist — probably surfaced as tabs/filters in the site's own "Radar" UI, confirm by watching the Radar page) | **Yes, as of extension v0.8.2** — added to `TARGET_PATHS`, but not yet actually seen in a _normal-mode_ export (only in investigation-mode samples). Confirm with a real normal-mode capture while visiting the Radar tab before writing the parser, or write it against the investigation-mode sample below and re-verify once a normal-mode sample exists.                    |
| `GET /api/v1/rank/sol/wallets/7d?orderby=pnl_30d&direction=desc`            | Public top-wallet leaderboard with per-wallet PnL/balance/activity stats                                                                                                                                   | **Yes, as of extension v0.8.2** — same caveat as `radar/detail`: added to `TARGET_PATHS`, not yet confirmed in a normal-mode export. Visit the wallet-leaderboard page while capturing to get a real sample before finalizing the parser.                                                                                                                                       |
| `GET /defi/quotation/v1/smartmoney/sol/walletNew/<wallet_address>`          | Per-wallet smart-money reputation stats (PnL, win rate, buy/sell counts, tags)                                                                                                                             | **Yes — resolved.** A real normal-mode capture on 2026-08-14 confirmed the live site calls `walletNew` (not the older `wallet/` path already in `TARGET_PATHS`); both entries are now present in `TARGET_PATHS` so nothing is missed, but **only build the parser against `walletNew`'s shape** — `wallet/` (no `New`) has never actually been observed firing and may be dead. |
| `GET /vas/api/v1/twitter/messages?has_token=...&user_tags=...&tw_types=...` | KOL/influencer Twitter activity feed (tweets/reposts/follows/etc.), tagged by user category (`kol`, `trader`, `celebrity`, ...)                                                                            | **Yes, as of extension v0.8.2** — added to `TARGET_PATHS`, not yet confirmed in a normal-mode export, and the `has_token=true` question below is still fully open.                                                                                                                                                                                                              |

Also already in `TARGET_PATHS` (captured today, just never parsed — see `otherCaptures` in
`src/gmgn/browserImport.ts`): `token_mcap_candles`, `token_trades`, `token_holder_stat`. Those
are a separate, smaller task (pure backend parsing, no extension change) — mention them in
`progress.md` as a follow-up but **do not implement them as part of this task** unless asked;
this task is scoped to the four endpoints in the table above.

## Real captured samples (verified against a live session, not invented)

**`radar/detail`** (`type=gold_dog`, `period=1d`):

```json
{
  "code": 0,
  "reason": "",
  "message": "success",
  "data": {
    "status": "success",
    "token": [
      {
        "address": "EUB1eZBt4m3X4FbperWnKGJdvLsuLMu2YmJix5yjpump",
        "symbol": "K-HOME",
        "logo": "https://gmgn.ai/external-res/....webp",
        "name": "bus house",
        "market_cap": "535592.01308691852"
      },
      {
        "address": "vFsy4Kz5dBQwHgrQfLBw7hfJizrG2KC1HrQ698Hpump",
        "symbol": "Fartcoin",
        "logo": "...",
        "name": "Fartcoin",
        "market_cap": "435763.21539848361"
      }
    ]
  }
}
```

Note: `radar/list` (the parent endpoint, presumably listing available `type` categories) returned
`{"data":{"list":[]}}` in both real captures — empty, so its real shape is still unconfirmed.
**Do not guess its schema.** Capture a non-empty sample before writing a parser for it; it's fine
to leave `radar/list` unimplemented for now and only implement `radar/detail`.

**`rank/wallets/7d`**:

```json
{
  "code": 0,
  "reason": "",
  "message": "success",
  "data": {
    "rank": [
      {
        "address": "4uCT4g7YHH4xxfmfNfKUDenwGrRNGoZ9Ay1XFxfUGhQG",
        "balance": "48.897126755",
        "buy": 4019,
        "buy_1d": 864,
        "buy_30d": 16986,
        "buy_7d": 4019,
        "avg_cost_1d": "37.78...",
        "avg_cost_7d": "32.45...",
        "avg_cost_30d": "28.69...",
        "avg_holding_period_1d": 6368.87,
        "avg_holding_period_7d": 22407.48,
        "avg_holding_period_30d": 28682.45,
        "daily_profit_7d": [{ "timestamp": 1786060800, "profit": "-1259.02..." }, "...6 more days"],
        "follow_count": 9720,
        "last_active": 1786681211,
        "name": "chingchong",
        "net_inflow_1d": "-79.59...",
        "net_inflow_30d": "45..."
      },
      "... more ranked wallets, get the full field list from a fresh capture"
    ]
  }
}
```

**`smartmoney/walletNew/<address>`**:

```json
{
  "code": 0,
  "msg": "success",
  "data": {
    "twitter_bind": false,
    "twitter_fans_num": 0,
    "twitter_name": null,
    "avatar": null,
    "name": null,
    "eth_balance": "0",
    "sol_balance": "0",
    "balance": "0",
    "total_value": 0,
    "unrealized_profit": 0,
    "realized_profit": 0,
    "pnl": 0,
    "pnl_1d": 0,
    "pnl_7d": 0,
    "pnl_30d": 0,
    "winrate": null,
    "buy": 0,
    "sell": 0,
    "buy_1d": 0,
    "sell_1d": 0,
    "buy_7d": 0,
    "sell_7d": 0,
    "buy_30d": 0,
    "sell_30d": 0,
    "tags": [],
    "tag_rank": {},
    "followers_count": 0,
    "last_active_timestamp": 0,
    "updated_at": null,
    "refresh_requested_at": null,
    "avg_holding_peroid": null
  }
}
```

(This sample is for a wallet with zero activity — fields are self-describing but you should
capture one sample for an _active_ wallet too, e.g. by looking up a `triggering_wallet` value
already present in `gmgn_signals`, before finalizing the normalized-field subset.)

**`twitter/messages`** (captured with `has_token=false`):

```json
{
  "code": 0,
  "reason": "",
  "message": "success",
  "data": [
    {
      "id": "88722828-846a-491a-9909-588dc8846abf",
      "platform": 0,
      "tw_type": "quote",
      "tweet_id": "2088128729675698408",
      "complete": 1,
      "tw_timestamp": "1786683659367",
      "user": {
        "twitter_user_id": "1577705091737432070",
        "screen_name": "yunta_tsai",
        "name": "Yun-Ta Tsai",
        "followers": 137181
      },
      "user_tags": ["kol"],
      "content": { "text": "Highest intelligence density 🧠" },
      "source_id": "2088121949738434659",
      "source_user": {
        "twitter_user_id": "...",
        "screen_name": "teslaeurope",
        "name": "Tesla Europe, Middle East & Africa",
        "followers": 175735
      },
      "source_content": {
        "text": "But wait, there's more",
        "media": [{ "type": "video", "url": "..." }]
      }
    }
  ]
}
```

**Important caveat, do not skip this:** the only real sample was captured with `has_token=false`
in the query string, meaning it was explicitly filtered to messages _not_ linked to a specific
token — i.e. general market chatter, not token-tagged signals. The endpoint's query params imply
a `has_token=true` mode almost certainly exists and would be far more useful (tweets tied to a
specific contract address), but it was never observed. **Capture a `has_token=true` sample from
a live session before building the ingestion path for this endpoint**, and check whether the
response items gain a token/contract-address field in that mode. If you cannot get a real
`has_token=true` sample, implement storage for the `has_token=false` shape only and leave a
clear `progress.md` note that the token-linked variant is unverified — do not guess its fields.

## Extension capture — already done

`extension/content-main.js`'s `TARGET_PATHS` already has all four paths (`radar/detail`,
`rank/sol/wallets/`, both `smartmoney/sol/wallet/` and `smartmoney/sol/walletNew/`,
`twitter/messages`) as of extension v0.8.2 (`extension/manifest.json`). A real normal-mode
capture (`gmgn-browser-capture-2026-08-14T05-20-44-554Z.json`) already confirmed
`smartmoney/walletNew` fires correctly end-to-end. **Do not re-add these to `TARGET_PATHS` or
bump the extension version for this task** — that part is done. What remains unconfirmed is
whether `radar/detail`, `rank/sol/wallets/7d`, and `twitter/messages` actually appear in a
normal-mode export (they've only ever been seen in investigation-mode samples, which use a
different capture path than the permanent one) — get a real normal-mode sample of each by
capturing while visiting GMGN's Radar tab, wallet leaderboard, and a KOL/Twitter panel, before
finalizing each one's parser. If a normal-mode sample can't be obtained for one of them, it's
fine to build the parser against the investigation-mode sample below and flag in `progress.md`
that normal-mode confirmation is still outstanding for that specific endpoint.

## What to build

### 1. Database schema (`src/db/schema.ts`)

Four new tables, one per endpoint, following the existing migration-array pattern exactly (see
the `'GMGN browser-extension capture import audit'` migration for the shape to copy). Each table
must store the **full raw response body** in a `raw_payload` column (this app's core invariant —
never store only normalized fields), plus a handful of indexed columns for querying:

- `gmgn_radar_snapshots`: id, chain, period, category (the `type` query param), captured_at,
  raw_payload, source_sha256 (dedup identical snapshots the same way other import paths do).
- `gmgn_wallet_rank_snapshots`: id, window (`'7d'`), orderby, captured_at, raw_payload,
  source_sha256.
- `gmgn_smartmoney_wallet_stats`: id, wallet_address, chain, captured_at, raw_payload,
  source_sha256. Consider a `(wallet_address, chain, captured_at)` index, not a uniqueness
  constraint — the same wallet will legitimately be captured multiple times over time and every
  observation should be kept (matches this app's append-only philosophy elsewhere).
- `gmgn_twitter_messages`: id, tweet_id, tw_type, has_token (boolean, from the query param used),
  captured_at, raw_payload, source_event_id (`tweet_id` + `id` from the payload, for future dedup
  if this becomes a recurring capture), source_sha256.

Do **not** merge any of this into `gmgn_signals` — these are structurally different data (not
signal events), and mixing them would break every existing consumer of that table (`patterns.ts`,
the outcome-measurement pipeline, etc.) which all assume a signal row.

### 2. Import module(s)

Extend `src/gmgn/browserImport.ts`'s capture-routing logic (the same `if
(capture.responseBody?.channel === ...)` / `requestPath.includes(...)` gating style already used
for `token_signal`) to recognize these four new `requestPath` patterns and route each capture's
`responseBody` into the matching new table via a small dedicated store function per type (e.g.
`storeRadarSnapshot`, `storeWalletRankSnapshot`, `storeSmartMoneyWalletStat`,
`storeTwitterMessage`), each living in its own small module under `src/gmgn/` (don't cram four
unrelated parsers into one file). Reuse the existing `imported`/`skipped`/`errors` counters and
`otherCaptures` fallback exactly as the `token_signal` path already does, so an export mixing
signal events and these new endpoint types produces one coherent import summary.

### 3. Server routes / UI

Do not build read/analysis routes or UI panels for this data yet — that's a separate, later task
once there's actual captured volume to look at. This task is capture-and-store only, matching
every prior capture-path task in this project (see `docs/GMGN_BROWSER_CAPTURE_HANDOFF.md`'s own
"Explicitly out of scope" section for the same principle applied to the original signal importer).

## Required correctness checks before you consider this done

1. `smartmoney/walletNew` is already confirmed via a real normal-mode capture — no further
   verification needed for that one. For `radar/detail`, `rank/sol/wallets/7d`, and
   `twitter/messages`, get a real normal-mode capture (not just the investigation-mode samples
   quoted above) before finalizing each parser; note in `progress.md` which of the three you
   managed to confirm this way and which you did not.
2. The `smartmoney/wallet/` vs `walletNew/` question is resolved (`walletNew` is live) — just
   build the parser against `walletNew`'s shape and note in `progress.md` that you did so.
3. Confirm the `twitter/messages` `has_token=true` question explicitly in `progress.md` — either
   you captured and handled it, or you documented that it remains unverified and scoped it out.
4. Write tests for each new store function (malformed/empty `raw_payload` handling, dedup-by-hash
   where applicable) mirroring `tests/gmgn-browser-import.test.ts`'s existing structure — build
   fixtures from the **real captured shapes above**, not invented ones.
5. Confirm the existing `token_signal` import path and its tests are unaffected — run the full
   suite, don't just add new tests.
6. Run `npx tsc -b --noEmit` and `npm test` and report actual pass/fail counts in `progress.md`.

## Explicitly out of scope

- `vas/api/v1/twitter/user/remark` and `vas/api/v1/follow/multi_chain_follow_wallet_trade_list` —
  both are the _logged-in user's own_ private data (accounts they've personally annotated,
  wallets they've personally chosen to follow), not general market/signal data. Do not capture
  or store these; capturing them would violate this project's existing "no personal data beyond
  raw signal payloads" principle.
- `radar/list` — schema unconfirmed (only an empty response was ever observed). Do not implement
  a parser from a guess.
- Any endpoint requiring the user's own account/wallet identity (`account/user_info`,
  `account/otp/*`, `tapi/v1/wallet/list`, `pf/api/v1/wallet/.../holdings`, etc.) — out of scope
  entirely, not just for this task.
- No scoring, no linking these new tables to `gmgn_signals` rows automatically (e.g. "this tweet
  mentions this token, therefore attach it to signal X") — that inference is a separate, much
  more carefully-scoped future task if ever done at all. This task only stores what was actually
  returned, verbatim.
- `token_mcap_candles` / `token_trades` / `token_holder_stat` parsing (already captured, never
  parsed) — real and worth doing, but a separate task; do not fold it into this one.
