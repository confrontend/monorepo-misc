import type { InsufficientDataCase } from "../types";

export default function InsufficientDataCases({ cases }: { cases: InsufficientDataCase[] }) {
  if (cases.length === 0) {
    return <div className="empty-state">No insufficient-data cases -- every detected trigger has had enough data to score.</div>;
  }

  return (
    <div>
      {cases.map((c) => (
        <div className="case-card" key={c.audit_id}>
          <div className="case-card-header">
            <span className="ticker">{c.ticker}</span>
            <span className="trigger mono">{c.episode_trigger} · eligible {c.eligibility_date}</span>
            <span style={{ flex: 1 }} />
            <span className={`status-chip ${c.resolved ? "resolved" : "unresolved"}`}>
              {c.resolved ? "Resolved" : "Open"}
            </span>
          </div>
          <div className="kv"><span className="k">as_of_date checked</span><span className="v">{c.as_of_date}</span></div>
          <div className="kv"><span className="k">First checked</span><span className="v">{c.checked_at}</span></div>
          {c.trigger_source_table && (
            <div className="kv">
              <span className="k">Source event</span>
              <span className="v">{c.trigger_source_table}#{c.trigger_source_row_id}</span>
            </div>
          )}
          {c.resolved_episode_id && (
            <div className="kv"><span className="k">Resolved episode</span><span className="v">{c.resolved_episode_id.slice(0, 8)}…</span></div>
          )}
          <div className="missing-list">
            {c.missing_fields.map((f, i) => (
              <span className="missing-chip" key={i}>{f.missing_group}.{f.missing_field}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
