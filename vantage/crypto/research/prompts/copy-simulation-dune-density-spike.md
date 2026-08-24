# Task: Spike — is Dune's trade data dense enough to simulate a copier's entry price?

Read `CLAUDE.md` first and follow it, including the append-only `progress.md` entry.

This is a **measurement spike, not a build task**. Its only output is a go/no-go finding. Do
not write any simulation engine, UI, or new schema as part of this task — that is a separate,
larger follow-on (`Historical Copy Simulation`, proposed but not yet approved) that is
explicitly gated on what this spike finds.

## Background

A proposal exists to add a "Historical Copy Simulation" feature: for each stored GMGN trade
by a top trader, apply a configurable copier delay (proposed default 15s), then use "the
nearest qualifying Dune trade after that delayed timestamp" as the price a copier would
actually have gotten. The rest of the proposal (fees, slippage, missing-price handling,
Dune-usage efficiency via dedup/archiving) is sound and reuses this project's existing
dedup/provenance conventions — see `src/dune/outcomes.ts` and `gmgn_wallet_rank_capture_provenance`
for the established pattern. This spike is about validating the one assumption everything else
depends on.

**The risk:** GMGN signals are mostly thin, fast-moving, newly-launched tokens. "Nearest Dune
trade after the delayed timestamp" is only a meaningful proxy for a copier's real entry price if
that nearest trade is actually close in time. If Dune's trade coverage for these tokens is
sparse, or if the token has already moved on by the time Dune's next indexed trade appears, the
simulation would silently pick a stale price — biasing results toward whichever trades happen to
sit near a liquid moment, not toward what a real copier following in real time would have
gotten. This has **not been measured** — it's a plausible mechanism, not a confirmed one.

This project has also already found a related, distinct timing issue once before — see
`research/prompts/premature-query-indexing-lag-bias-task.md` (Dune's own indexing lag behind
the trades it has actually recorded). That investigation is about a different question
(whether a `received` checkpoint reflects Dune's _complete_ index at query time); this spike is
about _density_ — how far apart in time Dune's recorded trades for a given token actually sit,
independent of any indexing-lag question. Read that file for the established measurement
conventions in this codebase, but do not touch its code paths.

## What to measure

1. **Build a real sample, not synthetic data.** Pull stored GMGN trades for the current top
   copy-candidate wallets (see `src/copytrade/copyCandidates.ts` / the live `/api/copytrade/winners`
   route for who currently qualifies) — at least 100 trades, spanning a spread of token ages and
   apparent liquidity (use `query_cur_data`/`raw_payload` fields already captured, not guesses).
2. **For each sampled trade**, apply the proposed 15s delay to the wallet's observed timestamp,
   then query Dune for that token's trades in a narrow window after the delayed timestamp (reuse
   `src/dune/outcomes.ts`'s existing query-building conventions; do not hand-roll a new SQL
   pattern). Record the time gap between the delayed timestamp and the nearest trade Dune
   actually returns — and separately, whether _any_ trade is returned at all within a generous
   outer bound (e.g. 30 minutes), so "no coverage" is distinguishable from "coverage, but far".
3. **Report the distribution**, not just an average: median gap, p90, max, and the fraction of
   trades with zero Dune coverage at all in the outer bound. Break it out by token age at signal
   time (e.g. `<1h`, `1-24h`, `>24h` — same buckets already used elsewhere in this codebase) since
   age is very likely to predict liquidity/coverage density.
4. **State a go/no-go recommendation** grounded in that distribution:
   - If gaps are consistently small (say, sub-60s at the median, sub-5min at p90) — the proposal's
     "nearest trade" approach is sound as specified; report the numbers and clear it to build.
   - If gaps are large or coverage is frequently missing, especially for young/thin tokens —
     say so explicitly, and recommend either (a) an explicit staleness gate (mark the trade
     `missing` rather than using a stale nearest match beyond some threshold — do not just
     pick a threshold arbitrarily; base it on where the measured distribution actually breaks),
     or (b) narrowing the simulation's scope to token ages where coverage is actually usable.

## Constraints

- **Read-only.** Query Dune for measurement only — do not write any new outcome/comparison
  rows, do not touch `dune_outcome_runs`, `copytrade_trades`, or any existing table's data.
  Reuse existing dedup/archive plumbing so this spike's own queries don't create duplicate or
  wasted Dune calls, and don't compete with any in-flight production Dune usage.
- **No pipeline code.** Do not build the simulation engine, new schema, or UI regardless of what
  the numbers show — that is the follow-on task, contingent on this spike's finding.
- **Evidence first.** This project has repeatedly found assumed timing problems didn't
  reproduce once actually measured (see `progress.md`'s 2026-08-14 entries) — and, just as
  often, found real ones. Report exactly what the sample shows either way; do not round toward
  the answer that makes the bigger feature easier to approve.
- Update `progress.md` per this repo's `CLAUDE.md` convention (append-only, agent name/model,
  files touched, decision + reason, test result if any code was written for the measurement
  itself, next step — which is either "cleared to build the full proposal" or "build should
  change scope/threshold because of X").
