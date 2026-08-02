import { useState } from "react";
import { retryInsufficientData, runDemo } from "../api";
import type { RetryResult, RunDemoResult } from "../types";

interface Props {
  onRunComplete: () => void;
}

// Both actions require as_of_date to be a real NYSE trading day (see
// TradingCalendar) -- defaulting to the literal current date is a bad idea
// since "today" is very often a weekend/holiday and would fail immediately.
// 2026-02-02 is the date the synthetic ATI demo dataset
// (src/ingestion/seed_demo_data.py) was built around and is documented in
// the README, so it's always a safe starting point regardless of when this
// UI is actually opened.
const DEFAULT_AS_OF_DATE = "2026-02-02";

export default function RunControls({ onRunComplete }: Props) {
  const [asOfDate, setAsOfDate] = useState(DEFAULT_AS_OF_DATE);
  const [busy, setBusy] = useState<"demo" | "retry" | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  async function handleRunDemo() {
    setBusy("demo");
    setMessage(null);
    try {
      const result: RunDemoResult = await runDemo(asOfDate, 42);
      if (result.episode_id) {
        setMessage({ kind: "success", text: `ATI demo created episode ${result.episode_id.slice(0, 8)}…` });
      } else {
        setMessage({
          kind: "error",
          text: `ATI demo ran but required inputs were insufficient (${result.insufficient_data_cases?.length ?? 0} case(s) recorded).`,
        });
      }
      onRunComplete();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  async function handleRetry() {
    setBusy("retry");
    setMessage(null);
    try {
      const result: RetryResult = await retryInsufficientData(asOfDate);
      setMessage({
        kind: result.count > 0 ? "success" : "error",
        text:
          result.count > 0
            ? `Resolved ${result.count} insufficient-data case(s).`
            : "No cases resolved -- required inputs still missing.",
      });
      onRunComplete();
    } catch (err) {
      setMessage({ kind: "error", text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <input
        type="date"
        value={asOfDate}
        onChange={(e) => setAsOfDate(e.target.value)}
        title="as_of_date used by both actions below -- must be a real NYSE trading day (not a weekend/holiday)"
      />
      <button className="btn" onClick={handleRunDemo} disabled={busy !== null} title="Runs the synthetic ATI demo end-to-end (no API keys needed)">
        {busy === "demo" ? "Running…" : "Run ATI demo"}
      </button>
      <button className="btn" onClick={handleRetry} disabled={busy !== null} title="Re-checks every unresolved insufficient-data case">
        {busy === "retry" ? "Retrying…" : "Retry insufficient-data"}
      </button>
      {message && <RunMessage message={message} />}
    </div>
  );
}

function RunMessage({ message }: { message: { kind: "success" | "error"; text: string } }) {
  return (
    <span
      style={{
        fontSize: 12,
        color: message.kind === "success" ? "var(--confirm)" : "var(--reject)",
        maxWidth: 260,
      }}
    >
      {message.text}
    </span>
  );
}
