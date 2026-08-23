# Progress

## 2026-08-21 — Phase 0 readiness inspection

- Step completed: Read the task specification and repository instructions for `unusualwhales` and `crypto`; inspected both live SQLite databases and source contracts.
- Files inspected: `unusualwhales/CLAUDE.md`, `unusualwhales/AGENTS.md`, `unusualwhales/src/research/signal-catalog.ts`, `unusualwhales/src/research/option-features.ts`, `crypto/CLAUDE.md`, `crypto/AGENTS.md`, `crypto/src/db/schema.ts`, `crypto/src/gmgn/ingest.ts`, `crypto/src/gmgn/polls.ts`, both `.data` databases, and existing research docs.
- Decision: Stop at Phase 0; recommend UW first and defer GMGN because GMGN coverage is low/biased and the current signal population is not outcome-ready.
- Agent/model: Codex GPT-5 with delegated Codex inspection tasks.
- Test result: No new code tests run. Delegated baselines: UW existing walk-forward/OOS evidence reviewed; crypto targeted tests 39 passed, full read-only TypeScript run 319 passed/1 failed (schema initialization).
- Errors/unresolved: graphify CLI/uvx query was unavailable because the local uv cache path is a file collision; source and graph JSON fallback inspection continued. UW feature refresh is incomplete for at least the inspected sample row.
- Next step: Await review of `PHASE-0-READINESS.md`; only after approval design Phase 1.

## 2026-08-21 — Phase 1 V1 implementation draft

- Step completed: Added the isolated Python package/CLI skeleton under the root-level `research/shared-pattern-discovery` path after Phase 0 approval.
- Files changed: `pyproject.toml`, `README.md`, `shared_pattern_discovery/{__init__,config,validation,stats,engine,cli}.py`, `configs/{unusualwhales,crypto}.json`, `fixtures/synthetic.json`, and `tests/{test_stats,test_engine,test_cli}.py`.
- Decision: Keep project identity, allow-lists, input/output paths, cache/model paths, and state explicitly isolated; support NumPy fallbacks because SciPy/statsmodels/scikit-learn are unavailable in the bundled runtime.
- Agent/model: Codex GPT-5.
- Test result: Not run; user requested stopping after adding the current V1 files.
- Errors or unresolved items: Permutation-importance execution and full syntax/test/CLI verification remain to be checked; no real exported project dataset was run.
- Next step: Run the package tests and synthetic CLI verification before treating V1 as complete.

Final Goal Check: This draft supports the final goal by creating a project-isolated discovery/report boundary without touching source databases or claiming profitability. The project remains on track, pending verification and completion of any remaining V1 gaps.

## 2026-08-21 — V1 audit fixes and verification

- Step completed: Audited and fixed the remaining V1 gaps in holdout handling, deterministic NumPy tree/permutation evidence, and validation-survivor reporting.
- Files changed: `shared_pattern_discovery/engine.py` and `tests/test_engine.py`; regenerated `runs/unusualwhales/synthetic-v1.json` from the synthetic fixture.
- Decision: Discovery summaries, feature eligibility, candidate generation, correction, model fitting, validation, and status assignment exclude the final holdout; the JSON report records this policy and explicit false use flags.
- Test result: `python -m unittest discover -s tests -v` — 12/12 passed. Synthetic CLI completed with 17 patterns: 2 validation survivors, 9 rejected, 6 insufficient data; holdout rows 3; fallback permutation evidence present.
- Errors or unresolved items: No real project export was available or used; no crypto/unusualwhales source or database was touched.
- Next step: V1 package is ready for review; SHAP and interaction search remain out of scope.

Final Goal Check: This work improves the reliability of discovering repeatable, backtestable Unusual Whales relationships by preventing holdout leakage and exposing deterministic model evidence. The project remains on track, with results still treated as discovery evidence rather than profitability claims.

## 2026-08-21 — Read-only Unusual Whales normalized exporter

- Step completed: Added `shared_pattern_discovery/exporters/uw.py`, a project-local SQLite `mode=ro` exporter with `PRAGMA query_only=ON`, bounded `--limit`, `--horizon`, `--cost-bps`, path/project/output isolation checks, allow-listed features, explicit outcome metadata, and `dte_days = expiry - executed_at` only.
- Files changed: `shared_pattern_discovery/exporters/{__init__,uw}.py`, `shared_pattern_discovery/__init__.py`, `tests/test_exporter.py`, `README.md`, and bounded run artifacts under `runs/unusualwhales/`.
- Test result: Full package suite `python -m unittest discover -s tests -v` — 15/15 passed. Temporary SQLite fixtures verified source hash preservation, missing outcomes remaining null, DTE derivation, horizon/limit bounds, and isolation failures.
- Real bounded export: `runs/unusualwhales/uw-1d-limit100.json`, horizon `+1d`, limit `100`; export rows `100`, mature rows `43`, usable rows `43`, cost adjustment `10 bps`. The source DB was opened read-only and no `unusualwhales` files were modified.
- Real engine CLI: `runs/unusualwhales/uw-1d-limit100-report.json`; `63` patterns, `0` discovered-only, `2` validation survivors, `59` rejected, `2` insufficient; `10` holdout rows, explicitly unused by discovery, modeling, correction, or validation.
- Errors or unresolved items: The bounded export is an exploratory readiness run, not evidence of profitability; no full-database export or final holdout reuse was performed.
- Next step: Review the project-local export contract before adding broader horizons or production export scheduling.

Final Goal Check: This exporter creates the traceable, point-in-time-safe UW normalized boundary needed to test repeatable backtestable relationships. The project remains on track; the resulting survivors are discovery evidence only and require independent research/backtesting.

## 2026-08-21 — UW coverage and missingness diagnostic

- Step completed: Added separate `shared_pattern_discovery/exporters/uw_coverage.py` read-only diagnostic with bounded event sampling, per-horizon outcome/maturity/usable counts, event-known missingness comparisons for premium, size, open_interest, and derived notional, survivorship caveat, CLI horizon/all-horizon selection, project validation, and output isolation.
- Files changed: `shared_pattern_discovery/exporters/uw_coverage.py`, `tests/test_coverage_diagnostic.py`, and bounded diagnostic artifact `runs/unusualwhales/uw-coverage-limit100.json`.
- Test result: Full package suite `python -m unittest discover -s tests -v` — 17/17 passed. Temporary fixture tests verified read-only source hashing, all-horizon output, explicit sample sizes, project rejection, and output isolation.
- Real diagnostic: 100 bounded events across all five horizons. `+5m`, `+30m`, `+1h`: 100 outcome rows, 26 mature/usable (26%); `+1d`, `+3d`: 100 outcome rows, 43 mature/usable (43%). Missingness comparisons report usable/non-usable sample sizes and standardized mean differences for all four fields per horizon.
- Survivorship: Report explicitly states entity survivorship is not provable from the current database without a supplied and independently verified selection boundary.
- Errors or unresolved items: This is a bounded readiness diagnostic, not a profitability result; no crypto or Unusual Whales source/database files were modified.
- Next step: Use the diagnostic report to decide whether broader export horizons or a verified entity-selection boundary are ready for review.

Final Goal Check: This diagnostic makes outcome coverage and missingness bias visible before relying on discovered patterns, directly supporting the goal of finding repeatable, backtestable UW signals. The project remains on track, with no profitability claim made.

## 2026-08-21 — V1 verification

- Step completed: Ran bundled-Python syntax compilation, the full package unit-test suite, and the synthetic CLI run; corrected the multiple-testing regression test fixture so scanning additional cells increases the adjusted q-value.
- Files changed: `tests/test_stats.py`, `progress.md`; generated local synthetic output at `runs/unusualwhales/synthetic.json`.
- Decision: Keep the current V1 implementation and NumPy fallback path; do not run against live databases because no normalized export exists and Phase 0 prohibits direct engine database access.
- Agent/model: Codex GPT-5.
- Test result: 8/8 unit tests passed; synthetic CLI completed with 15 patterns, 8 rejected, 7 insufficient data, and 0 validation survivors.
- Errors or unresolved items: Optional SciPy/scikit-learn paths were not exercised because the bundled runtime does not include them; no real project export was run.
- Next step: Review the V1 API/report contract and add a project-local normalized exporter only after the source project approves its allow-list and missingness/survivorship checks.

## 2026-08-21 — Independent verification after audit fixes

- Step completed: Re-ran bundled-Python compilation, all package tests, and the synthetic CLI with an explicit untouched holdout.
- Files changed: `progress.md`; generated `runs/unusualwhales/synthetic-verified.json`.
- Decision: Accept the audited V1 implementation for review; keep real-data execution blocked until a normalized project export is approved.
- Agent/model: Codex GPT-5.
- Test result: 12/12 tests passed; CLI produced 17 patterns: 2 validation survivors, 10 rejected, 5 insufficient data, with holdout handling enabled.
- Errors or unresolved items: Optional SciPy/scikit-learn branches remain unexercised in the bundled runtime; no real project export was available.
- Next step: Review the implementation and then build the UW project-local normalized exporter as a separate, explicitly allow-listed change.

2026-08-21 23:50:11 -07:00 - Added JSON-only GMGN adapter for crypto Pattern Discovery
- Step completed: Added `shared_pattern_discovery.exporters.gmgn`, which validates the crypto adapter JSON, exact outcome-coverage metadata, mature/usable rows, project identity, and writes normalized JSON for the isolated engine without opening SQLite. Extended `configs/crypto.json` with justified GMGN copy-outcome fields.
- Files changed: `shared_pattern_discovery/exporters/gmgn.py`, `tests/test_gmgn_exporter.py`, `configs/crypto.json`.
- Decision made and reason: Kept all database access in the crypto-side endpoint; the shared engine and adapter consume JSON only. The configured-command fallback is shown in the crypto UI because no Python runtime is installed in this workspace.
- Agent name and model: Codex, GPT-5.
- Test result: Python tests could not run because `python` is not recognized and `py -3` reports `No installed Python found!`; TypeScript builds and crypto focused tests passed.
- Errors or unresolved items: Optional Python report execution remains blocked until a runtime is configured.
- Next step: Run the documented adapter and shared CLI commands once Python is installed.

2026-08-21 23:51:30 -07:00 - Final verification note
- Step completed: Confirmed the crypto allow-list JSON parses and the shared adapter files are included in the project-local change.
- Files changed: `configs/crypto.json`, `shared_pattern_discovery/exporters/gmgn.py`, `tests/test_gmgn_exporter.py`, `progress.md`.
- Decision made and reason: Leave the adapter JSON-only and database-free; do not add a Python runner to the crypto server.
- Agent name and model: Codex, GPT-5.
- Test result: Python tests unavailable because no Python executable is installed/configured; crypto build and focused tests pass.
- Errors or unresolved items: Adapter/engine execution still requires a configured Python runtime.
- Next step: Run `python -m pytest -q` and the two documented commands after runtime setup.
