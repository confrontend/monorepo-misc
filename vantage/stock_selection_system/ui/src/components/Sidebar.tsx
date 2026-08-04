import type { ReactNode } from "react";

export type Screen = "dashboard" | "intake" | "episodes" | "incomplete" | "eodhd" | "backtest";

interface Props {
  screen: Screen;
  onNavigate: (screen: Screen) => void;
  openIncompleteCount: number;
}

const ICONS: Record<Screen, ReactNode> = {
  dashboard: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" />
    </svg>
  ),
  intake: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><line x1="19" y1="8" x2="19" y2="14" /><line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  ),
  episodes: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  incomplete: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  eodhd: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18" />
    </svg>
  ),
  backtest: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19V5M4 19h16" /><path d="m7 15 3-4 3 2 5-7" />
    </svg>
  ),
};

const NAV_ITEMS: { screen: Screen; label: string }[] = [
  { screen: "dashboard", label: "Dashboard" },
  { screen: "intake", label: "Candidate Intake" },
  { screen: "episodes", label: "Episodes" },
  { screen: "incomplete", label: "Incomplete Data" },
  { screen: "eodhd", label: "EODHD Test" },
  { screen: "backtest", label: "Danelfin Backtest" },
];

export default function Sidebar({ screen, onNavigate, openIncompleteCount }: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-brand-name">Stock Selection System</div>
        <div className="sidebar-brand-sub">Candidate validation &amp; forward tracking</div>
      </div>
      <div className="sidebar-divider" />
      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.screen}
            type="button"
            className={`sidebar-nav-item ${screen === item.screen ? "active" : ""}`}
            onClick={() => onNavigate(item.screen)}
          >
            {ICONS[item.screen]}
            {item.label}
            {item.screen === "incomplete" && openIncompleteCount > 0 && (
              <span className="sidebar-nav-badge">{openIncompleteCount}</span>
            )}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer">
        Rule version v1
        <br />
        Not a trading system — tracking &amp; review only.
      </div>
    </div>
  );
}
