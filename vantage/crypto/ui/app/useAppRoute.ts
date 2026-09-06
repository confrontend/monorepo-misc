import { useCallback, useEffect, useState } from 'react';
import type { CopyTradeSubTab } from '../types.js';

const normalizeRoute = (route: string): string => (route === 'copy-trades' ? 'copytrade' : route);

export const parseCopyTradeRoute = (route: string): { menu: string; subTab: CopyTradeSubTab } => {
  const [rawMenu, rawSubTab] = route.split('/');
  const subTab: CopyTradeSubTab =
    rawSubTab === 'data' ||
    rawSubTab === 'api-reference' ||
    rawSubTab === 'experimental-decision' ||
    rawSubTab === 'live-evaluation' ||
    rawSubTab === 'solana-benchmark'
      ? rawSubTab
      : 'experimental-decision';
  if (rawSubTab === 'wallet-stats')
    return { menu: normalizeRoute(rawMenu || 'dune-capture'), subTab: 'experimental-decision' };
  return { menu: normalizeRoute(rawMenu || 'dune-capture'), subTab };
};

/** Keeps hash navigation and the selected CopyTrade tab in sync. */
export function useAppRoute() {
  const initialSubTab = parseCopyTradeRoute(
    window.location.hash.slice(1) || 'copytrade/experimental-decision',
  ).subTab;
  // Preserve the existing startup behavior: the app initially renders the CopyTrade shell,
  // then the location listener applies a non-CopyTrade hash after mount.
  const [activeMenu, setActiveMenu] = useState('copytrade');
  const [copyTradeSubTab, setCopyTradeSubTab] = useState<CopyTradeSubTab>(initialSubTab);

  useEffect(() => {
    const onLocationChange = () => {
      const next = parseCopyTradeRoute(window.location.hash.slice(1) || 'dune-capture');
      setActiveMenu(next.menu);
      setCopyTradeSubTab(next.subTab);
    };
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
    return () => {
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('hashchange', onLocationChange);
    };
  }, []);

  const navigateTo = useCallback((section: string) => {
    setActiveMenu(section);
    if (section === 'copytrade') setCopyTradeSubTab('experimental-decision');
    window.history.pushState({}, '', `#${section}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const navigateCopyTradeSubTab = useCallback((subTab: CopyTradeSubTab) => {
    setActiveMenu('copytrade');
    setCopyTradeSubTab(subTab);
    window.history.pushState({}, '', `#copytrade/${subTab}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  return { activeMenu, copyTradeSubTab, navigateTo, navigateCopyTradeSubTab };
}
