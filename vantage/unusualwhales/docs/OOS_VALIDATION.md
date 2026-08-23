# Out-of-sample validation

The OOS runner accepts a frozen JSON configuration and reads the existing SQLite
normalized events/outcomes without refreshing or modifying them.

Run it with:

```powershell
npm run validate:oos -- docs/examples/oos-config.example.json
```

The configuration must freeze the methodology version, selected signal IDs,
in-sample period, untouched out-of-sample period, `asOf` maturity time,
embargo, horizons, and cost scenarios. The report includes a stable selection
fingerprint and separate in-sample/out-of-sample metrics.

For the currently materialized non-trade families, run:

```powershell
npm run validate:oos -- docs/examples/oos-config-generic-2026-08.json
```

The complete all-family example is also provided at
`docs/examples/oos-config-all-2026-08.json`. Its option-trade portion is a
large production-scale workload; it must use the planned streaming/chunked
reader rather than loading every normalized option event into one process
array.

For sequential frozen holdouts, use the database-backed walk-forward runner:

```powershell
npm run validate:walk-forward -- docs/examples/walk-forward-config-2026-08.json
```

The selections, horizons, cost scenarios, and evidence threshold remain fixed
across every window; only the in-sample, holdout, and maturity dates change.
