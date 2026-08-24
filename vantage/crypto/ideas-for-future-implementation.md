# Ideas for future implementation

## ✅ Completed

### Shared UI components (`ui/components/`)
_Scoped 2026-08-23: `ui/main.tsx` was ~4,000 lines with only 7 extracted components (CapitalPathChart, GmgnTag, CopyAddressButton, WalletIcon, SaveRowButton, InfoTip) — everything else inline. Candidates below, ranked by duplication._

- **Modal / Dialog** — DONE. 4 copies (scrutiny detail, roster comparison, stats detail, copy-delay detail) → `Modal.tsx`.
- **DataTable** — DONE. 6 copies (scrutiny, decision, history, combined-stats, trade-detail, fully-covered tables) → `DataTable.tsx`.
- **Panel / Section header** — DONE (header only, not the section body or wrapper). 14 call sites → `PanelHeading.tsx` (`eyebrow`/`title`/optional `tag`). Left inline: `evidence` and `diagnostics` (header has a button instead of a tag), `capture-raw-endpoints` (no panel-heading, uses a `<details>` summary), and the top-level `copytrade` section (no direct heading).
- **SortableHeader logic** — DONE (state/toggle/indicator logic only, not the visual `<th>` markup, which still varies per table). Found 5 independent sort-state implementations → one headless `useSortState.ts` hook; all 18 header/comparator call sites migrated with zero call-site changes via aliasing.
- **Collapsible** — DONE. All 17 `<details>` wrappers (real count was 17, not the originally estimated 12) → `Collapsible.tsx`.
- **StatusBanner** — DONE. All 9 `copytrade-status-warning`/`muted` one-liners → `StatusBanner.tsx`.
- **WorkflowStep** — DONE. All 3 numbered step-badge call sites → `WorkflowStep.tsx`.
- **StatTile** — INVESTIGATED, not needed. Only one JSX call site exists (rendered 4× via `.map()`), already DRY — extracting a component would be premature abstraction.
- **Badge/Pill** — INVESTIGATED, not needed. Only 2 call sites remain, structurally different from each other, share no logic beyond a className — not worth a dedicated component.

### Shared derived-state layer (proof-of-concept)
_Original idea (2026-08-23): local state → `useState`, parent/child → Context, global UI state → Zustand, backend/API state → TanStack Query; shared derived concepts in one reusable selector._

DONE as a proof-of-concept on `feature/crypto-state-management` — one bounded slice per layer, **not a full migration**:
- **Selectors** (`ui/selectors/decisionSelectors.ts`): `computeDuneQueriedPercent`, `buildDuneFetchProgressText`, `buildUsableCoverageText`, `buildEvidenceReason`. Along the way, found and fixed a real 3-way drift in the "usable Dune coverage" tooltip text (the Evidence column showed less precision than the other two) — a deliberate, documented display-precision change.
- **Zustand** (`ui/stores/rosterStore.ts`): `selectedRosterSnapshotId` — read at 20+ sites, written at 3, a genuinely global concern.
- **TanStack Query**: the wallet-detail trade-history fetch only, via `useQuery` + a `QueryClientProvider` at the render root. Scrutiny (the original suggested target) was passed over as too entangled.
- **Not migrated**: the other 65+ `useState` declarations, the Scrutiny/GMGN-stats/copy-simulation fetch-effect triads, and other cross-cutting state (e.g. active tab navigation).

### `ui/main.tsx` architecture breakdown
_Direct user request (2026-08-24), not originally tracked as an `idea:` — recorded here now for a complete picture. Done on `feature/crypto-ui-architecture`, committed as `773b57b5`._

- Split the ~4,300-line single-file app into `main.tsx` (entry point only, 26 lines), `App.tsx` (the component), and `types.ts` (102 extracted type declarations).
- Extracted 2 of ~10 tabs into `routes/` + `hooks/` (Archives, Diagnostics) — the only two that were unconditionally mounted and fully self-contained.
- Left inline, each with a documented reason: Wallet Stats + Scrutiny + CSV export (share derived state three ways), Pattern Discovery (conditionally mounted — extracting would cause a remount-flash regression), Capture + Capture-raw-endpoints (one-line cross-panel coupling), and the legacy signal-workspace tabs (dead behind `WALLET_STATS_ONLY = true`, deeply entangled).

### UI strings centralization (partial)
_Original idea (2026-08-23): centralize all UI-facing strings into one file instead of scattering literals through `ui/main.tsx`._

PARTIALLY DONE on `feature/crypto-ui-architecture`, committed as `773b57b5` — stopped mid-task by explicit request rather than run to completion. `ui/strings.ts` exists (898 lines) with 436 references wired up in `App.tsx`; the remainder of the file's strings are still inline. Verified healthy at the stopping point (clean build, 307/307 tests) — a real partial extraction, not a rough draft. A short convention was added to `CLAUDE.md`: new UI copy goes in `ui/strings.ts`, not inline.

## 📋 Open ideas

### Finish the UI strings centralization
Continue the partial extraction above until `ui/strings.ts` covers all in-scope user-facing text in `ui/App.tsx`, the route files, and any hardcoded (non-prop) strings inside `ui/components/*.tsx`. Not scoped as a fresh task — pick up where the partial pass left off.

### Break up `src/scripts/server.ts` into per-domain route modules
_Investigated 2026-08-24, confirmed feasible, not implemented._

`server.ts` is 2,478 lines — one flat sequential `if (method && pathname === '...')` chain for every HTTP route, the only place in the codebase that doesn't follow the existing domain-folder convention. The logic each route calls is already domain-separated: `/api/copytrade/*` (44 routes) → `src/copytrade/`, `/api/gmgn/*` (7) → `src/gmgn/`, `/api/dune/*` (6) → `src/dune/`, `/api/analysis/*` (7) → `src/signals/`, plus a handful of misc routes → `src/platform/`/`src/signals/`. Natural shape: one `routes.ts` per domain folder, with `server.ts` reduced to server setup + dispatch.

### Build a reliable in-memory API-data cache
_Investigated 2026-08-24, confirmed there isn't one, not implemented._

There's currently no client-side store for API-fetched data with real invalidation: the shared `api()` fetch helper has no caching or dedup; the dominant pattern (useState + useEffect pairs) unconditionally re-fetches on every trigger; the one TanStack Query usage is deliberately configured with `staleTime: 0` to reproduce old always-refetch behavior, not to cache; Zustand and localStorage both hold only UI state/preferences, not fetched data. The only thing making repeat fetches cheap today is the server's own disk-backed cache (a different, already-fragile layer). Most natural next step: extend the existing TanStack Query pattern with real `queryKey`/`staleTime` invalidation tied to the actions that actually change server data (roster sync, Dune fetch completion, GMGN refresh).
