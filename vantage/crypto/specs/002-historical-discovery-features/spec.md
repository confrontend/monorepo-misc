# Feature Specification: Point-in-Time Historical Discovery Features

**Feature Branch**: `002-historical-discovery-features`
**Created**: 2026-08-24
**Status**: Approved for implementation

## User scenarios

### P1 — Entry-time token context

Researchers can test token market-cap-at-entry, token age, launchpad, and entry size without using future outcomes.

### P2 — Historical wallet/token behavior

Researchers can test repeat behavior, activity intensity, position sizing, concentration, and robustness aggregates derived from trades before the target buy.

### P3 — Leakage and missing-data protection

Post-event outcomes, current snapshots, unavailable GMGN tags, and unavailable true liquidity remain outside discovery inputs.

## Acceptance scenarios

1. Same-second trades and an as-of GMGN signal emit only data known at the target buy.
2. Later signals and current snapshots cannot affect an earlier row.
3. No prior paired trades produces null statistics, not invented zero values.
4. The adapter rejects outcome fields placed inside `features`.
5. Missing tags or historical liquidity remain absent/null and are documented as unavailable.

## Requirements

- **FR-001**: Only explicitly allow-listed fields in `row.features` may enter discovery.
- **FR-002**: Token context must be joined as-of the target buy, with ambiguous later/same-time records excluded.
- **FR-003**: Wallet/token aggregates must use only trades before the target buy, with trade id as the same-second tie-breaker.
- **FR-004**: TypeScript export, JSON config, and Python adapter must share the same feature names and version.
- **FR-005**: Outcomes, exits, delays, fees, coverage, current snapshots, unavailable tags, and true liquidity remain rejected.
- **FR-006**: Missing historical values remain null/absent and are never converted to zero.
- **FR-007**: Regression tests cover timing boundaries, missingness, and adapter allowlist enforcement.

## Data-backed scope

Implement: entry trade size, source-observed token market cap/trigger market cap, token age, launchpad, and additional pre-event wallet/token aggregates.

Defer: GMGN tags because the current database has zero populated `raw_wallet_labels` rows; true historical pool liquidity because the current liquidity endpoint is live/current-only.

## Success criteria

- Every populated new feature is demonstrably available before its target buy.
- No post-event field is accepted inside the crypto adapter’s explicit feature object.
- Existing discovery, chronological validation, promotion, and Decision Lab scoring logic are unchanged.
- Build, tests, research tests, architecture checks, and formatting checks pass.
