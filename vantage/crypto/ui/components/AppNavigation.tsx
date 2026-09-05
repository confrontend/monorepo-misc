import type { CopyTradeSubTab } from '../types.js';

type AppNavigationProps = {
  copyTradeSubTab: CopyTradeSubTab;
  activeMenu: string;
  signalMenuActive?: boolean;
  onCopyTradeTabChange: (tab: CopyTradeSubTab) => void;
  onMenuChange: (menu: string) => void;
};

const tabs: Array<{ key: CopyTradeSubTab; label: string }> = [
  { key: 'data', label: 'Data' },
  { key: 'pattern-discovery', label: 'Pattern Research' },
  { key: 'experimental-decision', label: 'Decision Engine' },
  { key: 'live-evaluation', label: 'Live Evaluation' },
  { key: 'solana-benchmark', label: 'Solana Benchmark' },
  { key: 'api-reference', label: 'API Docs' },
];

export function AppNavigation({
  copyTradeSubTab,
  activeMenu,
  signalMenuActive,
  onCopyTradeTabChange,
  onMenuChange,
}: AppNavigationProps) {
  return (
    <>
      <nav className="section-nav" aria-label="Research sections">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`nav-button ${copyTradeSubTab === tab.key ? 'active' : ''}`}
            onClick={() => onCopyTradeTabChange(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </>
  );
}
