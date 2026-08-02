import Badge from "../components/Badge";
import type { InsufficientDataCase } from "../types";

interface Props { cases: InsufficientDataCase[]; onSelect: (item: InsufficientDataCase) => void; }

export default function IncompleteDataPage({ cases, onSelect }: Props) {
  return <div className="page">
    <div className="page-header"><div><h1>Incomplete Data</h1><div className="page-sub">Cases waiting for required Earnings, Market, or Context inputs before scoring.</div></div><div className="page-meta">{cases.filter((c) => !c.resolved).length} open case(s)</div></div>
    <div className="hr" />
    {cases.length === 0 ? <div className="empty-state">No incomplete-data cases.</div> : <div className="table-scroll"><table className="table incomplete-table"><thead><tr><th>Ticker</th><th>Original trigger</th><th>Eligibility date</th><th>Missing groups</th><th>Missing fields</th><th>Last checked</th><th>Status</th><th /></tr></thead><tbody>
      {cases.map((item) => {
        const groups = [...new Set(item.missing_fields.map((f) => f.missing_group))];
        return <tr key={item.audit_id} data-clickable onClick={() => onSelect(item)}>
          <td className="ticker-cell">{item.ticker}</td>
          <td>{item.episode_trigger}</td>
          <td className="text-muted">{item.eligibility_date}</td>
          <td><div className="tag-list">{groups.map((group) => <span className="tag tag-outline" key={group}>{group}</span>)}</div></td>
          <td><div className="missing-preview">{item.missing_fields.slice(0, 3).map((field, index) => <span key={index}>{field.missing_field}</span>)}{item.missing_fields.length > 3 && <span>+{item.missing_fields.length - 3} more</span>}</div></td>
          <td className="text-muted">{item.checked_at?.replace("T", " ").slice(0, 16)}</td>
          <td><Badge kind={item.resolved ? "Resolved" : "Open"} /></td>
          <td><button type="button" className="btn btn-ghost" onClick={(event) => { event.stopPropagation(); onSelect(item); }}>View</button></td>
        </tr>;
      })}
    </tbody></table></div>}
  </div>;
}
