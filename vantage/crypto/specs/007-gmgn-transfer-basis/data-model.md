# Data Model

## Canonical activity event

- `eventType`: `buy`, `sell`, `transfer_in`, or other unsupported source type.
- `rawEventType`: original GMGN spelling retained in the raw payload/provenance.
- `walletAddress`, `tokenAddress`, `observedTimestamp`, `tokenAmount`.
- Existing cost and raw fields remain append-only compatible.

## Inventory lot

- Token and wallet identity.
- Remaining quantity.
- `basisKind`: `known_buy` or `unknown_transfer`.
- Known purchase cost and source trade id when available.

## Resolved sell

- Known-basis quantity and cost.
- Unknown-basis quantity.
- `realizedProfitEligible`: true only when the resolved quantity has known basis.
- `uncertaintyReason` when any sold quantity came from unknown inventory.

## Invariants

1. `transfer_in` never increments buy count or creates known cost.
2. Unknown-basis sell quantity never contributes PnL, win rate, concentration, or completed profitable-trade counts.
3. A transfer with no later sell contributes no profitability observation.
4. Existing fully buy-backed behavior remains unchanged.
