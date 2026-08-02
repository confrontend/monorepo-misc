import EpisodesTable from "../components/EpisodesTable";
import type { EpisodeSummary } from "../types";

interface Props { episodes: EpisodeSummary[]; tickers: string[]; ticker: string; decision: string; onTicker: (v: string) => void; onDecision: (v: string) => void; onSelect: (id: string) => void; }

export default function EpisodesPage({ episodes, tickers, ticker, decision, onTicker, onDecision, onSelect }: Props) {
  return <div className="page"><div className="page-header"><div><h1>Episodes</h1><div className="page-sub">Full log of frozen scoring decisions. Reviews are immutable — corrections create a new episode.</div></div></div><div className="hr" /><div className="filter-row"><label className="field"><span>Ticker</span><select className="input" value={ticker} onChange={(e) => onTicker(e.target.value)}><option value="">All</option>{tickers.map((t) => <option key={t}>{t}</option>)}</select></label><label className="field"><span>Decision</span><select className="input" value={decision} onChange={(e) => onDecision(e.target.value)}><option value="">All</option>{["Confirm", "Mixed", "Reject", "Wait"].map((d) => <option key={d}>{d}</option>)}</select></label><div className="page-meta" style={{ marginLeft: "auto" }}>{episodes.length} episode(s)</div></div><EpisodesTable episodes={episodes} onSelect={onSelect} /></div>;
}
