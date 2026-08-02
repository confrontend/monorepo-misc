import { useEffect, useState } from "react";
import { getEpisode } from "../api";
import type { EpisodeDetail as EpisodeDetailT } from "../types";
import ScoreBadge from "./ScoreBadge";

export default function EpisodeDetail({ episodeId, onClose }: { episodeId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<EpisodeDetailT | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    getEpisode(episodeId)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [episodeId]);

  if (error) {
    return (
      <div className="detail-section">
        <p style={{ color: "var(--reject)" }}>{error}</p>
      </div>
    );
  }

  if (!detail) {
    return <div className="detail-section">Loading…</div>;
  }

  const { review, entry, outcomes, report_text } = detail;

  return (
    <div>
      <div className="detail-header">
        <h2>{review.ticker}</h2>
        {review.decision && <span className={`badge ${review.decision}`}>{review.decision}</span>}
        <button className="btn" onClick={onClose}>✕</button>
      </div>

      <div className="detail-section">
        <h3>Scores</h3>
        <div className="score-grid">
          <ScoreCell label="Earnings" score={review.earnings_score} />
          <ScoreCell label="Market" score={review.market_score} />
          <ScoreCell label="Context" score={review.context_score} />
        </div>
        {review.explanation && <p className="fact">{review.explanation}</p>}
        <div className="kv"><span className="k">Red flag</span><span className="v">{review.red_flag ? "yes" : "no"}</span></div>
        <div className="kv"><span className="k">Earnings within 5d</span><span className="v">{review.earnings_within_5d ? "yes" : "no"}</span></div>
      </div>

      <div className="detail-section">
        <h3>Episode</h3>
        <div className="kv"><span className="k">episode_id</span><span className="v">{review.episode_id.slice(0, 8)}…</span></div>
        <div className="kv"><span className="k">Trigger</span><span className="v">{review.episode_trigger}</span></div>
        <div className="kv"><span className="k">Eligibility date</span><span className="v">{review.eligibility_date}</span></div>
        <div className="kv"><span className="k">Review date</span><span className="v">{review.review_date}</span></div>
        <div className="kv"><span className="k">Rule version</span><span className="v">{review.rule_version}</span></div>
        {review.corrects_episode_id && (
          <div className="kv"><span className="k">Corrects</span><span className="v">{review.corrects_episode_id.slice(0, 8)}…</span></div>
        )}
        {review.resolved_from_audit_id && (
          <div className="kv"><span className="k">Resolved from audit</span><span className="v">#{review.resolved_from_audit_id}</span></div>
        )}
      </div>

      <div className="detail-section">
        <h3>Entry</h3>
        {entry ? (
          <>
            <div className="kv"><span className="k">Entry date</span><span className="v">{entry.entry_date}</span></div>
            <div className="kv"><span className="k">Stock open</span><span className="v">${entry.stock_entry_open.toFixed(2)}</span></div>
            <div className="kv"><span className="k">SPY open</span><span className="v">${entry.spy_entry_open.toFixed(2)}</span></div>
            <div className="kv"><span className="k">Sector ({entry.sector_benchmark_ticker}) open</span><span className="v">${entry.sector_entry_open.toFixed(2)}</span></div>
          </>
        ) : (
          <p className="fact">Pending -- applicable session hasn't opened yet, or entry data isn't available.</p>
        )}
      </div>

      <div className="detail-section">
        <h3>Outcomes</h3>
        {outcomes.length === 0 ? (
          <p className="fact">No horizons resolved yet.</p>
        ) : (
          outcomes.map((o) => (
            <div className="outcome-row" key={o.horizon_days}>
              <span>+{o.horizon_days}d ({o.exit_date})</span>
              <span className="mono">
                stock {(o.stock_return * 100).toFixed(1)}% / spy {(o.spy_return * 100).toFixed(1)}% / sector {(o.sector_return * 100).toFixed(1)}%
              </span>
            </div>
          ))
        )}
      </div>

      <div className="detail-section">
        <h3>Report</h3>
        <pre className="report-pre">{report_text}</pre>
      </div>
    </div>
  );
}

function ScoreCell({ label, score }: { label: string; score: number | null }) {
  return (
    <div className="score-cell">
      <div className="label">{label}</div>
      <div className="value"><ScoreBadge score={score} /></div>
    </div>
  );
}
