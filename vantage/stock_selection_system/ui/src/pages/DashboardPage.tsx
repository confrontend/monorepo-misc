import EpisodesTable from "../components/EpisodesTable";
import type { EpisodeSummary, Stats } from "../types";

interface Props {
  stats: Stats | null;
  recentEpisodes: EpisodeSummary[];
  onSelectEpisode: (episodeId: string) => void;
  onGoEpisodes: () => void;
  connected: boolean;
  onRefresh: () => void;
  refreshing: boolean;
}

function todayLabel(): string {
  return new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

export default function DashboardPage({ stats, recentEpisodes, onSelectEpisode, onGoEpisodes, connected, onRefresh, refreshing }: Props) {
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Stock Selection System</h1>
          <div className="page-sub">Candidate validation &amp; forward tracking</div>
        </div>
        <div className="page-header-actions">
          <div className="page-meta">{todayLabel()}</div>
          <span className="tag tag-neutral">
            <span className="tag-dot" style={{ background: connected ? "var(--color-confirm-dot)" : "var(--color-reject-dot)" }} />
            {connected ? "API connected" : "API disconnected"}
          </span>
          <button type="button" className="btn btn-secondary" onClick={onRefresh} disabled={refreshing}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /><path d="M8 16H3v5" />
            </svg>
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>
      <div className="hr" />

      <div className="stat-grid">
        <div className="card"><div className="card-kicker">Total</div><div className="card-title">{stats?.total_episodes ?? "—"}</div><div className="card-body">Scored episodes</div></div>
        <div className="card"><div className="card-kicker" style={{ color: "var(--color-confirm-fg)" }}>Confirm</div><div className="card-title">{stats?.by_decision.Confirm ?? 0}</div><div className="card-body">decisions</div></div>
        <div className="card"><div className="card-kicker" style={{ color: "var(--color-mixed-fg)" }}>Mixed</div><div className="card-title">{stats?.by_decision.Mixed ?? 0}</div><div className="card-body">decisions</div></div>
        <div className="card"><div className="card-kicker" style={{ color: "var(--color-accent-700)" }}>Reject</div><div className="card-title">{stats?.by_decision.Reject ?? 0}</div><div className="card-body">decisions</div></div>
        <div className="card"><div className="card-kicker" style={{ color: "var(--color-wait-fg)" }}>Wait</div><div className="card-title">{stats?.by_decision.Wait ?? 0}</div><div className="card-body">decisions</div></div>
        <div className="card"><div className="card-kicker">Open</div><div className="card-title">{stats?.unresolved_insufficient_data_cases ?? "—"}</div><div className="card-body">insufficient-data cases</div></div>
        <div className="card"><div className="card-kicker">Tracked</div><div className="card-title">{stats?.tickers_tracked ?? "—"}</div><div className="card-body">tickers</div></div>
      </div>

      <div className="section-heading">
        <h3>Recent decisions</h3>
        <a href="#" onClick={(e) => { e.preventDefault(); onGoEpisodes(); }}>View all episodes →</a>
      </div>
      <EpisodesTable
        episodes={recentEpisodes}
        onSelect={onSelectEpisode}
        emptyMessage="No episodes yet. Fetch candidates from Candidate Intake and validate them."
      />
    </div>
  );
}
