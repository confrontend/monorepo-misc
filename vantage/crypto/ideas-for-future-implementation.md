# Ideas for future implementation

- 2026-08-23 11:16 -07:00 — Check whether the app already uses a `DataTable` component. Create a shared components folder and begin consolidating table behavior there so sorting, filtering, tooltips, and related logic are reused instead of duplicated.
- 2026-08-23 11:38 -07:00 — Candidates for a `ui/components/` shared folder, found by parsing `ui/main.tsx` (only 7 components exist today — CapitalPathChart, GmgnTag, CopyAddressButton, WalletIcon, SaveRowButton, InfoTip — everything else is inline in the single ~4,000-line `App()`), ranked by duplication evidence:
  - **Modal / Dialog** (4 copies: scrutiny detail, roster comparison, stats detail, copy-delay detail) — each hand-rolls the same backdrop + `role="dialog"` + stop-propagation + close-on-backdrop-click pattern.
  - **DataTable** (6 copies: scrutiny-table, decision-table, history-table, combined-stats-table, trade-detail-table, fully-covered-table) — each wraps its own `table-wrap` div and hand-writes `<thead>`/`.map()` rows. Highest-value target alongside Modal — most duplication, most behavior, and the kind of copy-drift that already caused real bugs this session.
  - **Panel / Section** (10+ copies) — every top-level content area is `<section className="menu-section panel X-panel">` with the same header shape.
  - **SortableHeader** (18 references) — every table re-implements its own sortable-header + sort-arrow-indicator + click-to-toggle logic.
  - **Collapsible** (12 `<details>` wrappers) — same open/summary/toggle-state pattern repeated per section. — DONE 2026-08-23: extracted to `ui/components/Collapsible.tsx`, 17 of 17 call sites migrated (the real count as of the extraction was 17, not 12; none were left inline).
  - **StatTile** (seen once so far, `copytrade-decision-state-tile`: `<div className="X-tile tone-Y"><strong>{count}</strong><span>{label}</span></div>` — worth checking other dashboards for the same shape before assuming it's only used once).
  - **StatusBanner** (12 copies) — `copytrade-status-warning` / `muted` one-line message boxes.
  - **WorkflowStep** (12 copies) — the numbered "0/1/2" circular step badges in Fetch controls.
  - **Badge/Pill** (~5 copies) — verdict badges and scrutiny verdict badges, likely mergeable into one generic `<Badge tone>`.
