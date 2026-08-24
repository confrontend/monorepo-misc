# Ideas for future implementation

- 2026-08-23 11:16 -07:00 — Check whether the app already uses a `DataTable` component. Create a shared components folder and begin consolidating table behavior there so sorting, filtering, tooltips, and related logic are reused instead of duplicated.
- 2026-08-23 11:38 -07:00 — Candidates for a `ui/components/` shared folder, found by parsing `ui/main.tsx` (only 7 components exist today — CapitalPathChart, GmgnTag, CopyAddressButton, WalletIcon, SaveRowButton, InfoTip — everything else is inline in the single ~4,000-line `App()`), ranked by duplication evidence:
  - **Modal / Dialog** (4 copies: scrutiny detail, roster comparison, stats detail, copy-delay detail) — each hand-rolls the same backdrop + `role="dialog"` + stop-propagation + close-on-backdrop-click pattern.
  - **DataTable** (6 copies: scrutiny-table, decision-table, history-table, combined-stats-table, trade-detail-table, fully-covered-table) — each wraps its own `table-wrap` div and hand-writes `<thead>`/`.map()` rows. Highest-value target alongside Modal — most duplication, most behavior, and the kind of copy-drift that already caused real bugs this session.
  - **Panel / Section** (10+ copies) — every top-level content area is `<section className="menu-section panel X-panel">` with the same header shape.
  - **SortableHeader** (18 references) — every table re-implements its own sortable-header + sort-arrow-indicator + click-to-toggle logic.
  - **Collapsible** (12 `<details>` wrappers) — same open/summary/toggle-state pattern repeated per section.
  - **StatTile** (seen once so far, `copytrade-decision-state-tile`: `<div className="X-tile tone-Y"><strong>{count}</strong><span>{label}</span></div>` — worth checking other dashboards for the same shape before assuming it's only used once).
  - **StatusBanner** (12 copies) — `copytrade-status-warning` / `muted` one-line message boxes.
  - **WorkflowStep** (12 copies) — the numbered "0/1/2" circular step badges in Fetch controls.
  - **Badge/Pill** (~5 copies) — verdict badges and scrutiny verdict badges, likely mergeable into one generic `<Badge tone>`.

- 2026-08-23 (later) — idea: centralize all UI-facing strings (labels, button text, tooltips, empty-state/error messages) into one file, imported and reused across the app instead of inline string literals scattered through `ui/main.tsx`. Would pair naturally with the `ui/components/` extraction above (Modal/DataTable etc. take label/text props today) — a shared strings module would give those components, and the ~4,000-line `App()`, a single place to update copy instead of hunting through inline JSX. Not scoped or started.

- 2026-08-23 (later still) — Idea: introduce a lightweight shared derived-state layer in the UI to avoid duplicated decision logic. Keep state management simple: local state → `useState`, parent/child state → React Context, global UI state → Zustand, and backend/API state → TanStack Query. Shared derived concepts should live in one reusable selector or function so different parts of the UI cannot compute the same decision differently.

