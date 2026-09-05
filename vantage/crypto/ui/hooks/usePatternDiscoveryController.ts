import { useCallback, useEffect, useRef, useState } from 'react';
import { api as defaultApi, type ApiClient } from '../httpClient.js';
import { bestPatternHorizon } from '../app/appFormatters.js';
import { saveJson } from '../app/appExports.js';
import type {
  PatternDiscoveryExport,
  PatternDiscoveryExecution,
  PatternDiscoveryProgress,
  PatternDiscoveryReport,
  PatternDiscoveryRunResponse,
  PatternDiscoverySensitivity,
  PatternDiscoveryStartResponse,
  SignalPatternReport,
  SignalPatternSnapshot,
} from '../types.js';
import type { PatternDiscoveryRule } from '../components/PatternDiscoveryRuleDialog.js';

export function usePatternDiscoveryController({
  api = defaultApi,
  periodDays,
  copyTradeSubTab,
}: {
  api?: ApiClient;
  periodDays: number;
  copyTradeSubTab: string;
}) {
  const [patternReport, setPatternReport] = useState<SignalPatternReport | null>(null);
  const [patternSnapshots, setPatternSnapshots] = useState<SignalPatternSnapshot[]>([]);
  const [patternHorizon, setPatternHorizon] = useState<string | null>(null);
  const [patternDiscoveryExport, setPatternDiscoveryExport] =
    useState<PatternDiscoveryExport | null>(null);
  const [, setPatternDiscoveryExportLoading] = useState(false);
  const [patternDiscoveryProgress, setPatternDiscoveryProgress] =
    useState<PatternDiscoveryProgress | null>(null);
  const [patternDiscoveryLoadingDetail, setPatternDiscoveryLoadingDetail] = useState(
    'Preparing the local SQLite read…',
  );
  const [patternDiscoveryReport, setPatternDiscoveryReport] =
    useState<PatternDiscoveryReport | null>(null);
  const [patternDiscoverySensitivity, setPatternDiscoverySensitivity] =
    useState<PatternDiscoverySensitivity | null>(null);
  const [patternDiscoveryFreshness, setPatternDiscoveryFreshness] =
    useState<PatternDiscoveryRunResponse['freshness']>(undefined);
  const [patternDiscoveryExecution, setPatternDiscoveryExecution] =
    useState<PatternDiscoveryExecution | null>(null);
  const [patternDiscoveryRunLoading, setPatternDiscoveryRunLoading] = useState(false);
  const [patternDiscoveryStartedAt, setPatternDiscoveryStartedAt] = useState<number | null>(null);
  const [patternDiscoveryElapsedSeconds, setPatternDiscoveryElapsedSeconds] = useState(0);
  const [patternDiscoveryRunError, setPatternDiscoveryRunError] = useState<string | null>(null);
  const [patternHistoryAvailable, setPatternHistoryAvailable] = useState(false);
  const [selectedPatternRule, setSelectedPatternRule] = useState<PatternDiscoveryRule | null>(null);
  const [patternDiscoverySourceOpen, setPatternDiscoverySourceOpen] = useState(false);
  const runInFlight = useRef(false);
  const abortController = useRef<AbortController | null>(null);
  const stopRequested = useRef(false);
  const lastCompletionKey = useRef<string | null>(null);

  const loadCompletedPatternDiscovery = useCallback(async () => {
    const result = await api<PatternDiscoveryRunResponse>(
      `/api/copytrade/pattern-discovery/run/result?periodDays=${periodDays}&minN=10`,
    );
    setPatternDiscoveryReport(result.report ?? null);
    setPatternDiscoveryExecution(result.execution ?? null);
    setPatternDiscoverySensitivity(result.sensitivity ?? null);
    setPatternDiscoveryFreshness(result.freshness);
  }, [api, periodDays]);

  const refreshPatternReport = useCallback(async () => {
    const [nextReport, nextSnapshots] = await Promise.all([
      api<SignalPatternReport>('/api/analysis/patterns'),
      api<SignalPatternSnapshot[]>('/api/analysis/patterns/snapshots'),
    ]);
    setPatternReport(nextReport);
    setPatternSnapshots(nextSnapshots);
    setPatternHorizon(bestPatternHorizon(nextReport));
  }, [api]);

  const loadPatternDiscoveryExport = useCallback(
    async (minimumCoveragePercent = 100) => {
      setPatternDiscoveryExportLoading(true);
      try {
        const result = await api<PatternDiscoveryExport>(
          `/api/copytrade/pattern-discovery/export?periodDays=${periodDays}&minimumCoveragePercent=${minimumCoveragePercent}`,
        );
        setPatternDiscoveryExport(result);
        return result;
      } catch {
        setPatternDiscoveryExport(null);
        return null;
      } finally {
        setPatternDiscoveryExportLoading(false);
      }
    },
    [api, periodDays],
  );

  const exportPatternDiscoveryPage = useCallback(() => {
    if (!patternDiscoveryExport && !patternDiscoveryReport && !patternDiscoverySensitivity) return;
    saveJson(
      {
        format: 'vantage-pattern-discovery-page-export-v1',
        exportedAt: new Date().toISOString(),
        page: { periodDays, coverageGrid: [50, 60, 70, 80, 90, 95, 100] },
        sourceData: patternDiscoveryExport,
        report: patternDiscoveryReport,
        sensitivity: patternDiscoverySensitivity,
        execution: patternDiscoveryExecution,
        progress: patternDiscoveryProgress,
      },
      `crypto-pattern-discovery-page-${periodDays}d-${new Date().toISOString().slice(0, 10)}.json`,
    );
  }, [
    periodDays,
    patternDiscoveryExport,
    patternDiscoveryExecution,
    patternDiscoveryProgress,
    patternDiscoveryReport,
    patternDiscoverySensitivity,
  ]);

  const runPatternDiscovery = useCallback(async () => {
    if (runInFlight.current || patternDiscoveryRunLoading) return;
    runInFlight.current = true;
    stopRequested.current = false;
    abortController.current = new AbortController();
    setPatternDiscoveryStartedAt(Date.now());
    setPatternDiscoveryRunLoading(true);
    setPatternDiscoveryRunError(null);
    setPatternDiscoveryExport(null);
    try {
      if (stopRequested.current) return;
      const result = await api<PatternDiscoveryStartResponse>(
        '/api/copytrade/pattern-discovery/run/report',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ periodDays, minN: 10 }),
          signal: abortController.current.signal,
        },
      );
      setPatternDiscoveryProgress(result.progress);
      setPatternDiscoveryLoadingDetail(result.progress.message);
      if (['complete', 'stopped', 'error'].includes(result.progress.status)) {
        const key = `${result.progress.status}:${result.progress.runId ?? 'legacy'}:${result.progress.completedAt ?? result.progress.heartbeatAt ?? 'unknown'}`;
        if (result.progress.status === 'complete' || result.progress.status === 'stopped') {
          await loadCompletedPatternDiscovery();
          lastCompletionKey.current = key;
        } else setPatternDiscoveryRunError(result.progress.message);
        runInFlight.current = false;
        setPatternDiscoveryRunLoading(false);
        setPatternDiscoveryStartedAt(null);
        abortController.current = null;
      }
    } catch (error: unknown) {
      if (!stopRequested.current)
        setPatternDiscoveryRunError(error instanceof Error ? error.message : String(error));
      runInFlight.current = false;
      setPatternDiscoveryRunLoading(false);
      setPatternDiscoveryStartedAt(null);
      abortController.current = null;
    }
  }, [api, loadCompletedPatternDiscovery, patternDiscoveryRunLoading, periodDays]);

  const stopPatternDiscovery = useCallback(async () => {
    const active =
      patternDiscoveryProgress?.status === 'preparing' ||
      patternDiscoveryProgress?.status === 'running';
    if (!patternDiscoveryRunLoading && !active) return;
    stopRequested.current = true;
    setPatternDiscoveryRunError('Stopping discovery… completed coverage levels remain saved.');
    try {
      await api('/api/copytrade/pattern-discovery/stop', { method: 'POST' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/No Pattern Discovery run is active/i.test(message))
        setPatternDiscoveryRunError(message);
    } finally {
      abortController.current?.abort();
      runInFlight.current = false;
      setPatternDiscoveryRunLoading(false);
      setPatternDiscoveryStartedAt(null);
      abortController.current = null;
    }
  }, [api, patternDiscoveryProgress?.status, patternDiscoveryRunLoading]);

  useEffect(() => {
    if (!patternDiscoveryStartedAt || !patternDiscoveryRunLoading) {
      setPatternDiscoveryElapsedSeconds(0);
      return;
    }
    const update = () =>
      setPatternDiscoveryElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - patternDiscoveryStartedAt) / 1000)),
      );
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [patternDiscoveryStartedAt, patternDiscoveryRunLoading]);

  useEffect(() => {
    if (copyTradeSubTab !== 'pattern-discovery') return;
    let disposed = false;
    let timer: number | undefined;
    let requestInFlight = false;
    const poll = async () => {
      if (disposed || requestInFlight) return;
      requestInFlight = true;
      try {
        const progress = await api<PatternDiscoveryProgress>(
          '/api/copytrade/pattern-discovery/status',
        );
        if (disposed) return;
        setPatternDiscoveryProgress(progress);
        setPatternDiscoveryLoadingDetail(progress.message);
        const active = progress.status === 'preparing' || progress.status === 'running';
        if (active) {
          if (!runInFlight.current) {
            setPatternDiscoveryRunLoading(true);
            if (progress.startedAt) setPatternDiscoveryStartedAt(Date.parse(progress.startedAt));
          }
        } else {
          const key = ['idle', 'complete', 'stopped', 'cancelled'].includes(progress.status)
            ? `${progress.status}:${progress.runId ?? 'legacy'}:${progress.completedAt ?? progress.heartbeatAt ?? 'unknown'}`
            : null;
          if (key && key !== lastCompletionKey.current) {
            try {
              await loadCompletedPatternDiscovery();
              lastCompletionKey.current = key;
            } catch (error: unknown) {
              if (!disposed && progress.status === 'complete')
                setPatternDiscoveryRunError(error instanceof Error ? error.message : String(error));
            }
          } else if (progress.status === 'error') setPatternDiscoveryRunError(progress.message);
          runInFlight.current = false;
          setPatternDiscoveryRunLoading(false);
          setPatternDiscoveryStartedAt(null);
          abortController.current = null;
        }
        if (!disposed) timer = window.setTimeout(() => void poll(), active ? 2000 : 5000);
      } catch {
        if (!disposed) timer = window.setTimeout(() => void poll(), 3000);
      } finally {
        requestInFlight = false;
      }
    };
    void poll();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [api, copyTradeSubTab, loadCompletedPatternDiscovery]);

  return {
    patternReport,
    patternSnapshots,
    patternHorizon,
    refreshPatternReport,
    patternDiscoveryExport,
    patternDiscoveryProgress,
    patternDiscoveryLoadingDetail,
    patternDiscoveryReport,
    patternDiscoverySensitivity,
    patternDiscoveryFreshness,
    patternDiscoveryExecution,
    patternDiscoveryRunLoading,
    patternDiscoveryElapsedSeconds,
    patternDiscoveryRunError,
    patternHistoryAvailable,
    setPatternHistoryAvailable,
    selectedPatternRule,
    setSelectedPatternRule,
    patternDiscoverySourceOpen,
    setPatternDiscoverySourceOpen,
    patternDiscoveryIsActive:
      patternDiscoveryRunLoading ||
      patternDiscoveryProgress?.status === 'preparing' ||
      patternDiscoveryProgress?.status === 'running',
    exportPatternDiscoveryPage,
    runPatternDiscovery,
    stopPatternDiscovery,
    loadPatternDiscoveryExport,
  };
}
