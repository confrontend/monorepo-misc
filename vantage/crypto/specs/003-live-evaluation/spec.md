# Feature Specification: Live Evaluation (GMGN-30d-only wallet estimate)

**Feature Branch**: `003-live-evaluation`
**Created**: 2026-08-25
**Status**: Approved for implementation

## User scenarios

### P1 — Evaluate an arbitrary wallet right now

A researcher pastes any Solana wallet address into a new "Live Evaluation" tab and clicks Evaluate. Within a bounded wait, they see an estimated overall score, a Pass/Reject/Insufficient-Evidence verdict, component scores where computable, the 30-day GMGN stats used, and which already-validated Pattern Discovery rules affected the result — all built from GMGN data only, with no Dune fetch and no wait for the full Dune capture/simulation pipeline.

### P2 — Review a wallet's evaluation history

Every completed Live Evaluation and genuine Decision Lab recomputation is recorded as an append-only
wallet history entry. The current result shows its score trend against the immediately preceding
entry, regardless of source, and the wallet timeline shows source, timestamp, score, verdict, and
change. This avoids presenting GMGN-only and Dune-backed scores as if they were the same method.

### P3 — No fabricated confidence

Live Evaluation never manufactures a number it doesn't have evidence for. A missing or stale Pattern Discovery profile, a feature that needs Dune data, or a promoted-rule condition shape with no established scoring convention in this codebase are all surfaced explicitly (`profileLoadStatus`, `rulesUnavailable`, `evidenceLevel`) rather than silently defaulted (e.g. to an equal-weighted 25/25/25/25 model or a null-coalesced feature value).

## Acceptance scenarios

1. A wallet with enough stored/fetched GMGN trade history and a current promoted-pattern profile returns a non-null `estimatedOverallScore`, a verdict, and at least one populated component score.
2. Computing a Live Evaluation result never issues a Dune API/DB call — verified structurally (no Dune-path import in the scoring module) as well as by fixture (identical result whether or not Dune-only tables are populated for that wallet).
3. A wallet that already has a saved Decision Lab result can still be Live-Evaluated on its own terms; the Live Evaluation number is computed without reading that saved Decision Lab score.
4. Each completed evaluation is recorded in wallet history; the response includes a trend against the immediately preceding entry, and the history endpoint returns the ordered timeline with per-entry trends.
5. A promoted "hyperactivity" rule (trade/buy/sell-count threshold) measurably changes the copyability-proxy score and appears in `rulesApplied` for a wallet whose current activity exceeds the promoted threshold, and does not for a low-activity wallet.
6. A promoted "fast trading" (under-15-second%) rule measurably changes the score and appears in `rulesApplied` for a fast-trading wallet, and does not for a wallet with normal hold times.
7. If no current (fingerprint-matching) Pattern Discovery profile is cached, `profileLoadStatus` reports it explicitly (`unavailable` or `stale`, with a reason) and the score is never computed using a fabricated neutral-weight fallback.
8. A promoted pattern on a feature or condition shape Live Evaluation doesn't model (e.g. a per-token-entry feature, or a bucket/mutual-information condition) is listed in `rulesUnavailable` with a reason, never silently applied or fabricated into `rulesApplied`.
9. An invalid wallet-address string (wrong length/alphabet) returns a clear 400 error before any GMGN fetch is attempted.
10. Calling the evaluation twice against the same unmutated stored evidence and the same cached profile returns identical results (aside from a `generatedAt` timestamp).

## Requirements

- **FR-001**: Provide a "Live Evaluation" UI tab: wallet-address input, an Evaluate action, and a rendered result.
- **FR-002**: On evaluation, ensure the wallet's 30-day GMGN data (aggregate stats and trade history) is present, fetching it if stale/absent; issue no Dune or other non-GMGN provider call at any point in the evaluation path.
- **FR-003**: Build the wallet's current feature snapshot using the same point-in-time-safe accumulation Pattern Discovery already uses, restricted to features derivable from a standing wallet history (no future/outcome fields, no per-token-entry-only fields).
- **FR-004**: Load the latest Pattern Discovery promoted-rule profile whose data fingerprint matches current stored evidence exactly; if none matches, fall back to the latest available profile only with an explicit staleness flag, never silently.
- **FR-005**: Apply only promoted rules whose feature and condition shape have an established, non-fabricated scoring treatment; skip and report (not invent) everything else.
- **FR-006**: Compute a distinct `estimatedOverallScore`, never reusing or aliasing Decision Lab's `overall` score; renormalize category weights across only the categories with a computable score for that specific wallet, with no hardcoded numeric weights or discovered thresholds anywhere in the computation.
- **FR-007**: Return `confidence`, `evidenceLevel`, `rulesApplied`, `rulesUnavailable`, and `profileLoadStatus` alongside the score, unconditionally (including on partial/insufficient results).
- **FR-008**: Never state or imply proven delayed-copy profitability; use GMGN-historical-pattern framing only (e.g. "likely profitable based on GMGN historical features" / "does not match historically profitable wallet patterns").
- **FR-009**: Always render the disclaimer "GMGN-only estimate — no delayed-copy/Dune validation." alongside any result.
- **FR-010**: When a Decision Lab result already exists for the evaluated wallet, surface a side-by-side comparison (score, verdict, GMGN profitability, main risks, score difference); the Live Evaluation computation itself must not read that saved result.
- **FR-011**: Expose `POST /api/live-evaluation` accepting `{ walletAddress }` and returning the full result object described above.
- **FR-012**: Reject a malformed wallet address with a clear error before any fetch/compute work begins.
- **FR-013**: Given the same stored GMGN evidence and the same cached promoted-rule profile, results are deterministic.
- **FR-014**: Leave Decision Lab's own computation, output, and cache entirely unmodified — Live Evaluation is fully additive.
- **FR-015**: Persist Live Evaluation and genuine Decision Lab computations in one append-only wallet history with normalized verdicts and shared component-score keys; compare entries by insertion order and score only.

## Data-backed scope

**Implement**: trade/buy/sell counts and volume, under-15-second-percent, median hold time, historical (GMGN-realized) profitability, period-consistency, profit concentration/robustness, repeat-entry/activity-intensity features already in Pattern Discovery's `prior_wallet_*` vocabulary, and the two already-promoted-rule families (hyperactivity, fast trading) generalized to any promoted threshold/correlation rule on that vocabulary. Wallet-level GMGN tags (`copytrade_wallets.gmgn_tags`, confirmed populated in the live database, e.g. `kol`, `wash_trader`, `top_followed`) are surfaced as informational context alongside the GMGN stats used, when available for the wallet — not as a scored rule input, since no promoted pattern currently keys off a tag feature.

**Defer**: promoted rules on `bucket` (`lower`/`upper`) or `mutual-information` condition shapes — no existing scoring convention anywhere in this codebase, and inventing one now would mean fabricating a weight; promoted rules on per-token-entry-only features (`prior_token_*`, `token_*`, `entry_*`) — no standing-wallet equivalent exists; asynchronous/polled GMGN fetch for a cold, never-seen, high-activity wallet — v1 awaits synchronously with a loading state, matching this codebase's existing rate-limit cost, and documents polling as a future improvement rather than building new infrastructure now.

## Success criteria

- A researcher can get a labeled, GMGN-only estimate for any wallet address without waiting on the Dune pipeline.
- The estimate is never presented as, or confusable with, a claim of proven delayed-copy profitability.
- A missing or stale promoted-rule profile is always visible in the result, never masked by a fabricated fallback score.
- Decision Lab's existing behavior, output, and cached results are unchanged by this feature's existence.
- Build, tests (new and existing), and architecture checks pass.
