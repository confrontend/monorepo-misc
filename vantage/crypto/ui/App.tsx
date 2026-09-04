import { useEffect, useState } from 'react';
import { api } from './httpClient.js';
import { AppHeader } from './components/AppHeader.js';
import { AppNavigation } from './components/AppNavigation.js';
import { CopyTradeSubTabContent } from './components/CopyTradeSubTabContent.js';
import { PatternDiscoverySection } from './components/PatternDiscoverySection.js';
import { ArchivesRoute } from './routes/ArchivesRoute.js';
import { DiagnosticsRoute } from './routes/DiagnosticsRoute.js';
import { useAppRoute } from './app/useAppRoute.js';
import { useThemeMode } from './app/useThemeMode.js';
import { usePatternDiscoveryController } from './hooks/usePatternDiscoveryController.js';
import type {
  CopyTradeSubTab,
} from './types.js';

export function App() {
  const { themeMode, toggleTheme } = useThemeMode();
  const { activeMenu, copyTradeSubTab, navigateTo, navigateCopyTradeSubTab } = useAppRoute();
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [copyTradePeriodDays, setCopyTradePeriodDays] = useState(30);
  const patternDiscovery = usePatternDiscoveryController({ api, periodDays: copyTradePeriodDays, copyTradeSubTab });
  const {
    patternReport, patternSnapshots, patternHorizon, refreshPatternReport,
    patternDiscoveryExport, patternDiscoveryProgress, patternDiscoveryLoadingDetail,
    patternDiscoveryReport, patternDiscoverySensitivity, patternDiscoveryFreshness,
    patternDiscoveryExecution, patternDiscoveryRunLoading, patternDiscoveryElapsedSeconds,
    patternDiscoveryRunError, patternHistoryAvailable, setPatternHistoryAvailable,
    selectedPatternRule, setSelectedPatternRule, patternDiscoverySourceOpen,
    setPatternDiscoverySourceOpen, patternDiscoveryIsActive, exportPatternDiscoveryPage,
    runPatternDiscovery, stopPatternDiscovery,
  } = patternDiscovery;
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [message, setMessage] = useState('Ready. Data is saved locally in SQLite.');
  const signalMenuActive = false;

  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 480);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const refresh = async () => {
    setRefreshBusy(true);
    try {
      await refreshPatternReport();
    } finally {
      setRefreshBusy(false);
    }
  };

  useEffect(() => {
    if (activeMenu === 'copytrade') return;
    void refresh().catch((error: unknown) => setMessage(String(error)));
  }, [activeMenu]);
  return (
    <main className={`shell routed-view page-${activeMenu}`}>
      <AppHeader
        themeMode={themeMode}
        onToggleTheme={toggleTheme}
      />

      <AppNavigation
        copyTradeSubTab={copyTradeSubTab}
        activeMenu={activeMenu}
        signalMenuActive={signalMenuActive}
        onCopyTradeTabChange={navigateCopyTradeSubTab}
        onMenuChange={navigateTo}
      />

      <section id="copytrade" className="menu-section panel copytrade-panel">
        <CopyTradeSubTabContent
          activeTab={copyTradeSubTab}
          api={api}
          periodDays={copyTradePeriodDays as 30 | 60 | 90}
          onPeriodDaysChange={(periodDays) => setCopyTradePeriodDays(periodDays)}
        />
      </section>
      {copyTradeSubTab === 'pattern-discovery' && (
        <PatternDiscoverySection
          api={api}
          periodDays={copyTradePeriodDays}
          onPeriodDaysChange={setCopyTradePeriodDays}
          onGoToData={() => navigateCopyTradeSubTab('data')}
          patternHistoryAvailable={patternHistoryAvailable}
          onAvailabilityChange={setPatternHistoryAvailable}
          patternDiscoveryIsActive={patternDiscoveryIsActive}
          patternDiscoveryExport={patternDiscoveryExport}
          patternDiscoveryProgress={patternDiscoveryProgress}
          patternDiscoveryLoadingDetail={patternDiscoveryLoadingDetail}
          patternDiscoveryReport={patternDiscoveryReport}
          patternDiscoverySensitivity={patternDiscoverySensitivity}
          patternDiscoveryFreshness={patternDiscoveryFreshness}
          patternDiscoveryExecution={patternDiscoveryExecution}
          patternDiscoveryRunLoading={patternDiscoveryRunLoading}
          patternDiscoveryElapsedSeconds={patternDiscoveryElapsedSeconds}
          patternDiscoveryRunError={patternDiscoveryRunError}
          patternDiscoverySourceOpen={patternDiscoverySourceOpen}
          onSourceOpenChange={setPatternDiscoverySourceOpen}
          selectedPatternRule={selectedPatternRule}
          onSelectedPatternRuleChange={setSelectedPatternRule}
          onExport={exportPatternDiscoveryPage}
          onRun={() => void runPatternDiscovery()}
          onStop={() => void stopPatternDiscovery()}
        />
      )}

      <ArchivesRoute setMessage={setMessage} />

      <DiagnosticsRoute setMessage={setMessage} />

      <footer>
        <span>{message}</span>
        <button className="quiet" onClick={() => void refresh()}>
          Refresh
        </button>
      </footer>
      {showScrollTop && (
        <button
          type="button"
          className="scroll-top-button"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="Scroll to top"
          title="Scroll to top"
        >
          ↑ <span>Top</span>
        </button>
      )}
    </main>
  );
}
