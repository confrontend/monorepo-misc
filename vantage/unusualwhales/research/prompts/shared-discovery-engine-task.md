# Task: shared pattern-discovery engine — inspection and readiness gate first, engine second

Read `CLAUDE.md` and `AGENTS.md` in each repository you touch, and follow them — including the
append-only `progress.md` entry in whichever project you change.

This task spans two sibling repositories under `C:\Code\monorepo-misc\vantage\`:
`unusualwhales` and `crypto` (GMGN). **Do not merge them. Do not create any feature, model,
correlation, or result that combines data from both.** The engine is shared code and shared
statistical method only; every dataset, run, and report stays inside its own project.

```
GMGN data   → shared engine → GMGN discoveries only
UW data     → same engine   → UW discoveries only
```

---

## The goal

Blind, systematic discovery of relationships and feature combinations that make signals stronger
or weaker — followed by deterministic verification that those relationships are real, repeatable,
and materially useful on unseen data.

Not: manually guessing thresholds like `premium > $500k AND DTE < 30`. Human hypotheses can also
be tested, but automatic discovery is the point.

Not: building an ML system for its own sake. ML output is **discovery evidence, never proof**.

---

## Phase 0 — Readiness gate. Do this first and stop for review.

Blind discovery multiplies false findings faster than any other technique in this codebase, and
both projects have already produced confident nonsense under weaker methods. **Do not build the
engine until you have reported the following and had it reviewed.** Deliver it as a written
findings document, not code.

### 0.1 — Inventory the real features and outcomes

Inspect both repositories and list what genuinely exists, with file references. Do not work from
the example lists below — they are hypotheses about what might be there.

Known starting points, to verify rather than trust:
- UW: `src/research/signal-catalog.ts` registers ten signals; `src/research/option-features.ts`
  exposes `premium`, `size`, `openInterest`, `price`, `nbboBid`, `nbboAsk`, `strike`,
  `underlyingPrice`, `expiry`, `executedAt`, plus raw payload/flags/tags.
- GMGN: features live across `src/copytrade/*` and `src/db/*`; outcome horizons are
  `5m/10m/15m/30m/45m/1h/6h/24h/3d/7d`; UW's are `1d/3d/5d/10d/20d`. They barely overlap, which
  is fine — the contract must not require every horizon.

### 0.2 — Point-in-time safety: an allow-list, not a warning

This is the failure mode that produces the most spectacular fake results, because a leaked future
value is by construction the strongest predictor in any dataset — blind discovery will find it
first and rank it highest.

Real precedent in these repos, both confirmed live:
- GMGN's `query_cur_data` fields are query-time snapshots that drift depending on when they were
  fetched; treating them as "conditions at signal time" is unsafe.
- GMGN's `avg_holding_period` from the stats endpoint diverged from the true median hold by three
  to four orders of magnitude (e.g. 2,869 minutes reported vs 0.2 minutes actual).
- UW's `dte` must be derived from `executedAt` → `expiry`. Computing it from "now" silently leaks.

**Requirement:** features are **opt-in**. Each project's config allow-lists a feature only with a
recorded one-line justification for why it is knowable at event time. Anything not allow-listed is
excluded by default. Report every field you examined and rejected, and why.

### 0.3 — Prove the input is clean enough to discover on

For each project, report:
- **Outcome coverage** — what fraction of events have a matured, usable outcome per horizon.
- **Whether missingness is random.** Compare the distribution of a *known-at-event-time* value
  between events that have outcomes and those that do not. If they differ materially, missingness
  is biased and any model will partly learn the missingness rather than the market.
- **Whether the entity pool is survivorship-filtered** — i.e. whether entities were selected using
  information from after the discovery window.

Two verified facts to carry into this analysis rather than rediscover:
- GMGN median Dune outcome coverage is about **54.5%**; only ~30 of 113 wallets clear a
  30-trade / 70%-coverage bar.
- GMGN coverage gaps are **not random**: unmatched trades are roughly **twice as likely** to be
  >100% winners (20.5% vs 12.1%), because Dune fails to match on thin, new tokens — exactly where
  the outsized moves occur. Losses are unaffected (3.5% vs 3.2%).
- GMGN roster snapshots begin 2026-08-14, so every wallet currently in the pool survived to that
  date.

**Gate:** if a project's coverage is low *and* biased, say plainly that blind discovery there will
produce confident nonsense, and recommend deferring that project rather than proceeding. UW is
further along — it already has walk-forward with frozen windows, five horizons, and 10/25/50 bps
cost scenarios (`unusualwhales/progress.md`, 2026-08-21). **Expect to recommend building against
UW first and letting GMGN catch up on coverage.** Do not treat starting both at once as the
default.

### 0.4 — Propose the contract, with one real row from each project

Propose the normalized analytical dataset. Starting shape, to adapt to what actually exists:

```
event_id, event_time, entity_id, signal_type,
<project-specific allow-listed features>,
<the horizons that project actually has>,
benchmark_return, excess_return, net_return_after_costs,
mature, usable, independence_group
```

Show **one real row from each project**, taken from the live database, with values — not a
schema sketch. If a field cannot be populated from real data today, say so rather than inventing
a plausible value.

`independence_group` matters: repeated related events are not independent samples. One wallet
buying the same token 42 times is not 42 observations. Domain-specific dedup stays inside each
project; the engine only honors the grouping it is given.

**Stop here for review.** Do not begin Phase 1 until the readiness report is approved.

---

## Phase 1 — The engine (only after Phase 0 is approved)

### Architecture

A **shared Python package with a CLI**, consumed independently by each project:

```
project → export normalized dataset → run discovery CLI → project-local report
```

Python is justified specifically to stop hand-rolling statistics: the crypto repo already
contains bespoke `holmCorrection`, `bootstrapMedianCI`, and `signTest` implementations, which is
what scipy/statsmodels/sklearn exist to replace. Use pandas, numpy, scipy, statsmodels,
scikit-learn, and SHAP where genuinely useful.

No service, no daemon, no shared database. The export boundary is where bugs will live — make the
CLI validate its input contract loudly and refuse to run on a malformed or unexpected dataset
rather than silently coercing it.

### What the shared engine owns

Correlation discovery (Pearson, Spearman, mutual information, categorical group differences),
automatic quantile/bucket analysis, tree-ensemble feature discovery, permutation importance,
interaction discovery, subgroup discovery, shallow-tree rule extraction, statistical validation,
pattern ranking, and the common report format.

### What stays in each project — do not move these

API ingestion, database schemas, signal creation, price collection, outcome calculation,
point-in-time safety enforcement, deduplication, and project-specific bias protections.

### Discovery and verification must be separate

```
discovery window → candidates → validation window → untouched final holdout
```

The final holdout is never touched during discovery or during any iteration on method. If you
look at it twice, it is no longer a holdout — say so in the report rather than quietly reusing it.

### Multiple-testing protection — be precise about what applies where

The four available protections are **not interchangeable**, and conflating them is itself a
reporting error:

- **FDR control requires a countable denominator.** Apply it to the enumerable searches —
  pairwise correlations, bucket scans, categorical comparisons — and report the count of
  comparisons made alongside the corrected values.
- **A tree ensemble or SHAP interaction search has no countable hypothesis space.** FDR cannot be
  honestly applied to a tree-extracted rule. For these, the real protection is
  **validation-survival plus the untouched holdout**, and the report must say so rather than
  attaching a corrected p-value that means nothing.
- **Bootstrap confidence intervals** and **stability across time windows** apply to both and
  should accompany every promoted pattern.

### Ranking must penalise fragility, not just reward effect size

Prefer adequate sample size, meaningful effect size, simple rules, and stability. Penalise tiny
groups, over-specific conjunctions, and results carried by a handful of extreme winners. Report,
for every candidate, **what share of the total effect comes from its top few observations** — a
pattern whose entire edge rests on three trades must be visibly distinguishable from one built on
four hundred, even at identical average return.

### Materiality, not just significance

A pattern is only interesting if it survives trading costs, beats its benchmark, rests on an
adequate sample, and has tolerable drawdown/tail behaviour. Report net-of-cost figures as the
headline; gross is supporting detail.

### Output

Machine-readable patterns that a deterministic backtest can consume directly:

```json
{
  "conditions": [
    { "feature": "premium", "operator": ">", "value": 430000 },
    { "feature": "dte", "operator": "<=", "value": 35 }
  ],
  "outcome": "net_return_1d",
  "sampleSize": 384,
  "winRate": 0.64,
  "averageReturn": 0.014,
  "medianReturn": 0.008,
  "validationStatus": "candidate"
}
```

`validationStatus` must distinguish at minimum: **discovered candidate**, **validation survivor**,
**rejected**, and **insufficient data**. The last is not a failure — it means not enough matured
outcomes yet, and it must never render the same as a tested-and-failed pattern.

### V1 scope — build exactly this, then stop

1. Normalized input contract with loud validation
2. Per-project feature configuration (allow-list with justifications)
3. Descriptive feature summaries
4. Pearson / Spearman correlation
5. Mutual information
6. Automatic bucket/quantile analysis
7. One tree ensemble (Random Forest or Gradient Boosting)
8. Permutation importance
9. Shallow decision-tree rule extraction
10. Minimum-N filtering, configurable and prominently reported
11. Chronological discovery/validation split
12. JSON discovery report
13. The four-way `validationStatus` distinction above

SHAP, interaction search, and richer subgroup algorithms come later.

---

## Requirements

- **Never claim an ML-discovered relationship is profitable** until independent validation on
  unseen data confirms it. Language in reports must reflect that.
- **Never treat missing as zero.** An unmatured outcome is absent.
- Every reported figure carries its sample size and coverage.
- Isolation must be demonstrable: show that a GMGN run and a UW run share no state, no cache, no
  output path, and no fitted model.
- If correction and validation eliminate every promising pattern, that is a valid and important
  result. Report it plainly rather than loosening gates until something survives.

## Verification

- Unit tests for each statistical component, including a hand-computed correction example and a
  test proving that scanning more cells makes any single cell harder to promote.
- A test proving `insufficient` and `rejected` are distinguishable end-to-end.
- Run the CLI on real exported data from **one** project and paste real counts — candidates found,
  validation survivors, rejected, insufficient — into your progress entry.
- Each repo's own suite stays green: run `npm test` in whichever project you modify and confirm
  your starting baseline first rather than trusting a number written here.

## Out of scope

No cross-project features, models, or comparisons. No changes to ingestion, outcome calculation,
or point-in-time logic in either project. No trading, ordering, or execution capability of any
kind — this produces descriptive research only.

Append your `progress.md` entry before finishing.
