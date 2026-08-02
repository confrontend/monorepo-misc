import { useEffect, useState } from "react";
import { getEpisode } from "../api";
import type { EpisodeDetail as EpisodeDetailT, InsufficientDataCase } from "../types";
import Badge, { type BadgeKind } from "./Badge";

export type DrawerState =
  | { type: "episode"; episodeId: string }
  | { type: "incomplete"; case: InsufficientDataCase }
  | null;

interface Props {
  drawer: DrawerState;
  onClose: () => void;
}

export default function DetailDrawer({ drawer, onClose }: Props) {
  if (!drawer) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel" onClick={(e) => e.stopPropagation()}>
        {drawer.type === "episode" ? (
          <EpisodeDrawerContent episodeId={drawer.episodeId} onClose={onClose} />
        ) : (
          <IncompleteDrawerContent item={drawer.case} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="btn btn-ghost btn-icon" aria-label="Close" onClick={onClose}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>
  );
}

function EpisodeDrawerContent({ episodeId, onClose }: { episodeId: string; onClose: () => void }) {
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
      <>
        <div className="drawer-head">
          <span className="drawer-ticker">Error</span>
          <CloseButton onClose={onClose} />
        </div>
        <p style={{ color: "var(--color-accent-700)" }}>{error}</p>
      </>
    );
  }

  if (!detail) {
    return (
      <>
        <div className="drawer-head">
          <span className="drawer-ticker">Loading…</span>
          <CloseButton onClose={onClose} />
        </div>
      </>
    );
  }

  const { review, entry, outcomes, report_text } = detail;

  return (
    <>
      <div className="drawer-head">
        <div className="id-row">
          <span className="drawer-ticker">{review.ticker}</span>
          {review.decision && <Badge kind={review.decision as BadgeKind} />}
        </div>
        <CloseButton onClose={onClose} />
      </div>

      <div className="drawer-meta-grid">
        <div><div className="k">Episode</div>{review.episode_id.slice(0, 8)}…</div>
        <div><div className="k">Review date</div>{review.review_date}</div>
        <div><div className="k">Rule version</div>{review.rule_version}</div>
        <div><div className="k">Trigger</div>{review.episode_trigger}</div>
      </div>

      {review.corrects_episode_id && (
        <div className="tag tag-outline" style={{ marginBottom: 16, width: "fit-content" }}>
          Corrects {review.corrects_episode_id.slice(0, 8)}…
        </div>
      )}
      {review.resolved_from_audit_id && (
        <div className="tag tag-outline" style={{ marginBottom: 16, width: "fit-content" }}>
          Resolved from insufficient-data case #{review.resolved_from_audit_id}
        </div>
      )}

      <h4>Scores &amp; evidence</h4>
      <div className="drawer-score-grid">
        <ScoreCard label="Earnings" score={review.earnings_score} evidence={review.earnings_fact} />
        <ScoreCard label="Market" score={review.market_score} evidence={review.market_fact} />
        <ScoreCard label="Context" score={review.context_score} evidence={review.context_fact} />
      </div>

      <h4 style={{ marginBottom: 6 }}>Decision explanation</h4>
      <p style={{ fontSize: 13, marginBottom: 18 }}>{review.explanation ?? "—"}</p>

      <div className="hr" style={{ margin: "0 0 16px" }} />
      <h4 style={{ marginBottom: 6 }}>Entry price</h4>
      <p style={{ fontSize: 13, marginBottom: 18 }}>
        {entry
          ? `$${entry.stock_entry_open.toFixed(2)} on ${entry.entry_date} (session open) — SPY $${entry.spy_entry_open.toFixed(2)}, ${entry.sector_benchmark_ticker} $${entry.sector_entry_open.toFixed(2)}`
          : review.decision === "Reject"
          ? "No entry taken — decision was Reject."
          : "Pending — applicable session hasn't opened yet, or entry data isn't available."}
      </p>

      {outcomes.length > 0 && (
        <>
          <h4 style={{ marginBottom: 10 }}>Forward outcome</h4>
          <table className="table" style={{ marginBottom: 16 }}>
            <thead>
              <tr><th>Days</th><th>Date</th><th>Stock</th><th>vs SPY</th><th>vs Sector</th></tr>
            </thead>
            <tbody>
              {outcomes.map((o) => (
                <tr key={o.outcome_id}>
                  <td>{o.horizon_days}d</td>
                  <td className="text-muted">{o.exit_date}</td>
                  <td className="num">{(o.stock_return * 100).toFixed(1)}%</td>
                  <td className="num">{(o.spy_return * 100).toFixed(1)}%</td>
                  <td className="num">{(o.sector_return * 100).toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h4 style={{ marginBottom: 6 }}>Report</h4>
      <pre style={{ fontFamily: "ui-monospace, Consolas, monospace", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-word", background: "var(--color-surface)", padding: 12, lineHeight: 1.6 }}>
        {report_text}
      </pre>
    </>
  );
}

function ScoreCard({ label, score, evidence }: { label: string; score: number | null; evidence: string | null }) {
  return (
    <div className="card" style={{ gap: 6 }}>
      <div className="card-kicker">{label}</div>
      <div style={{ fontFamily: "var(--font-heading)", fontWeight: 800, fontSize: 20 }}>{score ?? "—"}</div>
      <p className="card-body">{evidence ?? "—"}</p>
    </div>
  );
}

function IncompleteDrawerContent({ item, onClose }: { item: InsufficientDataCase; onClose: () => void }) {
  return (
    <>
      <div className="drawer-head">
        <span className="drawer-ticker">{item.ticker}</span>
        <CloseButton onClose={onClose} />
      </div>
      <div className="tag tag-neutral" style={{ marginBottom: 16, width: "fit-content" }}>
        Awaiting required data — {item.resolved ? "Resolved" : "Open"}
      </div>
      <div className="drawer-meta-grid">
        <div><div className="k">Original trigger</div>{item.episode_trigger}</div>
        <div><div className="k">Eligibility date</div>{item.eligibility_date}</div>
        <div><div className="k">Source event</div>{item.trigger_source_table ? `${item.trigger_source_table}#${item.trigger_source_row_id}` : "—"}</div>
        <div><div className="k">Retry after</div>{item.retry_after ?? "—"}</div>
        <div><div className="k">First checked</div>{item.checked_at}</div>
        <div><div className="k">As-of date checked</div>{item.as_of_date}</div>
      </div>
      {item.resolved_episode_id && (
        <div className="tag tag-outline" style={{ marginBottom: 16, width: "fit-content" }}>
          Resolved — Episode {item.resolved_episode_id.slice(0, 8)}…
        </div>
      )}
      <h4 style={{ marginBottom: 8 }}>Missing groups</h4>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 16 }}>
        {[...new Set(item.missing_fields.map((f) => f.missing_group))].map((g) => (
          <span className="tag tag-neutral" key={g}>{g}</span>
        ))}
      </div>
      <h4 style={{ marginBottom: 8 }}>Missing fields</h4>
      <ul style={{ fontSize: 13, paddingLeft: 18, margin: 0 }}>
        {item.missing_fields.map((f, i) => (
          <li key={i} style={{ marginBottom: 4 }}>{f.missing_group}.{f.missing_field}</li>
        ))}
      </ul>
    </>
  );
}
