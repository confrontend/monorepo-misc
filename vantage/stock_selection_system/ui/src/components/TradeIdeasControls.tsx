import { useState } from "react";
import { addManualCandidate, fetchTradeIdeas } from "../api";
import type { AddManualCandidateResult, FetchTradeIdeasResult, TradeIdeasFilters } from "../types";

interface Props {
  onRunComplete: () => void;
}

// Candidate discovery has no trading-calendar gate (see LiveIngestControls'
// same note) -- today's real date is a fine default.
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function TradeIdeasControls({ onRunComplete }: Props) {
  const [open, setOpen] = useState(false);
  const [asOfDate, setAsOfDate] = useState(todayIso());
  const [market, setMarket] = useState("");
  const [direction, setDirection] = useState("");
  const [assetType, setAssetType] = useState("");
  const [minAiScore, setMinAiScore] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState<"fetch" | "manual" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FetchTradeIdeasResult | null>(null);

  const [manualTicker, setManualTicker] = useState("");
  const [manualResult, setManualResult] = useState<AddManualCandidateResult | null>(null);

  async function handleFetchTradeIdeas() {
    const parsedAiScore = minAiScore.trim() ? Number(minAiScore) : undefined;
    const parsedLimit = limit.trim() ? Number(limit) : undefined;
    if (parsedAiScore !== undefined && !Number.isFinite(parsedAiScore)) {
      setError("Minimum AI score must be a number.");
      return;
    }
    if (parsedLimit !== undefined && (!Number.isInteger(parsedLimit) || parsedLimit < 1)) {
      setError("Result limit must be a positive whole number.");
      return;
    }

    setBusy("fetch");
    setError(null);
    setResult(null);
    try {
      const filters: TradeIdeasFilters = {};
      if (market.trim()) filters.market = market.trim();
      if (direction) filters.direction = direction;
      if (assetType.trim()) filters.asset_type = assetType.trim();
      if (parsedAiScore !== undefined) filters.aiscore = parsedAiScore;
      if (parsedLimit !== undefined) filters.limit = parsedLimit;

      const r = await fetchTradeIdeas(asOfDate, filters);
      setResult(r);
      onRunComplete();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function handleAddManually() {
    const tickers = manualTicker
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
    if (tickers.length === 0) {
      setError("Enter at least one ticker (comma-separated) to add manually.");
      return;
    }
    setBusy("manual");
    setError(null);
    setManualResult(null);
    try {
      const r = await addManualCandidate(tickers, asOfDate);
      setManualResult(r);
      onRunComplete();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ position: "relative" }}>
      <button className="btn" onClick={() => setOpen((v) => !v)} title="Discover candidates automatically from Danelfin Trade Ideas -- no tickers needed">
        Candidates {open ? "▴" : "▾"}
      </button>

      {open && (
        <div
          style={{
            position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 10,
            background: "var(--panel-bg, #fff)", border: "1px solid var(--border, #ddd)",
            borderRadius: 6, padding: 12, width: 420, boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Fetch Danelfin Trade Ideas</div>
            <div style={{ fontSize: 11, color: "var(--muted, #777)" }}>
              Discovers eligible tickers automatically -- no ticker input required. Filters below are all optional.
            </div>

            <label style={{ fontSize: 12 }}>
              As-of date
              <input
                type="date"
                value={asOfDate}
                onChange={(e) => setAsOfDate(e.target.value)}
                style={{ width: "100%", boxSizing: "border-box", marginTop: 2 }}
              />
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ fontSize: 12, flex: 1 }}>
                Market
                <input
                  type="text"
                  value={market}
                  onChange={(e) => setMarket(e.target.value)}
                  placeholder="us"
                  style={{ width: "100%", boxSizing: "border-box", marginTop: 2 }}
                />
              </label>
              <label style={{ fontSize: 12, flex: 1 }}>
                Direction
                <select value={direction} onChange={(e) => setDirection(e.target.value)} style={{ width: "100%", marginTop: 2 }}>
                  <option value="">Any</option>
                  <option value="long">Long</option>
                  <option value="short">Short</option>
                </select>
              </label>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <label style={{ fontSize: 12, flex: 1 }}>
                Asset type
                <input
                  type="text"
                  value={assetType}
                  onChange={(e) => setAssetType(e.target.value)}
                  placeholder="stock"
                  style={{ width: "100%", boxSizing: "border-box", marginTop: 2 }}
                />
              </label>
              <label style={{ fontSize: 12, flex: 1 }}>
                Min AI score
                <input
                  type="number"
                  value={minAiScore}
                  onChange={(e) => setMinAiScore(e.target.value)}
                  placeholder="e.g. 8"
                  style={{ width: "100%", boxSizing: "border-box", marginTop: 2 }}
                />
              </label>
              <label style={{ fontSize: 12, flex: 1 }}>
                Result limit
                <input
                  type="number"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  placeholder="100"
                  style={{ width: "100%", boxSizing: "border-box", marginTop: 2 }}
                />
              </label>
            </div>

            <button className="btn" onClick={handleFetchTradeIdeas} disabled={busy !== null}
              title="Calls Danelfin's Trade Ideas discovery endpoint (GET /v3/trade-ideas) and upserts every discovered ticker into candidates">
              {busy === "fetch" ? "Fetching…" : "Fetch Danelfin Trade Ideas"}
            </button>

            {error && <div style={{ fontSize: 12, color: "var(--reject)" }}>{error}</div>}

            {result && <TradeIdeasSummary result={result} />}

            <div style={{ borderTop: "1px solid var(--border, #ddd)", paddingTop: 8, marginTop: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Add manually (fallback)</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  type="text"
                  value={manualTicker}
                  onChange={(e) => setManualTicker(e.target.value)}
                  placeholder="ATI, MSFT"
                  style={{ flex: 1, boxSizing: "border-box" }}
                />
                <button className="btn" onClick={handleAddManually} disabled={busy !== null}
                  title="Adds these tickers straight into candidates with source='manual', no Danelfin call, no API key needed">
                  {busy === "manual" ? "Adding…" : "Add manually"}
                </button>
              </div>
              {manualResult && (
                <div style={{ fontSize: 12, color: "var(--confirm)", marginTop: 4 }}>
                  Added (source=manual): {manualResult.added.join(", ") || "none"}
                  {manualResult.failed_count > 0 && (
                    <ul style={{ margin: "2px 0 0 16px", padding: 0, color: "var(--reject)" }}>
                      {Object.entries(manualResult.failed).map(([ticker, err]) => (
                        <li key={ticker}>
                          <strong>{ticker}</strong>: {err}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TradeIdeasSummary({ result }: { result: FetchTradeIdeasResult }) {
  return (
    <div style={{ fontSize: 12, borderTop: "1px solid var(--border, #ddd)", paddingTop: 8 }}>
      <div>
        {result.total_ideas} Trade Idea(s) found as of {result.as_of_date}: {result.successful_count} added to
        candidates, {result.skipped_count} skipped, {result.failed_count} failed.
      </div>

      {result.warnings.length > 0 && (
        <ul style={{ margin: "4px 0 0 16px", padding: 0, color: "var(--reject)" }}>
          {result.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}

      {result.ideas.length > 0 && (
        <div style={{ maxHeight: 220, overflowY: "auto", marginTop: 6 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border, #ddd)" }}>
                <th>Ticker</th>
                <th>Status</th>
                <th>AI</th>
                <th>Tech</th>
                <th>Fund</th>
                <th>Dir</th>
              </tr>
            </thead>
            <tbody>
              {result.ideas.map((row) => (
                <tr key={row.index} style={{ borderBottom: "1px solid var(--border, #eee)" }}>
                  <td>{row.ticker ?? "—"}</td>
                  <td
                    style={{
                      color:
                        row.status === "successful"
                          ? "var(--confirm)"
                          : row.status === "failed"
                          ? "var(--reject)"
                          : "var(--wait, #999)",
                    }}
                    title={row.reason ?? undefined}
                  >
                    {row.status}
                  </td>
                  <td>{row.ai_score ?? "—"}</td>
                  <td>{row.technical_score ?? "—"}</td>
                  <td>{row.fundamental_score ?? "—"}</td>
                  <td>{row.direction ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
