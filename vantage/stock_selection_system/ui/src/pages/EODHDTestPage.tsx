import { useState } from "react";
import { testEODHD } from "../api";
import type { EODHDTestResult, EODHDTestSection, EODHDTestStatus } from "../types";

const TESTS: { key: string; label: string; detail: (section: EODHDTestSection) => string }[] = [
  { key: "candidate_prices", label: "Candidate price history", detail: (section) => `${section.data?.bar_count ?? 0} valid bars` },
  { key: "spy_prices", label: "SPY price history", detail: (section) => `${section.data?.bar_count ?? 0} valid bars` },
  { key: "reported_earnings", label: "Reported earnings", detail: (section) => section.data ? `${section.data.fiscal_period_end ?? "Quarter unavailable"} · EPS ${section.data.actual_eps ?? "—"} vs ${section.data.estimated_eps ?? "—"}` : section.error ?? "No reported quarter" },
  { key: "forward_estimates", label: "Forward estimate history", detail: (section) => section.data ? `${section.data.fiscal_period_end ?? "Quarter unavailable"} · ${section.data.current_consensus_eps ?? "—"} now / ${section.data.consensus_eps_30_days_ago ?? "—"} 30d ago` : section.error ?? "No forward estimate" },
  { key: "earnings_calendar", label: "Upcoming earnings date", detail: (section) => section.data ? `${section.data.scheduled_report_date ?? "Date unavailable"} · ${section.data.within_5_nyse_trading_days ? "within 5 NYSE days" : "more than 5 NYSE days"}` : section.error ?? "No upcoming date" },
];

export default function EODHDTestPage() {
  const [ticker, setTicker] = useState("ATI");
  const [asOfDate, setAsOfDate] = useState(new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState<EODHDTestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runTest() {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await testEODHD(ticker.trim().toUpperCase(), asOfDate)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="page">
    <div className="page-header"><div><h1>EODHD Test</h1><div className="page-sub">Read-only diagnostic for whether EODHD supplies all candidate-validation inputs.</div></div></div>
    <div className="hr" />
    <section className="card elev-sm eodhd-controls">
      <div className="field-grid-2">
        <label className="field"><span>Ticker</span><input className="input" value={ticker} onChange={(event) => setTicker(event.target.value.toUpperCase())} placeholder="ATI" /></label>
        <label className="field"><span>As-of date</span><input className="input" type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} /></label>
      </div>
      <button className="btn btn-primary" onClick={runTest} disabled={busy || !ticker.trim() || !asOfDate}>{busy ? "Testing EODHD…" : "Test EODHD"}</button>
      {error && <div className="banner error">{error}</div>}
    </section>

    {result && <>
      {result.errors.length > 0 && <div className="banner error">{result.errors.join(" · ")}</div>}
      {result.warnings.length > 0 && <div className="banner">{result.warnings.join(" · ")}</div>}
      <div className="section-heading"><h3>Validation requirements</h3><span className={`tag ${result.all_required_data_available ? "tag-success" : "tag-outline"}`}>{result.all_required_data_available ? "All available" : "Incomplete"}</span></div>
      <div className="table-scroll"><table className="table eodhd-table"><thead><tr><th>Requirement</th><th>Status</th><th>Details</th></tr></thead><tbody>
        {TESTS.map((item) => { const section = result.tests[item.key]; return <tr key={item.key}><td>{item.label}</td><td><Status status={section?.status} /></td><td>{section ? item.detail(section) : "Not returned"}{section?.http_status ? ` · HTTP ${section.http_status}` : ""}</td></tr>; })}
        <tr><td>Full payload available</td><td><Status status={result.all_required_data_available ? "passed" : "missing"} /></td><td>{result.all_required_data_available ? "Yes" : "No"}</td></tr>
      </tbody></table></div>
      <div className="eodhd-payloads">
        <h3>Diagnostics</h3>
        {TESTS.map((item) => { const section = result.tests[item.key]; return <details className="card" key={item.key}><summary>{item.label} · {section?.status ?? "not returned"}{section?.http_status ? ` · HTTP ${section.http_status}` : ""}</summary><div className="json-grid"><div><h4>Normalized</h4><pre>{pretty(section?.data)}</pre></div><div><h4>Provider response</h4><pre>{pretty(section?.provider_response)}</pre></div><div><h4>Provider diagnostics</h4><pre>{pretty(section?.provider_diagnostics)}</pre></div></div></details>; })}
      </div>
    </>}
  </div>;
}

function Status({ status }: { status?: EODHDTestStatus }) {
  const label = status === "passed" ? "Passed" : status ? status.replaceAll("_", " ") : "Unknown";
  return <span className={`tag ${status === "passed" ? "tag-success" : "tag-outline"}`}>{label}</span>;
}

function pretty(value: unknown): string { return JSON.stringify(value ?? null, null, 2); }
