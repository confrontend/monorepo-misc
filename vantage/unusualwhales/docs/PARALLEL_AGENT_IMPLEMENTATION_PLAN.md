# Parallel implementation plan: real Phase 1 results

## Final outcome for this step

The Unusual Whales dashboard will display real, measured results for the stored provider-defined call-sweep events at `+5m`, `+30m`, `+1h`, `+1d`, and `+3d`:

- independent/mature sample size;
- win rate;
- median and average underlying-stock return;
- return relative to SPY;
- named net-cost scenarios;
- coverage and missing-data status;
- an exploratory/out-of-sample status label.

No result will be called profitable, predictive, or tradable before chronological validation.

## Agent 1 — backend and outcomes

Ownership: `src/`, `tests/`, SQLite schema, and server/API behavior. Do not edit `ui/` or visual styles.

1. Add versioned tables for underlying bars, SPY bars, and event outcomes; retain source IDs, timestamps, raw responses, and exclusion reasons.
2. Fetch/cache 1-minute bars for intraday horizons and daily bars for `+1d`/`+3d` using the existing server-side credential reader. Use the same process for SPY.
3. Define and test one entry convention: first valid bar at or after event availability, never a bar that ended before the event was observable.
4. Calculate gross stock return, SPY return, excess return, and named net-cost scenarios for every mature horizon.
5. Apply a deterministic non-overlap policy per ticker and horizon; report raw events, eligible independent events, mature events, fresh outcomes, and exclusions separately.
6. Extend the existing summary endpoint without breaking its current fields. Add an `outcomes` object shaped as:

```ts
{
  [horizon: string]: {
    nRaw: number;
    nIndependent: number;
    nMature: number;
    nWithOutcome: number;
    winRate: number | null;
    medianReturnPct: number | null;
    averageReturnPct: number | null;
    medianExcessPct: number | null;
    averageExcessPct: number | null;
    netByCostBpsPerSide: Record<string, number | null>;
    status: 'insufficient' | 'descriptive';
  }
}
```

7. Make the existing Sync action run event ingestion plus outcome refresh, or add a clearly named backend operation while preserving the current UI route contract.
8. Add fixture tests for timestamp direction, incomplete horizons, cancellations, duplicate events, overlap exclusion, benchmark joins, and cost arithmetic.

Success condition: a live sync populates outcome rows for any available horizons and the summary endpoint returns real numeric metrics or explicit missing-data reasons.

## Agent 2 — final UI

Ownership: `ui/main.tsx` and `ui/styles.css` only. Do not edit backend, schema, package scripts, or API routes.

1. Consume the existing summary endpoint and the backend outcome contract above.
2. Keep the dashboard simple: one Large Call Sweeps research card, fixed horizon selector, metric row, evidence readiness, and methodology caveat.
3. Replace dashes with real values whenever the API supplies mature outcomes; keep dashes only for genuinely unavailable metrics.
4. Show `N` with a clear distinction between raw, independent, mature, and outcome-available counts.
5. Show cost results as named scenarios (for example `10 bps/side`), never as an unlabeled “after costs” claim.
6. Show loading, empty, and API-error states as product states—not developer/test controls.
7. Keep the current light ocean theme and avoid adding mock numbers, draft sections, test buttons, or strategy recommendations.

Success condition: the UI renders the backend’s real metrics and caveats at `http://localhost:5273` without inventing values.

## Coordination boundary

Agent 1 must not touch `ui/`. Agent 2 must not touch `src/`, `tests/`, `package.json`, or API contracts. The shared handoff is the summary JSON contract above. The root agent runs integration tests, performs one live sync, and resolves only contract-level issues.
