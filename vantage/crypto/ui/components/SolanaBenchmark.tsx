import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../httpClient.js';
import { formatTime } from '../httpClient.js';
import { strings } from '../strings.js';
import { Button } from './ui/button.js';

type BenchmarkReport = {
  status: string;
  completed: number;
  total: number;
  requests?: number;
  phase: string;
  error: string | null;
  errors?: Array<{
    tradeId?: string | number;
    walletAddress?: string;
    reason: string;
    message: string;
    at: string;
  }>;
  rpcRequests?: Array<{ count: number; method: string; params: unknown[]; at: string }>;
  provider?: { name?: string; url?: string };
  preflight?: {
    status?: 'PASS' | 'FAIL' | 'NOT_RUN';
    oldestRequiredTimestamp?: string | null;
    oldestRequiredSlot?: number | null;
    firstAvailableBlock?: number | null;
    availableSignatures?: number;
    testedSignatures?: number;
    reason?: string | null;
  };
  benchmark?: {
    sampleSize?: number;
    solanaFound?: number;
    parsedEventsSuccesses?: number;
    indexedFallbackSuccesses?: number;
    usableTokenPrices?: number;
    usableUsdPrices?: number;
    medianLookupLatencyMs?: number | null;
    averageApiCallsPerLookup?: number | null;
    duneFound?: number;
    bothFound?: number;
    sameSignature?: number;
    medianAbsolutePriceDifferencePercent?: number | null;
    p95AbsolutePriceDifferencePercent?: number | null;
    failures?: { byReason: Record<string, number> };
  };
  generatedAt?: string | null;
};

const numberOrDash = (value: number | undefined | null, suffix = '') =>
  value === undefined || value === null
    ? strings.solanaBenchmark.notAvailable
    : `${value}${suffix}`;

export function SolanaBenchmark({ api }: { api: ApiClient }) {
  const [report, setReport] = useState<BenchmarkReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (start = false) => {
      setError(null);
      try {
        const result = await api<{ run: BenchmarkReport | null }>(
          '/api/copytrade/solana-benchmark',
          start ? { method: 'POST' } : undefined,
        );
        setReport(result.run);
      } catch (reason: unknown) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (report?.status !== 'running') return;
    const timer = setInterval(() => void load(), 1500);
    return () => clearInterval(timer);
  }, [report?.status, load]);

  const preflight = report?.preflight;
  const benchmark = report?.benchmark;
  const status = preflight?.status ?? 'NOT_RUN';
  const statusLabel =
    status === 'PASS'
      ? strings.solanaBenchmark.pass
      : status === 'FAIL'
        ? strings.solanaBenchmark.fail
        : strings.solanaBenchmark.notRun;

  return (
    <section className="menu-section panel solana-benchmark-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">{strings.solanaBenchmark.eyebrow}</p>
          <h2>{strings.solanaBenchmark.title}</h2>
          <p className="muted">{strings.solanaBenchmark.subtitle}</p>
        </div>
        <Button
          type="button"
          className="secondary"
          onClick={() => {
            setLoading(true);
            void load(true);
          }}
          disabled={loading || report?.status === 'running'}
        >
          {report?.status === 'running'
            ? `${strings.solanaBenchmark.running} ${report.completed}/${report.total}`
            : strings.solanaBenchmark.start}
        </Button>
      </div>

      {error && (
        <div className="copytrade-analysis-status warning">
          {error.includes('404') || error.includes('Not Found')
            ? strings.solanaBenchmark.unavailable
            : `Could not load benchmark: ${error}`}
        </div>
      )}
      {loading && !report && (
        <p className="copytrade-analysis-status running">
          <span className="loading-spinner" /> {strings.solanaBenchmark.loading}
        </p>
      )}
      {report && (
        <div role="status" className="copytrade-analysis-status">
          <strong>
            {report.status} · {report.completed}/{report.total}
          </strong>
          <p>
            {report.status === 'running'
              ? report.phase
              : report.status === 'interrupted'
                ? 'Run stopped; saved results are available.'
                : report.status === 'failed'
                  ? 'Run stopped because of an error.'
                  : 'Run finished.'}
          </p>
          <p>
            {strings.solanaBenchmark.requests}: {report.requests ?? 0}
          </p>
          {report.status === 'running' && (
            <progress
              aria-label={strings.solanaBenchmark.running}
              value={report.completed}
              max={Math.max(1, report.total)}
              style={{ width: '100%' }}
            />
          )}
          <p>{strings.solanaBenchmark.saved}</p>
          {report.error && (
            <p role="alert">
              {strings.solanaBenchmark.error}: {report.error}
            </p>
          )}
          {!!report.errors?.length && (
            <details>
              <summary>
                {strings.solanaBenchmark.errors} ({report.errors.length})
              </summary>
              <div className="solana-benchmark-errors">
                {report.errors.map((item, index) => (
                  <p key={`${item.at}-${index}`}>
                    <strong>{item.reason}</strong>
                    {item.tradeId !== undefined ? ` · trade ${item.tradeId}` : ''}: {item.message}
                  </p>
                ))}
              </div>
            </details>
          )}
          {!!report.rpcRequests?.length && (
            <details>
              <summary>
                {strings.solanaBenchmark.payloads} ({report.rpcRequests.length})
              </summary>
              <div className="solana-benchmark-errors">
                {report.rpcRequests.map((item) => (
                  <pre key={`${item.count}-${item.at}`}>
                    {JSON.stringify(
                      { jsonrpc: '2.0', id: item.count, method: item.method, params: item.params },
                      null,
                      2,
                    )}
                  </pre>
                ))}
              </div>
            </details>
          )}
        </div>
      )}

      <div className="solana-benchmark-grid">
        <article className="analysis-card">
          <h3>{strings.solanaBenchmark.provider}</h3>
          <strong>{report?.provider?.name ?? strings.solanaBenchmark.publicMainnet}</strong>
          <code>{report?.provider?.url ?? 'https://mainnet.helius-rpc.com/'}</code>
          {report?.provider?.configured === false &&
            report?.provider?.name?.startsWith('Helius') && (
              <p role="alert">
                Set <code>HELIUS_API_KEY</code> in <code>crypto/.env</code> before starting a run.
              </p>
            )}
        </article>
        <article className={`analysis-card solana-preflight-${status.toLowerCase()}`}>
          <h3>{strings.solanaBenchmark.history}</h3>
          <strong>{statusLabel}</strong>
          <p>
            {preflight?.reason ??
              (preflight
                ? `${preflight.availableSignatures ?? 0}/${preflight.testedSignatures ?? 0} known signatures available.`
                : strings.solanaBenchmark.unavailable)}
          </p>
          {preflight?.firstAvailableBlock !== undefined && (
            <small>First available confirmed slot: {preflight.firstAvailableBlock ?? '—'}</small>
          )}
          {preflight?.oldestRequiredTimestamp && (
            <small>Oldest required: {formatTime(preflight.oldestRequiredTimestamp)}</small>
          )}
        </article>
      </div>

      <div className="analysis-card solana-benchmark-results">
        <h3>{strings.solanaBenchmark.benchmark}</h3>
        <div className="solana-benchmark-metrics">
          <Metric
            label={strings.solanaBenchmark.legsTested}
            value={numberOrDash(benchmark?.sampleSize)}
          />
          <Metric
            label={strings.solanaBenchmark.solanaFound}
            value={numberOrDash(benchmark?.solanaFound)}
          />
          <Metric
            label="Parsed Events successes"
            value={numberOrDash(benchmark?.parsedEventsSuccesses)}
          />
          <Metric
            label="Indexed fallback successes"
            value={numberOrDash(benchmark?.indexedFallbackSuccesses)}
          />
          <Metric label="Usable token prices" value={numberOrDash(benchmark?.usableTokenPrices)} />
          <Metric label="Usable USD prices" value={numberOrDash(benchmark?.usableUsdPrices)} />
          <Metric
            label="Median lookup latency"
            value={numberOrDash(benchmark?.medianLookupLatencyMs, ' ms')}
          />
          <Metric
            label="Average API calls"
            value={numberOrDash(benchmark?.averageApiCallsPerLookup)}
          />
          <Metric
            label={strings.solanaBenchmark.duneFound}
            value={numberOrDash(benchmark?.duneFound)}
          />
          <Metric
            label={strings.solanaBenchmark.bothFound}
            value={numberOrDash(benchmark?.bothFound)}
          />
          <Metric
            label={strings.solanaBenchmark.sameSignature}
            value={numberOrDash(benchmark?.sameSignature)}
          />
          <Metric
            label={strings.solanaBenchmark.medianDifference}
            value={numberOrDash(benchmark?.medianAbsolutePriceDifferencePercent, '%')}
          />
          <Metric
            label={strings.solanaBenchmark.p95Difference}
            value={numberOrDash(benchmark?.p95AbsolutePriceDifferencePercent, '%')}
          />
        </div>
        <p>{strings.solanaBenchmark.comparisonNote}</p>
        {benchmark?.failures && (
          <div>
            <h3>{strings.solanaBenchmark.failures}</h3>
            {Object.entries(benchmark.failures.byReason).map(([reason, count]) => (
              <p key={reason}>
                {reason.replaceAll('_', ' ')}: {count}
              </p>
            ))}
          </div>
        )}
        {report?.generatedAt && (
          <small>
            {strings.solanaBenchmark.generatedAt}: {formatTime(report.generatedAt)}
          </small>
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="solana-benchmark-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
