import type { SignalPatternGroup, SignalPatternReport } from '../types.js';

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  '1': 'General price spike',
  '2': 'Dex ad placement',
  '3': 'Dex social-link update',
  '4': 'Dex trending bar',
  '5': 'Dex Boost',
  '6': 'Price up',
  '7': 'Price ATH',
  '8': 'Market-cap key level',
  '9': 'Live stream',
  '10': 'Bundler sell',
  '11': 'Community takeover',
  '12': 'Smart-money buy',
  '13': 'Platform call',
  '14': 'Large-amount buy',
  '15': 'Multiple buys',
  '16': 'Multiple large buys',
  '17': 'Bags Claim',
  '18': 'Pump Claim',
  '19': 'Platform call V2',
  '20': 'KOL buy',
  '21': 'Banker Claim',
};

export const formatSignalType = (value: string | null): string =>
  value ? `${value} · ${SIGNAL_TYPE_LABELS[value] ?? 'Unmapped GMGN type'}` : 'unknown signal type';

export const formatPercentChange = (base: number | null, value: number | null): string =>
  base === null || value === null || base === 0
    ? '—'
    : `${(((value - base) / base) * 100).toFixed(2)}%`;

export const percentChangeValue = (base: number | null, value: number | null): number | null =>
  base === null || value === null || base === 0 ? null : ((value - base) / base) * 100;

export const shortAddress = (address: string): string => `${address.slice(0, 3)}...`;
export const shortWalletAddress = (address: string): string => `${address.slice(0, 6)}...`;
export const tokenDisplay = (symbol: string | null, address: string): string =>
  symbol?.trim() || shortAddress(address);

export const bestPatternHorizon = (report: SignalPatternReport): string | null => {
  const candidates = report.horizons.flatMap((horizon) => {
    const reliable = horizon.groups.filter(
      (group) => group.reliable && group.medianReturnPct !== null,
    );
    if (!reliable.length) return [];
    return [
      {
        horizon: horizon.horizon,
        bestMedian: Math.max(...reliable.map((group) => group.medianReturnPct as number)),
        reliableCount: reliable.length,
        nFresh: reliable.reduce((total, group) => total + group.nFresh, 0),
      },
    ];
  });
  return (
    [...candidates].sort((left, right) => {
      const medianDelta = right.bestMedian - left.bestMedian;
      if (medianDelta !== 0) return medianDelta;
      const countDelta = right.reliableCount - left.reliableCount;
      if (countDelta !== 0) return countDelta;
      return right.nFresh - left.nFresh;
    })[0]?.horizon ?? null
  );
};

export const bestGroupHorizon = (
  report: SignalPatternReport,
  key: string,
): { horizon: string; group: SignalPatternGroup } | null => {
  const entries = report.horizons.flatMap((horizon) => {
    const group = horizon.groups.find((candidate) => candidate.key === key);
    return group ? [{ horizon: horizon.horizon, group }] : [];
  });
  const candidates = entries.filter(
    (entry) => entry.group.reliable && entry.group.medianReturnPct !== null,
  );
  return (
    [...candidates].sort((left, right) => {
      const medianDelta =
        (right.group.medianReturnPct ?? -Infinity) - (left.group.medianReturnPct ?? -Infinity);
      if (medianDelta !== 0) return medianDelta;
      const coverageDelta =
        (right.group.coveragePct ?? -Infinity) - (left.group.coveragePct ?? -Infinity);
      if (coverageDelta !== 0) return coverageDelta;
      return right.group.nFresh - left.group.nFresh;
    })[0] ?? null
  );
};
