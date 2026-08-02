import { useCallback, useEffect, useState } from "react";
import { getStats, getTickers, listEpisodes, listInsufficientDataCases } from "./api";
import DashboardPage from "./pages/DashboardPage";
import CandidateIntakePage from "./pages/CandidateIntakePage";
import EpisodesPage from "./pages/EpisodesPage";
import IncompleteDataPage from "./pages/IncompleteDataPage";
import Sidebar, { type Screen } from "./components/Sidebar";
import DetailDrawer, { type DrawerState } from "./components/DetailDrawer";
import type { EpisodeSummary, InsufficientDataCase, Stats } from "./types";

export default function App() {
  const [screen, setScreen] = useState<Screen>("dashboard");
  const [stats, setStats] = useState<Stats | null>(null);
  const [episodes, setEpisodes] = useState<EpisodeSummary[]>([]);
  const [cases, setCases] = useState<InsufficientDataCase[]>([]);
  const [tickers, setTickers] = useState<string[]>([]);
  const [tickerFilter, setTickerFilter] = useState("");
  const [decisionFilter, setDecisionFilter] = useState("");
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoadError(null);
    getStats().then(setStats).catch((e) => setLoadError((e as Error).message));
    getTickers().then(setTickers).catch((e) => setLoadError((e as Error).message));
    listEpisodes({ ticker: tickerFilter || undefined, decision: decisionFilter || undefined }).then(setEpisodes).catch((e) => setLoadError((e as Error).message));
    listInsufficientDataCases({ ticker: tickerFilter || undefined }).then(setCases).catch((e) => setLoadError((e as Error).message));
  }, [tickerFilter, decisionFilter]);

  useEffect(() => { refresh(); }, [refresh]);
  const connected = loadError === null;

  return <div className="app-shell"><Sidebar screen={screen} onNavigate={(next) => { setScreen(next); setDrawer(null); }} openIncompleteCount={stats?.unresolved_insufficient_data_cases ?? cases.filter((c) => !c.resolved).length} /><main className="main-content">
    {loadError && <div className="banner error">Could not reach the API: {loadError}</div>}
    {screen === "dashboard" && <DashboardPage stats={stats} recentEpisodes={episodes.slice(0, 6)} onSelectEpisode={(id) => setDrawer({ type: "episode", episodeId: id })} onGoEpisodes={() => setScreen("episodes")} connected={connected} onRefresh={refresh} refreshing={false} />}
    {screen === "intake" && <CandidateIntakePage connected={connected} onRefresh={refresh} />}
    {screen === "episodes" && <EpisodesPage episodes={episodes} tickers={tickers} ticker={tickerFilter} decision={decisionFilter} onTicker={setTickerFilter} onDecision={setDecisionFilter} onSelect={(id) => setDrawer({ type: "episode", episodeId: id })} />}
    {screen === "incomplete" && <IncompleteDataPage cases={cases} />}
  </main><DetailDrawer drawer={drawer} onClose={() => setDrawer(null)} /></div>;
}
