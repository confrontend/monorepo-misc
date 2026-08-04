import { useEffect, useState } from "react";
import { getBacktestStatus, startBacktest } from "../api";
import type { BacktestResult } from "../types";

const CACHE_KEY = "stock-selection:danelfin-backtest:v1";

// EODHD's free tier (see docs: "within the past year only") only reliably
// serves roughly the trailing 12 months of daily price history; older
// requests can fail with a 402 Payment Required partway through a run
// (observed live -- see progress.md). Default to 11 months back, not 12, to
// leave a small buffer against the exact cutoff. This is only the page's
// starting default -- it does not block a user from picking an older date,
// since the real boundary depends on the account's actual plan/usage and
// isn't something the frontend can verify.
function defaultBacktestStartDate(): string {
  const d = new Date();
  d.setMonth(d.getMonth() - 11);
  return d.toISOString().slice(0, 10);
}

export default function DanelfinBacktestPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [startDate, setStartDate] = useState(defaultBacktestStartDate);
  const [endDate, setEndDate] = useState(today);
  const [topN, setTopN] = useState("10");
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) setResult(JSON.parse(cached) as BacktestResult);
    } catch { localStorage.removeItem(CACHE_KEY); }
  }, []);

  async function run() {
    setBusy(true); setError(null);
    try {
      const job = await startBacktest(startDate, endDate, Number(topN));
      let status = await getBacktestStatus(job.job_id);
      while (status.status === "running") {
        setProgress(status.progress ?? null);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = await getBacktestStatus(job.job_id);
      }
      if (status.status === "failed") throw new Error(status.error ?? "Backtest failed");
      if (status.result) { setResult(status.result); localStorage.setItem(CACHE_KEY, JSON.stringify(status.result)); }
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); setProgress(null); }
  }

  return <div className="page">
    <div className="page-header"><div><h1>Danelfin Backtest</h1><div className="page-sub">Historical top-ranking prototype using Danelfin scores and EODHD prices. Cached results are restored from this browser.</div></div></div>
    <div className="hr" />
    <section className="card elev-sm backtest-controls">
      <div className="field-grid-2"><label className="field"><span>Start date</span><input className="input" type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></label><label className="field"><span>End date</span><input className="input" type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></label></div>
      <label className="field"><span>Stocks selected per month</span><input className="input" type="number" min="1" max="100" value={topN} onChange={(event) => setTopN(event.target.value)} /></label>
      <div className="callout">Each month, the system fetches that date's historical Danelfin ranking, selects the top stocks, and enters at the next trading-session open. This does not reproduce Danelfin's proprietary historical Best Stocks list.</div>
      <div className="callout">Defaults to the last ~11 months because EODHD's free tier only reliably serves roughly the past year of daily price history. Picking an earlier start date may work depending on your plan, but can also fail partway through with an EODHD payment-required error -- that's an account/plan limit, not a bug in this page.</div>
      <button className="btn btn-primary" onClick={run} disabled={busy || !startDate || !endDate}>{busy ? "Running backtest…" : "Run backtest"}</button>
      {busy && progress && <div className="backtest-progress"><strong>{String(progress.message ?? "Running")}</strong><div className="progress-track"><div className="progress-fill" style={{ width: `${progress.total ? (Number(progress.current ?? 0) / Number(progress.total)) * 100 : 5}%` }} /></div><span>{String(progress.phase ?? "working")} {progress.current != null && progress.total != null ? `— ${progress.current}/${progress.total}` : ""}{progress.ticker ? ` — ${progress.ticker}` : ""}</span></div>}
      {error && <div className="banner error">{error}</div>}
    </section>
    {result && <BacktestOutput result={result} />}
  </div>;
}

function BacktestOutput({ result }: { result: BacktestResult }) {
  const summary = result.summary;
  return <>
    <div className="stat-grid backtest-stats"><div className="card"><div className="card-kicker">Portfolio</div><div className="card-title">{percent(summary.portfolio_return)}</div><div className="page-meta">Cumulative return</div></div><div className="card"><div className="card-kicker">SPY</div><div className="card-title">{percentOrDash(summary.spy_return)}</div><div className="page-meta">Benchmark return</div></div><div className="card"><div className="card-kicker">Excess</div><div className="card-title">{percentOrDash(summary.excess_return)}</div><div className="page-meta">Portfolio minus SPY</div></div><div className="card"><div className="card-kicker">Cache</div><div className="card-title">{result.cache.hits} / {result.cache.misses}</div><div className="page-meta">Hits / new calls</div></div></div>
    {result.warnings.length > 0 && <div className="banner">{result.warnings.join(" · ")}</div>}
    <details className="card elev-sm collapsible-table" open>
      <summary><span><strong>Trade list</strong><span className="page-meta">{result.trades.length} stored trade(s) · run {result.run_id.slice(0, 8)}</span></span><span className="collapse-hint">Collapse table</span></summary>
      <div className="table-scroll"><table className="table"><thead><tr><th>Ticker</th><th>Score date</th><th>Entry</th><th>Exit</th><th>AI score</th><th>Return</th></tr></thead><tbody>{result.trades.map((trade, index) => <tr key={`${trade.ticker}-${trade.entry_date}-${index}`}><td className="ticker-cell">{trade.ticker}</td><td>{trade.score_date}</td><td>{trade.entry_date}</td><td>{trade.exit_date}</td><td>{trade.ai_score ?? "—"}</td><td className={trade.return >= 0 ? "text-positive" : "text-negative"}>{percent(trade.return)}</td></tr>)}</tbody></table></div>
    </details>
  </>;
}

function percent(value: number): string { return `${(value * 100).toFixed(2)}%`; }
function percentOrDash(value: number | null): string { return value == null ? "—" : percent(value); }
