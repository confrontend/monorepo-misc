export type PatternDiscoveryProgressView = {
  status: 'idle' | 'preparing' | 'running' | 'complete' | 'stopped' | 'error';
  stage: string;
  message: string;
  thresholdsTotal: number;
  thresholdsCompleted: number;
  currentThreshold: number | null;
  startedAt: string | null;
  completedAt: string | null;
  wallets?: number;
  independentEntries?: number;
  featuresCompleted?: number;
  featuresTotal?: number;
  candidatePatterns?: number;
  validationSurvivors?: number;
  historicalStablePatterns?: number;
  promotedPatterns?: number;
  heartbeatAt?: string;
  activeThresholds?: number[];
  cpuWorkersActive?: number;
  cpuWorkersTotal?: number;
  cpuThreadsPerWorker?: number;
  walletsCompleted?: number;
  walletsTotal?: number;
  cacheHits?: number;
  runId?: number;
  workerPid?: number;
  recentEvents?: Array<{ at: string; message: string }>;
};

type PatternDiscoveryProgressPanelProps = {
  progress: PatternDiscoveryProgressView | null;
  elapsedSeconds: number;
  fallbackMessage: string;
  periodDays: number;
};

const elapsedSince = (timestamp?: string): number | null => {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((Date.now() - parsed) / 1000)) : null;
};

export const PatternDiscoveryProgressPanel = ({
  progress,
  elapsedSeconds,
  fallbackMessage,
  periodDays,
}: PatternDiscoveryProgressPanelProps) => {
  const heartbeatAge = elapsedSince(progress?.heartbeatAt);
  const heartbeatStale = heartbeatAge !== null && heartbeatAge > 10;
  const activeThresholds = progress?.activeThresholds ?? [];
  return (
    <div className="copytrade-analysis-status running" role="status" aria-live="polite">
      <span className="loading-spinner" aria-hidden="true" />
      <div>
        <strong>{progress?.message ?? fallbackMessage}</strong>
        <div className="pattern-discovery-progress-meta">
          <span>
            {progress
              ? `${progress.thresholdsCompleted}/${progress.thresholdsTotal} coverage levels complete · ${Math.max(0, progress.thresholdsTotal - progress.thresholdsCompleted)} remaining`
              : 'Starting local evidence preparation'}
          </span>
          <span>{elapsedSeconds}s elapsed</span>
        </div>
        <progress
          className="pattern-discovery-progress"
          max={progress?.thresholdsTotal ?? 7}
          value={progress?.thresholdsCompleted ?? 0}
          aria-label="Pattern Discovery coverage-level progress"
        />
        <div className="pattern-discovery-runtime-grid">
          <span>
            <b>Stage</b>
            {progress?.stage ?? 'starting'}
          </span>
          <span>
            <b>Coverage workers</b>
            {progress?.cpuWorkersActive ?? 0}/{progress?.cpuWorkersTotal ?? 0} active
          </span>
          <span>
            <b>CPU allocation</b>
            {progress?.cpuThreadsPerWorker ?? 0} thread(s) per worker
          </span>
          <span className={heartbeatStale ? 'warning-text' : ''}>
            <b>Backend heartbeat</b>
            {heartbeatAge === null ? 'waiting' : `${heartbeatAge}s ago`}
          </span>
          <span>
            <b>Active coverage</b>
            {activeThresholds.length
              ? activeThresholds.map((value) => `${value}%`).join(', ')
              : '—'}
          </span>
          <span>
            <b>Dataset</b>
            {progress?.walletsCompleted !== undefined
              ? `${progress.walletsCompleted}/${progress.walletsTotal ?? progress.wallets ?? 0} wallets`
              : `${progress?.wallets ?? 0} wallets`}
            {' · '}
            {progress?.independentEntries ?? 0} entries
          </span>
          <span>
            <b>Pattern testing</b>
            {progress?.featuresTotal
              ? `${progress.featuresCompleted ?? 0}/${progress.featuresTotal} features`
              : 'waiting'}
          </span>
          <span>
            <b>Results so far</b>
            {progress?.candidatePatterns ?? 0} candidates · {progress?.validationSurvivors ?? 0}{' '}
            survivors · {progress?.promotedPatterns ?? 0} promoted
          </span>
          <span>
            <b>Cache</b>
            {progress?.cacheHits ?? 0} coverage levels reused
          </span>
          <span>
            <b>Process</b>
            run {progress?.runId ?? '—'} · PID {progress?.workerPid ?? '—'}
          </span>
        </div>
        {heartbeatStale && (
          <small className="warning-text">
            No backend update for over 10 seconds. The API is responsive, but the current worker
            phase has not reported new progress.
          </small>
        )}
        <details className="pattern-discovery-event-log">
          <summary>Backend event log ({progress?.recentEvents?.length ?? 0})</summary>
          <ol>
            {(progress?.recentEvents ?? []).map((event, index) => (
              <li key={`${event.at}-${index}`}>
                <time>{new Date(event.at).toLocaleTimeString()}</time> {event.message}
              </li>
            ))}
          </ol>
        </details>
        <ol className="copytrade-loading-steps">
          <li>Read saved {periodDays}-day GMGN history and Dune outcomes from SQLite</li>
          <li>Build point-in-time features once, then derive all coverage datasets</li>
          <li>Run coverage levels in bounded parallel CPU workers and cache compact reports</li>
        </ol>
        <small>
          No GMGN or Dune request is made. The API server only coordinates and reports status; the
          isolated worker owns the heavy local work. GPU is not used by this statistical engine.
        </small>
      </div>
    </div>
  );
};
