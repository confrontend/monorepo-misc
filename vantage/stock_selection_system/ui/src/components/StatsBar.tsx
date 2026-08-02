import type { Stats } from "../types";

export default function StatsBar({ stats }: { stats: Stats | null }) {
  if (!stats) return null;
  const decisions: Array<keyof typeof stats.by_decision> = ["Confirm", "Mixed", "Reject", "Wait"];
  return (
    <div className="stats-bar">
      <div className="stat-pill">
        <span className="n">{stats.total_episodes}</span>
        <span className="label">Episodes</span>
      </div>
      {decisions.map((d) => (
        <div className="stat-pill" key={d}>
          <span className="n">{stats.by_decision[d] ?? 0}</span>
          <span className="label">{d}</span>
        </div>
      ))}
      <div className="stat-pill">
        <span className="n">{stats.unresolved_insufficient_data_cases}</span>
        <span className="label">Open cases</span>
      </div>
      <div className="stat-pill">
        <span className="n">{stats.tickers_tracked}</span>
        <span className="label">Tickers</span>
      </div>
    </div>
  );
}
