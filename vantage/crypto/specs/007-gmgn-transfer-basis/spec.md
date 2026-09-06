# Feature Specification: Conservative GMGN Transfer Cost Basis

**Feature Branch**: `007-gmgn-transfer-basis`

**Created**: 2026-09-06

**Status**: Ready for implementation

**Input**: Incoming GMGN token transfers must never create unproven realized profit.

## User Scenarios & Testing

### User Story 1 - Protect profitability metrics (Priority: P1)

As an analyst, I need incoming transfers separated from buys so wallet profitability reflects only inventory with a proven purchase basis.

**Why this priority**: False profit can promote the wrong wallet before Dune is queried.

**Independent Test**: Feed buy, transfer-in, and sell rows into the shared accounting path and inspect completed trades, PnL, and win rate.

**Acceptance Scenarios**:

1. **Given** a transfer-in with no buy, **When** it is sold, **Then** no realized return is credited and the sell is marked uncertain.
2. **Given** a buy and a transfer-in of the same token, **When** part of the position is sold, **Then** the transfer-backed portion remains excluded conservatively.

### User Story 2 - Preserve transfer evidence (Priority: P2)

As an analyst, I need the original GMGN event type retained and a transfer-in caution signal visible to explain excluded inventory.

**Why this priority**: Transfers are neutral evidence, not an automatic risk verdict.

**Independent Test**: Import a browser activity payload containing `TX In` and verify canonical storage plus caution evidence.

**Acceptance Scenarios**:

1. **Given** an incoming transfer event, **When** it is ingested, **Then** it is stored as `transfer_in` with raw provenance preserved and is not counted as a buy.

### User Story 3 - Keep Dune simulation conservative (Priority: P3)

As an analyst, I need delayed-copy simulation and Winner Policy to exclude sells without proven buy inventory.

**Why this priority**: Dune outcomes must not revive an unsupported local cost basis.

**Independent Test**: Run the canonical pairing path with unmatched and partially transfer-backed sells.

**Acceptance Scenarios**:

1. **Given** a sell without a known buy lot, **When** pairing runs, **Then** it is excluded as unmatched/uncertain.

### Edge Cases

- A transfer-in has no sell: it contributes no profit or completed trade.
- A sell exceeds known bought inventory: the excess is excluded as unknown basis.
- Multiple partial buys and transfers are processed chronologically and deterministically.
- Legacy event spellings (`transferIn`, `transfer_in`, `TX In`) map to one canonical type.

## Requirements

### Functional Requirements

- **FR-001**: System MUST canonicalize incoming GMGN transfer event spellings to `transfer_in` while preserving the raw event in the payload.
- **FR-002**: System MUST request and persist transfer events in the production GMGN history path.
- **FR-003**: System MUST maintain known-cost buy inventory separately from unknown-cost transfer inventory.
- **FR-004**: System MUST credit realized PnL, win rate, concentration, and completed-trade metrics only for sell portions backed by known purchase inventory.
- **FR-005**: System MUST mark sells with unresolved transfer inventory as cost-basis uncertain and exclude their unresolved portion from profitability metrics.
- **FR-006**: System MUST expose transfer/uncertain-basis evidence as neutral or caution context, never as an automatic rejection.
- **FR-007**: System MUST use the same resolver for local evaluation, feature snapshots, candidate screening, and copy simulation.
- **FR-008**: Automated tests MUST cover normal buy→sell, TX In→sell, buy+TX In→sell, partial transfer-in+partial sell, and TX In with no sell.

### Key Entities

- **Canonical activity event**: A persisted GMGN event with canonical type, raw source type, token, timestamp, and amounts.
- **Inventory lot**: Chronological token quantity classified as known purchase cost or unknown transfer cost.
- **Cost-basis resolution**: Deterministic allocation of sell quantity across inventory lots and excluded unknown portions.

## Success Criteria

### Measurable Outcomes

- **SC-001**: No TX In→sell scenario produces a realized return, win, or completed profitable trade without proven buy inventory.
- **SC-002**: All five required transfer scenarios pass automated tests deterministically.
- **SC-003**: Existing buy/sell behavior remains unchanged for buy-backed sells.
- **SC-004**: Production GMGN history requests include transfer events and retain their raw event spelling for auditability.

## Assumptions

- Existing SQLite rows are append-only; migration changes must be additive and preserve raw payloads.
- GMGN sell-level `buy_cost_usd` is not trusted as provenance by itself.
- Unknown transfer inventory is conservative: unresolved sell portions are excluded, not assigned zero or estimated cost.
- Winner Policy thresholds and Dune query logic remain unchanged except for corrected upstream evidence.
