import type { EpisodeSummary } from "../types";
import Badge, { type BadgeKind } from "./Badge";

interface Props {
  episodes: EpisodeSummary[];
  onSelect: (episodeId: string) => void;
  emptyMessage?: string;
}

// Shared by DashboardPage's "Recent decisions" and EpisodesPage's full list --
// same columns as the mockup's episode table, minus Entry/Outcome (those
// need per-episode entry/outcome data the bulk /api/episodes list doesn't
// return; they're shown in the detail drawer, which fetches the full record).
export default function EpisodesTable({ episodes, onSelect, emptyMessage }: Props) {
  if (episodes.length === 0) {
    return <div className="empty-state">{emptyMessage ?? "No episodes match the current filters yet."}</div>;
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Decision</th>
          <th>Total</th>
          <th>Earnings</th>
          <th>Market</th>
          <th>Context</th>
          <th>Trigger</th>
          <th>Review date</th>
        </tr>
      </thead>
      <tbody>
        {episodes.map((ep) => (
          <tr key={ep.episode_id} data-clickable onClick={() => onSelect(ep.episode_id)}>
            <td className="ticker-cell">
              {ep.ticker}
              {ep.corrects_episode_id && <span className="text-muted"> (correction)</span>}
            </td>
            <td>{ep.decision ? <Badge kind={ep.decision as BadgeKind} /> : "—"}</td>
            <td className="num">{ep.total_score ?? "—"}</td>
            <td className="num">{ep.earnings_score ?? "—"}</td>
            <td className="num">{ep.market_score ?? "—"}</td>
            <td className="num">{ep.context_score ?? "—"}</td>
            <td style={{ maxWidth: 220 }}>{ep.episode_trigger}</td>
            <td className="text-muted">{ep.review_date}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
