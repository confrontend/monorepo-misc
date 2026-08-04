import { useState } from "react";
import { ingestLive, markContextReviewed } from "../api";
import type { IngestLiveResult, MarkContextReviewedResult } from "../types";

interface Props {
  onRunComplete: () => void;
}

// Live ingestion isn't gated by the trading-calendar check the retry
// actions have (it just filters price bars/estimates/calendar rows <= this
// date, no validation) -- so, unlike RunControls' DEFAULT_AS_OF_DATE, today's
// real date is a perfectly good default here.
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseTickers(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0);
}

export default function LiveIngestControls({ onRunComplete }: Props) {
  const [open, setOpen] = useState(false);
  const [tickersInput, setTickersInput] = useState("");
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [includeCandidates, setIncludeCandidates] = useState(true);
  const [busy, setBusy] = useState<"ingest" | "context" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<IngestLiveResult | null>(null);
  const [contextResult, setContextResult] = useState<MarkContextReviewedResult | null>(null);

  const tickers = parseTickers(tickersInput);

  async function handleIngest() {
    if (tickers.length === 0) {
      setError("Enter at least one ticker (comma-separated).");
      return;
    }
    setBusy("ingest");
    setError(null);
    setContextResult(null);
    try {
      const r = await ingestLive(tickers, asOfDate, includeCandidates);
      setResult(r);
      onRunComplete();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleMarkContextReviewed() {
    if (tickers.length === 0) {
      setError("Enter at least one ticker (comma-separated).");
      return;
    }
    setBusy("context");
    setError(null);
    try {
      const r = await markContextReviewed(tickers, asOfDate);
      setContextResult(r);
      onRunComplete();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <button className="btn" onClick={() => setOpen((v) => !v)} title="Fetch real price/earnings/candidate data from Alpha Vantage + Danelfin">
        Live ingestion {open ? "▴" : "▾"}
      </button>

      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 10,
            background: "var(--panel-bg, #fff)", border: "1px solid var(--border, #ddd)",
            borderRadius: 6, padding: 12, width: 340, boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label style={{ fontSize: 12 }}>
              Tickers (comma-separated)
              <input
                type="text"
                value={tickersInput}
                onChange={(e) => setTickersInput(e.target.value)}
                placeholder="ATI, MSFT"
                style={{ width: "100%", boxSizing: "border-box", marginTop: 2 }}
              />
            </label>

            <label style={{ fontSize: 12 }}>
              As-of date
              <input
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", marginTop: 2 }}
              />
            </label>

            <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
              <input
                type="checkbox"
                checked={includeCandidates}
                onChange={(e) => setIncludeCandidates(e.target.checked)}
              />
              Include Danelfin candidates (unverified response shape)
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn" onClick={handleIngest} disabled={busy !== null} style={{ flex: 1 }}
                title="Fetches price/earnings/estimates/calendar (+ candidates) and runs trigger detection/scoring">
                {busy === "ingest" ? "Fetching…" : "Fetch live data"}
              </button>
              <button className="btn" onClick={handleMarkContextReviewed} disabled={busy !== null} style={{ flex: 1 }}
                title="Explicitly asserts you've checked guidance/insider/material news for these tickers through this date -- never set automatically">
                {busy === "context" ? "Marking…" : "Mark context reviewed"}
              </button>
            </div>

            {error && <div style={{ fontSize: 12, color: "var(--reject)" }}>{error}</div>}

            {contextResult && (
              <div style={{ fontSize: 12, color: "var(--confirm)" }}>
                Context marked reviewed through {contextResult.as_of_date} for {contextResult.marked.join(", ")}.
              </div>
            )}

            {result && <IngestResultSummary result={result} />}
          </div>
        </div>
      )}
    </div>
  );
}

function IngestResultSummary({ result }: { result: IngestLiveResult }) {
  return (
    <div style={{ fontSize: 12, maxHeight: 260, overflowY: "auto", borderTop: "1px solid var(--border, #ddd)", paddingTop: 8 }}>
      {result.price_and_earnings.map((r) => {
        const episodeIds = result.episodes[r.ticker] ?? [];
        const wroteCount = Object.values(r.wrote).filter(Boolean).length;
        return (
          <div key={r.ticker} style={{ marginBottom: 6 }}>
            <strong>{r.ticker}</strong>: {wroteCount}/4 fields written
            {episodeIds.length > 0 && (
              <span style={{ color: "var(--confirm)" }}> · {episodeIds.length} episode(s) created</span>
            )}
            {r.warnings.length > 0 && (
              <ul style={{ margin: "2px 0 0 16px", padding: 0, color: "var(--reject)" }}>
                {r.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {result.candidates && (
        <div>
          Candidates: {result.candidates.upserted.length} upserted
          {result.candidates.warnings.length > 0 && (
            <ul style={{ margin: "2px 0 0 16px", padding: 0, color: "var(--reject)" }}>
              {result.candidates.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
