import { useEffect, useState } from "react";
import { addManualCandidate, fetchBestStocks, fetchTradeIdeas, ingestLive, listCandidates } from "../api";
import Badge from "../components/Badge";
import { debugLog } from "../debug";
import type { BestStocksResult, CandidateRow, FetchTradeIdeasResult } from "../types";

interface Props { connected: boolean; onRefresh: () => void; }

const CANDIDATES_CACHE_KEY = "stock-selection:candidates:v1";
const BEST_STOCKS_CACHE_KEY = "stock-selection:best-stocks:v1";

export default function CandidateIntakePage({ connected, onRefresh }: Props) {
  const [candidates, setCandidates] = useState<CandidateRow[]>([]);
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [ticker, setTicker] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchTradeIdeasResult | null>(null);
  const [bestStocks, setBestStocks] = useState<BestStocksResult | null>(null);
  const [statuses, setStatuses] = useState<Record<number, string>>({});

  useEffect(() => {
    try {
      const cached = localStorage.getItem(CANDIDATES_CACHE_KEY);
      if (cached) setCandidates(JSON.parse(cached) as CandidateRow[]);
      const cachedBestStocks = localStorage.getItem(BEST_STOCKS_CACHE_KEY);
      if (cachedBestStocks) setBestStocks(JSON.parse(cachedBestStocks) as BestStocksResult);
    } catch {
      localStorage.removeItem(CANDIDATES_CACHE_KEY);
      localStorage.removeItem(BEST_STOCKS_CACHE_KEY);
    }
  }, []);

  async function refreshCandidates() {
    setBusy("refresh"); setError(null);
    try {
      const next = await listCandidates();
      setCandidates(next);
      localStorage.setItem(CANDIDATES_CACHE_KEY, JSON.stringify(next));
      setMessage(`Candidate list refreshed (${next.length} record${next.length === 1 ? "" : "s"}).`);
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function fetchIdeas() {
    setBusy("fetch"); setError(null); setMessage(null);
    try {
      // Danelfin's v3 US endpoint is the default; market=us causes a 400.
      const next = await fetchTradeIdeas(asOfDate, { direction: "long", limit: 100 });
      setResult(next);
      onRefresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function fetchBestStocksSnapshot() {
    setBusy("beststocks"); setError(null); setMessage(null);
    try {
      const next = await fetchBestStocks(asOfDate);
      setBestStocks(next);
      localStorage.setItem(BEST_STOCKS_CACHE_KEY, JSON.stringify(next));
      setMessage(`Best Stocks snapshot loaded (${next.stocks.length} ranked stock${next.stocks.length === 1 ? "" : "s"}). Click Refresh to load it into Candidate history.`);
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
      setTicker(""); setMessage(`${value} was added. Click Refresh to load it into the cached list.`);
      onRefresh();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(null); }
  }

  async function validate(candidate: CandidateRow) {
    setBusy(candidate.ticker); setError(null); setStatuses((s) => ({ ...s, [candidate.candidate_id]: "Validating" }));
    debugLog(`candidate validation started: ${candidate.ticker}`, {
      candidate,
      request: { tickers: [candidate.ticker], as_of_date: asOfDate, include_candidates: false },
    });
    try {
      const response = await ingestLive([candidate.ticker], asOfDate, false);
      const item = response.price_and_earnings[0];
      const hasWarnings = (item?.warnings?.length ?? 0) > 0;
      debugLog(`candidate validation result: ${candidate.ticker}`, {
        price_and_earnings: item,
        episodes: response.episodes?.[candidate.ticker] ?? [],
        candidates: response.candidates,
      });
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
          <div className="card-title">Fetch long candidates from Danelfin</div>
          <p className="card-body">Only long Trade Ideas are accepted because this workflow validates stocks for possible purchase. They are stored as eligibility candidates, then validated separately.</p>
          <label className="field"><span>As-of date</span><input className="input" type="date" value={asOfDate} onChange={(e) => setAsOfDate(e.target.value)} /></label>
          <span className="tag tag-neutral"><span className="tag-dot" style={{ background: connected ? "var(--color-confirm-dot)" : "var(--color-reject-dot)" }} />{connected ? "API connected" : "API unavailable"}</span>
          <button className="btn btn-secondary btn-block" onClick={fetchBestStocksSnapshot} disabled={!connected || busy !== null}>{busy === "beststocks" ? "Fetching..." : "Fetch Best Stocks (ranked)"}</button>
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

      {bestStocks && <BestStocksTable result={bestStocks} />}

      {(message || error) && <div className={`banner ${error ? "error" : "success"}`}>{error ?? message}</div>}
      <details className="collapsible-table">
        <summary><span><strong>Long Candidates</strong><span className="page-meta">{candidates.length} cached candidate record(s)</span></span><span className="collapse-hint">Expand table</span></summary>
        <div className="section-heading"><span /> <button className="btn btn-secondary" onClick={refreshCandidates} disabled={busy !== null}>{busy === "refresh" ? "Refreshing…" : "Refresh"}</button></div>
        <div className="table-scroll"><table className="table candidate-table"><thead><tr><th>Ticker</th><th>Source</th><th>Date</th><th>Direction</th><th>Rank</th><th>AI</th><th>Technical</th><th>Fundamental</th><th>Status</th><th>Action</th></tr></thead><tbody>
        {candidates.map((c) => <tr key={c.candidate_id}><td className="ticker-cell">{c.ticker}</td><td><span className="tag tag-neutral">{c.source}</span></td><td className="text-muted">{c.date}</td><td>{c.direction ?? "—"}</td><td>{c.source_rank ?? "—"}</td><td>{c.ai_score ?? "—"}</td><td>{c.technical_score ?? "—"}</td><td>{c.fundamental_score ?? "—"}</td><td><Badge kind={statuses[c.candidate_id] === "Failed" ? "Reject" : statuses[c.candidate_id] === "Insufficient data" ? "Wait" : "neutral"} label={statuses[c.candidate_id] ?? "New"} /></td><td><button className="btn btn-ghost" onClick={() => validate(c)} disabled={busy !== null}>{busy === c.ticker ? "Validating…" : "Validate"}</button></td></tr>)}
        {candidates.length === 0 && <tr><td colSpan={10}><div className="empty-state">No long candidates yet. Fetch Danelfin long Trade Ideas or add a known ticker.</div></td></tr>}
        </tbody></table></div>
      </details>
    </div>
  );
}

function BestStocksTable({ result }: { result: BestStocksResult }) {
  return <details className="card elev-sm best-stocks-card collapsible-table">
    <summary><span><strong>Danelfin Best Stocks</strong><span className="page-meta">Official ranked snapshot · {result.as_of_date} · {result.stocks.length} result(s)</span></span><span className="collapse-hint">Expand table</span></summary>
    <div className="section-heading"><span /><span className="score-legend"><ScoreValue value={10} /> strong <ScoreValue value={5} /> middle <ScoreValue value={2} /> weak</span></div>
    {result.warnings.length > 0 && <div className="banner error">{result.warnings.join(" ")}</div>}
    <div className="table-scroll"><table className="table"><thead><tr><th>Rank</th><th>Ticker</th><th>AI</th><th>Technical</th><th>Fundamental</th><th>Sentiment</th><th>Low risk</th><th>YTD</th><th>Snapshot date</th></tr></thead><tbody>
      {result.stocks.map((stock) => <tr key={`${stock.ticker}-${stock.rank ?? "unranked"}`}><td><ScoreValue value={stock.rank} kind="rank" /></td><td className="ticker-cell">{stock.ticker}</td><td><ScoreValue value={stock.ai_score} /></td><td><ScoreValue value={stock.technical_score} /></td><td><ScoreValue value={stock.fundamental_score} /></td><td><ScoreValue value={stock.sentiment_score} /></td><td><ScoreValue value={stock.low_risk_score} /></td><td><ScoreValue value={stock.perf_ytd} kind="ytd" format="percent" /></td><td className="text-muted">{stock.source_date ?? "—"}</td></tr>)}
      {result.stocks.length === 0 && <tr><td colSpan={9}><div className="empty-state">No Best Stocks results were returned.</div></td></tr>}
    </tbody></table></div>
  </details>;
}

function ScoreValue({ value, kind = "score", format = "number" }: { value: number | null; kind?: "score" | "rank" | "ytd"; format?: "number" | "percent" }) {
  if (value == null) return <span className="score-value missing"><span className="score-icon" aria-hidden="true">●</span>—</span>;
  const status = kind === "ytd" ? (value > 0 ? "good" : value < 0 ? "bad" : "middle") : kind === "rank" ? (value <= 5 ? "good" : value <= 15 ? "middle" : "bad") : value >= 7 ? "good" : value >= 4 ? "middle" : "bad";
  const display = format === "percent" ? `${(value * 100).toFixed(2)}%` : value;
  return <span className={`score-value ${status}`}><span className="score-icon" aria-hidden="true">●</span>{display}</span>;
}

function FetchSummary({ result }: { result: FetchTradeIdeasResult }) {
  return <div className="result-tiles"><div className="result-tile stored"><div className="n">{result.successful_count}</div><div className="label">Stored</div></div><div className="result-tile skipped"><div className="n">{result.skipped_count}</div><div className="label">Skipped</div></div><div className="result-tile failed"><div className="n">{result.failed_count}</div><div className="label">Failed</div></div><div className="result-tile"><div className="n">{result.total_ideas}</div><div className="label">Found</div></div></div>;
}
