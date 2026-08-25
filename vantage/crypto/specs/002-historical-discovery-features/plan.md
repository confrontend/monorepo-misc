# Implementation Plan: Point-in-Time Historical Discovery Features

1. Extend the TypeScript pre-event accumulator and as-of source joins with numeric token-entry and historical wallet/token behavior fields.
2. Add the same names and timing justifications to the research configuration and Python crypto adapter allowlist.
3. Preserve the explicit `features` boundary; leave outcomes, current snapshots, tags without data, and true liquidity rejected.
4. Add fixture tests for as-of ordering, missingness, and adapter enforcement.
5. Run TypeScript tests/build, research exporter tests, architecture, and formatting checks.

Safety: source joins and aggregates use strict point-in-time boundaries; discovery scoring and validation logic do not change.
