import { useEffect, useState } from 'react';
import { assessPatternDiscoveryHistoryAvailability } from '../../../src/copytrade/discovery/patternDiscoveryAvailability.js';
import type { ApiClient } from '../../httpClient.js';
import { UI_STRINGS } from '../../strings.js';

type DataStatusSummaryResponse = {
  generatedAt: string;
  targetDays: number;
  rosterWallets: number;
  history: Record<string, number>;
  duneStatus: string;
  patternStatus: string;
  decisionStatus: string;
};

export function DataStatusSummary({
  api,
  targetDays = 30,
  onGoToData,
  onAvailabilityChange,
}: {
  api: ApiClient;
  targetDays?: number;
  onGoToData?: () => void;
  onAvailabilityChange?: (available: boolean) => void;
}) {
  const [summary, setSummary] = useState<DataStatusSummaryResponse | null>(null);
  useEffect(() => {
    let disposed = false;
    void api<DataStatusSummaryResponse>(
      `/api/copytrade/data-workflow/status-summary?targetDays=${encodeURIComponent(targetDays)}`,
    )
      .then((value) => {
        if (!disposed) setSummary(value);
      })
      .catch(() => {
        if (!disposed) setSummary(null);
      });
    return () => {
      disposed = true;
    };
  }, [api, targetDays]);
  useEffect(() => {
    if (!summary) {
      onAvailabilityChange?.(false);
      return;
    }
    const covered = summary.history[String(targetDays)] ?? 0;
    onAvailabilityChange?.(
      assessPatternDiscoveryHistoryAvailability({
        periodDays: targetDays,
        totalWallets: summary.rosterWallets,
        coveredWallets: covered,
      }).available,
    );
  }, [onAvailabilityChange, summary, targetDays]);
  if (!summary) return null;
  const covered = summary.history[String(targetDays)] ?? 0;
  const availability = assessPatternDiscoveryHistoryAvailability({
    periodDays: targetDays,
    totalWallets: summary.rosterWallets,
    coveredWallets: covered,
  });
  const incomplete = availability.excludedWallets > 0 || summary.rosterWallets === 0;
  const goToData =
    onGoToData ??
    (() => {
      window.location.hash = '#copytrade/data';
    });
  return (
    <aside className="copytrade-data-status-summary" role="status">
      <span>
        GMGN history: {summary.rosterWallets} wallets · {targetDays}d {covered}/
        {summary.rosterWallets} · Dune outcomes: {summary.duneStatus.replaceAll('_', ' ')}
      </span>
      {!availability.available && (
        <small>{UI_STRINGS.patternDiscovery.historyUnavailable(targetDays)}</small>
      )}
      {availability.available && availability.excludedWallets > 0 && (
        <small>
          {UI_STRINGS.patternDiscovery.historySubset(
            availability.coveredWallets,
            availability.excludedWallets,
            targetDays,
          )}
        </small>
      )}
      {incomplete && (
        <button type="button" className="secondary" onClick={goToData}>
          Go to Data
        </button>
      )}
    </aside>
  );
}
