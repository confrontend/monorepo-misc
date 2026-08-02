import type { EpisodeSummary } from "../types";
import ScoreBadge from "./ScoreBadge";

interface Props {
  episodes: EpisodeSummary[];
  selectedId: string | null;
  onSelect: (episodeId: string) => void;
}

export default function EpisodeList({ episodes, selectedId, onSelect }: Props) {
  if (episodes.length === 0) {
    return <div className="empty-state">No episodes match the current filters yet. Try running the ATI demo.</div>;
  }

  return (
    <table className="episode-table">
      <thead>
        <tr>
          <th>Ticker</th>
          <th>Decision</th>
          <th>Trigger</th>
          <th>Eligibility date</th>
          <th>E</th>
          <th>M</th>
          <th>C</th>
          <th>Total</th>
          <th>Decided</th>
        </tr>
      </thead>
      <tbody>
        {episodes.map((ep) => (
          <tr
            key={ep.episode_id}
            className={ep.episode_id === selectedId ? "selected" : ""}
            onClick={() => onSelect(ep.episode_id)}
          >
            <td>
              <strong>{ep.ticker}</strong>
              {ep.corrects_episode_id && <span className="mono"> (correction)</span>}
            </td>
            <td>{ep.decision ? <span className={`badge ${ep.decision}`}>{ep.decision}</span> : "—"}</td>
            <td className="mono">{ep.episode_trigger}</td>
            <td className="mono">{ep.eligibility_date}</td>
            <td><ScoreBadge score={ep.earnings_score} /></td>
            <td><ScoreBadge score={ep.market_score} /></td>
            <td><ScoreBadge score={ep.context_score} /></td>
            <td><ScoreBadge score={ep.total_score} /></td>
            <td className="mono">{ep.decision_timestamp_utc?.slice(0, 16).replace("T", " ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
