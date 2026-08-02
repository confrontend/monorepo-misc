import { useEffect, useState } from "react";
import { addManualCandidate, fetchTradeIdeas, ingestLive, listCandidates } from "../api";
import Badge from "../components/Badge";
import type { CandidateRow, FetchTradeIdeasResult } from "../types";

interface Props { connected: boolean; onRefresh: () => void; }

export default function CandidateIntakePage({ connected, onRefresh }: Props) {
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [ticker, setTicker] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchTradeIdeasResult | null>(null);
  const [statuses, setStatuses] = useState<Record<number, string>>({});

  const refreshCandidates = () => listCandidates().then(setCandidates).catch((e) => setError((e as Error).message));
  useEffect(() => { refreshCandidates(); }, []);

  async function fetchIdeas() {
    setBusy("fetch"); setError(null); setMessage(null);
    try {
      const next = await fetchTradeIdeas(asOfDate, { market: "us", limit: 100 });
      setResult(next);
      await refreshCandidates();
      onRefresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function addManual() {
    const value = ticker.trim().toUpperCase();
    if (!value) { setError("Enter a ticker first."); return; }
    setBusy("manual"); setError(null); setMessage(null);
    try {
      await addManualCandidate([value], asOfDate);
      setTicker(""); setMessage(`${value} added to candidates.`);
      await refreshCandidates(); onRefresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function validate(candidate: CandidateRow) {
    setBusy(candidate.ticker); setError(null); setStatuses((s) => ({ ...s, [candidate.candidate_id]: "Validating" }));
    try {
      const response = await ingestLive([candidate.ticker], asOfDate, false);
      const item = response.price_and_earnings[0];
      const hasWarnings = (item?.warnings?.length ?? 0) > 0;
      console.groupCollapsed(`[candidate validation] ${candidate.ticker}`);
      console.log("write results", item?.wrote ?? {});
      console.log("warnings", item?.warnings ?? []);
      console.log("episodes", response.episodes?.[candidate.ticker] ?? []);
      console.groupEnd();
      setStatuses((s) => ({ ...s, [candidate.candidate_id]: hasWarnings ? "Insufficient data" : "Validated" }));
      setMessage(`${candidate.ticker} validation completed${hasWarnings ? " with missing data" : ""}.`);
      onRefresh();
    } catch (e) {
      setStatuses((s) => ({ ...s, [candidate.candidate_id]: "Failed" }));
      setError((e as Error).message);
    } finally { setBusy(null); }
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Candidate Intake</h1>
          <div className="page-sub">This answers one question: which stocks should we examine? It does not decide anything.</div>
        </div>
      </div>
      <div className="hr" />

      <div className="two-col-grid">
        <section className="card elev-sm intake-card">
          <div className="card-kicker">Automatic — Danelfin discovers</div>
          <div className="card-title">Fetch candidates from Danelfin</div>
          <p className="card-body">You do not type tickers here. Trade Ideas are stored as eligibility candidates, then validated separately.</p>
          <label className="field"><span>As-of date</span><input className="input" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} /></label>
          <span className="tag tag-neutral"><span className="tag-dot" style={{ background: connected ? "var(--color-confirm-dot)" : "var(--color-reject-dot)" }} />{connected ? "API connected" : "API unavailable"}</span>
          <button className="btn btn-primary btn-block" onClick={fetchIdeas} disabled={!connected || busy !== null}>{busy === "fetch" ? "Fetching…" : "Fetch candidates"}</button>
          {result && <FetchSummary result={result} />}
          <div className="callout">Danelfin supplies eligibility metadata only. It does not determine Confirm, Mixed, Reject, or Wait.</div>
        </section>

        <section className="card elev-sm intake-card">
          <div className="card-kicker">Manual — you decide</div>
          <div className="card-title">Add a known ticker</div>
          <p className="card-body">Use this when you already know which ticker you want to evaluate. It bypasses Danelfin eligibility.</p>
          <label className="field"><span>Ticker</span><input className="input" placeholder="e.g. AAPL" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} /></label>
          <div className="field-grid-2"><label className="field"><span>As-of date</span><input className="input" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} /></label><label className="field"><span>Source</span><span className="tag tag-outline">Manual</span></label></div>
          <button className="btn btn-primary btn-block" onClick={addManual} disabled={busy !== null || !ticker.trim()}>{busy === "manual" ? "Adding…" : "Add to candidates"}</button>
          <div className="callout">Adding a candidate does not automatically create a decision. Validation and scoring remain separate.</div>
        </section>
      </div>

      {(message || error) && <div className={`banner ${error ? "error" : "success"}`}>{error ?? message}</div>}
      <div className="section-heading"><h3>Candidate history</h3><span className="page-meta">{candidates.length} candidate record(s)</span></div>
      <div className="table-scroll"><table className="table candidate-table"><thead><tr><th>Ticker</th><th>Source</th><th>Date</th><th>Direction</th><th>Rank</th><th>AI</th><th>Technical</th><th>Fundamental</th><th>Status</th><th>Action</th></tr></thead><tbody>
        {candidates.map((c) => <tr key={c.candidate_id}><td className="ticker-cell">{c.ticker}</td><td><span className="tag tag-neutral">{c.source}</span></td><td className="text-muted">{c.date}</td><td>{c.direction ?? "—"}</td><td>{c.source_rank ?? "—"}</td><td>{c.ai_score ?? "—"}</td><td>{c.technical_score ?? "—"}</td><td>{c.fundamental_score ?? "—"}</td><td><Badge kind={statuses[c.candidate_id] === "Failed" ? "Reject" : statuses[c.candidate_id] === "Insufficient data" ? "Wait" : "neutral"} label={statuses[c.candidate_id] ?? "New"} /></td><td><button className="btn btn-ghost" onClick={() => validate(c)} disabled={busy !== null}>{busy === c.ticker ? "Validating…" : "Validate"}</button></td></tr>)}
        {candidates.length === 0 && <tr><td colSpan={10}><div className="empty-state">No candidates yet. Fetch Danelfin Trade Ideas or add a known ticker.</div></td></tr>}
      </tbody></table></div>
    </div>
  );
}

function FetchSummary({ result }: { result: FetchTradeIdeasResult }) {
  return <div className="result-tiles"><div className="result-tile stored"><div className="n">{result.successful_count}</div><div className="label">Stored</div></div><div className="result-tile skipped"><div className="n">{result.skipped_count}</div><div className="label">Skipped</div></div><div className="result-tile failed"><div className="n">{result.failed_count}</div><div className="label">Failed</div></div><div className="result-tile"><div className="n">{result.total_ideas}</div><div className="label">Found</div></div></div>;
}
