# Top Callers UX Review

**Status:** Review-ready proposal  
**Scope:** `#copytrade/top-callers` only  
**Purpose:** Make the page answer one question: _which tracked GMGN caller currently has the strongest measured outcome?_

## Executive assessment

The current page has the right data, but the interaction model is still too operational. A user sees a refresh action, an end-to-end workflow action, a Dune measurement action, and raw GMGN controls in the same visual area. The page makes the user infer which action is primary and whether “selected caller” controls measurement. The current design also mixes three different concepts:

1. **Source collection** — GMGN leaderboard and wallet history.
2. **Measurement** — Dune historical checkpoints.
3. **Decision view** — which caller has the best measured outcome.

The page should make the decision view dominant and make collection a single guided operation. Raw evidence remains available, but it should not compete with the result.

## Findings from the current implementation

### 1. Too many visible actions

The page exposes `Refresh saved results`, `Run complete caller research`, and `Measure all tracked callers (N)` in the main flow. The advanced section also exposes `Capture leaderboard` and `Fetch caller history`. These are overlapping operations from the user's perspective.

**Risk:** users can start an incomplete sequence, repeat a request, or wonder which button is authoritative.

**Recommendation:** keep exactly one primary action: **Run caller research**. Keep refresh as a quiet text link only when the page is not running. Move all manual collection actions into an “Advanced evidence” disclosure, and label them as diagnostic overrides.

### 2. The selected caller is misleading

The caller selector looks like a filter for the Dune run, but it only changes the detail summary. The Dune operation measures all matured pending checkpoints for all tracked callers.

**Recommendation:** rename it to **Inspect a caller** and place it below the automatic best-performer summary. Add helper text: “Viewing only; it does not change the research run.”

### 3. Tracking state is not prominent enough

The raw leaderboard table contains a `Track`/`Tracking` button, but the main result does not clearly state how many callers are included in the run or which callers are excluded.

**Recommendation:** show a compact scope line near the primary action:

> Research scope: 25 tracked of 100 captured · 25 included in the next run

The raw table should show a clear status badge (`Included`, `Not included`) rather than relying on a small button. The automatic workflow should state that it selects the top 25 by rank for the run.

### 4. Two GMGN actions are conceptually redundant

The current implementation captures leaderboard and caller history through the same real GMGN source path in the current backend. Presenting them as separate first-class actions suggests two independent sources when they are one collection operation with different stored views.

**Recommendation:** present the source step as **Collect GMGN caller snapshot**. Internally it may persist leaderboard rows and wallet activity separately, but the user should not need to understand that split.

### 5. Raw tables are stacked and difficult to scan

The leaderboard table and long call-history table sit one after another under the disclosure. Long addresses, raw prices, and repeated checkpoint columns create horizontal scrolling and push the useful result far down the page.

**Recommendation:** do not show both tables by default. Use a compact evidence navigator:

- **Caller roster**: rank, short caller ID, calls, included/excluded status.
- **Call evidence**: shown only after choosing a caller, with token symbol, call time, GMGN price, and one compact outcome status.

The complete raw payload should be available through an archive/download link or an expandable row, not as a full-width table by default.

### 6. The best summary and inspected detail can disagree visually

The page now computes a best performer automatically, but the detailed panel may still show another caller because the inspection selector retains its previous value. This makes the page look like it is reporting two different winners.

**Recommendation:** default the inspection view to the automatic best caller after every completed measurement. If the user manually chooses another caller, show a visible `Inspecting: ...` label and keep the best summary unchanged.

### 7. Loading and terminal states need one place

The page can show workflow stage text, collection status, cooldown banners, and operation panels simultaneously. This is informative but visually noisy.

**Recommendation:** use one run-status banner with a stage indicator:

```text
RUNNING · Step 3 of 4 · Fetching GMGN caller history
Completed steps: leaderboard ✓ · tracking ✓
Next: Dune checkpoint measurement
```

On completion, replace it with:

```text
COMPLETE · 25 callers reviewed · 18 had matured Dune outcomes · best: <caller>
```

Rate limits and failures should use the same banner with a clear “stopped at step” message.

## Proposed default layout

```text
TOP CALLERS
Which caller performed best?

[ Run caller research ]
Collect GMGN → include top 25 → measure matured Dune checkpoints

RUN STATUS
Idle / Step 2 of 4 / Complete / Stopped at GMGN cooldown

RESEARCH SCOPE
25 included · 75 captured but not included · last run <time>

BEST MEASURED CALLER
<caller>                         +$<value> from $100
Median <x>% · Win rate <y>% · <n> measured calls · <coverage>% coverage

OUTCOME BY CHECKPOINT
<compact timeline or bars for +1h, +6h, +24h, 3d, 7d>

[ Inspect a caller ▼ ]
Caller detail for the selected caller

▸ Advanced evidence and manual controls
  ▸ Caller roster (compact table)
  ▸ Call evidence (only for inspected caller)
  ▸ Raw archives and diagnostic statuses
```

## Button and terminology changes

| Current label                   | Proposed label                             | Reason                                        |
| ------------------------------- | ------------------------------------------ | --------------------------------------------- |
| Run complete caller research    | **Run caller research**                    | Single user goal; shorter and clearer         |
| Refresh saved results           | **Refresh** (quiet link)                   | Not a research step                           |
| Measure all tracked callers (N) | Move under run status / advanced controls  | It is one internal stage of the main workflow |
| Capture leaderboard             | Collect GMGN caller snapshot               | Reflects the combined source operation        |
| Fetch caller history            | Hide by default; retain as manual override | Prevents incomplete sequences                 |
| Selected caller                 | Inspect a caller                           | Makes it clear this changes the view only     |
| Track / Tracking                | Included / Not included                    | Makes run scope obvious                       |

## Data and behavior rules

- Never hide whether a caller is included in the next run.
- Never imply that inspection selection changes the Dune batch scope.
- Do not display a “best caller” until there is at least one measured outcome; show `Waiting for measured outcomes` instead.
- Rank the best caller using the existing reliability-first ordering, then median return, win rate, and measured sample size.
- Keep missing checkpoints as `pending` or `unavailable`; never turn them into zero.
- Preserve all raw GMGN and Dune evidence in SQLite and archives, even when it is hidden from the default UI.
- A failed or rate-limited run must leave the page in an explicit stopped state, never an apparently idle state.

## Acceptance criteria for implementation

1. One visually dominant action starts the complete workflow.
2. No more than one quiet refresh link is visible outside advanced evidence.
3. The first screen shows scope, run status, and best measured caller without scrolling through tables.
4. The inspected caller is clearly separate from the best caller and defaults to the best caller after a completed run.
5. Included/excluded state is visible for every roster row.
6. No raw table causes horizontal scrolling at normal desktop width.
7. Advanced evidence is collapsed by default and remains complete when expanded.
8. Loading, completion, cooldown, and failure states use one consistent status component.
9. Existing backend data, append-only storage, archives, and tests remain unchanged unless required by the UI contract.

## Implementation order

1. Replace the current visible action cluster with the single primary workflow action and one status banner.
2. Make best-performer summary the first result block and default inspection to that caller.
3. Add explicit included/excluded scope counts and roster status labels.
4. Collapse and simplify evidence views; remove default stacked full-width tables.
5. Verify responsive layout, keyboard navigation, rate-limit states, and empty-state behavior.

This is a UI information-architecture change only. It does not change how GMGN or Dune data is collected, measured, persisted, or archived.
