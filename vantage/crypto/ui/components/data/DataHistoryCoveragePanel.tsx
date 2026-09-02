import { useEffect, useMemo, useState } from 'react';
import { DataTable } from '../DataTable.js';
import { FormattedDate } from '../FormattedDate.js';
import { StatusPill } from '../StatusPill.js';
import { Collapsible } from '../Collapsible.js';
import type {
  DataHistoryCoverageResponse,
  DataHistoryCoverageRow,
  HistoryDepthStatus,
} from './dataWorkflowTypes.js';
export type {
  DataHistoryCoverageResponse,
  DataHistoryCoverageRow,
  HistoryDepthStatus,
} from './dataWorkflowTypes.js';

export type DataHistoryCoveragePanelProps = {
  response: DataHistoryCoverageResponse | null;
  loading?: boolean;
  error?: string | null;
  onRetryWallet?: (walletAddress: string) => void;
  retryingWalletAddress?: string | null;
};

const numberFormatter = new Intl.NumberFormat('en-CA');

const statusLabel = (status: HistoryDepthStatus): string => {
  if (status === 'reached_target') return 'Reached target';
  if (status === 'pagination_exhausted') return 'Pagination exhausted';
  if (status === 'not_fetched') return 'Not fetched';
  return status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());
};

const statusTone = (status: HistoryDepthStatus): string => {
  if (status === 'reached_target') return 'pass';
  if (status === 'pagination_exhausted' || status === 'partial') return 'insufficient_evidence';
  if (status === 'error') return 'fail';
  return 'missing';
};

const canRetry = (status: HistoryDepthStatus): boolean => status !== 'reached_target';

const HORIZONS = [30, 60, 90] as const;

const isHorizon = (value: number): value is (typeof HORIZONS)[number] =>
  (HORIZONS as readonly number[]).includes(value);

export function DataHistoryCoveragePanel({
  response,
  loading = false,
  error = null,
  onRetryWallet,
  retryingWalletAddress = null,
}: DataHistoryCoveragePanelProps) {
  const [filter, setFilter] = useState('');
  const [showWalletTable, setShowWalletTable] = useState(false);
  // Defaults to the run's own configured depth, but the user can browse any of the three
  // milestones independently -- the underlying response already carries all three per wallet
  // (readHistoryDepthCoverage always computes milestones for 30/60/90 regardless of targetDays),
  // so switching this needs no extra request.
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]>(
    response && isHorizon(response.targetDays) ? response.targetDays : 30,
  );
  const activeTargetDays = response?.targetDays ?? null;
  const viewingConfiguredDepth = horizon === activeTargetDays;

  useEffect(() => {
    if (activeTargetDays !== null && isHorizon(activeTargetDays)) setHorizon(activeTargetDays);
  }, [activeTargetDays]);

  const rows = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return response?.rows ?? [];
    return (response?.rows ?? []).filter(
      (row) =>
        row.walletAddress.toLocaleLowerCase().includes(query) ||
        row.name?.toLocaleLowerCase().includes(query),
    );
  }, [filter, response]);

  const totalWallets = response?.summary.total ?? 0;
  const milestoneCounts = response?.summary.byMilestone ?? {};

  return (
    <section className="copytrade-method-card" aria-labelledby="data-history-coverage-title">
      <div className="copytrade-results-meta">
        <div>
          <h3 id="data-history-coverage-title">History coverage by wallet</h3>
          <small>
            Coverage is evaluated per wallet. An old row shows availability, not continuous,
            gap-free provider coverage.
          </small>
        </div>
        {response && (
          <small>
            {response.chain.toUpperCase()} · target {response.targetDays}d · generated{' '}
            <FormattedDate value={response.generatedAt} />
          </small>
        )}
      </div>

      <div className="copytrade-update-summary-grid" aria-label="History coverage summary">
        <div>
          <b>{numberFormatter.format(totalWallets)}</b>
          <span>Wallets</span>
        </div>
        {response?.depthMilestones.map((milestone) => (
          <div key={milestone}>
            <b>{numberFormatter.format(milestoneCounts[milestone] ?? 0)}</b>
            <span>Verified {milestone}d</span>
          </div>
        ))}
      </div>

      <div className="copytrade-update-changes" role="note">
        <span>
          {response?.availabilitySemantics.description ??
            'Availability semantics are not available yet.'}
        </span>
        <span>
          Retryable: {numberFormatter.format(rows.filter((row) => canRetry(row.status)).length)} of{' '}
          {numberFormatter.format(rows.length)} shown
        </span>
      </div>

      <Collapsible
        className="copytrade-update-summary"
        open={showWalletTable}
        onToggle={setShowWalletTable}
        summary={
          <>
            <strong>Wallet coverage at {horizon}d</strong>
            <span>
              {numberFormatter.format(rows.length)} of {numberFormatter.format(totalWallets)}{' '}
              wallets
            </span>
          </>
        }
      >
        <div className="copytrade-workflow-row">
          <label>
            <span className="visually-hidden">Filter coverage by wallet or name</span>
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter wallet or name"
              aria-label="Filter coverage by wallet or name"
            />
          </label>
          <label>
            <span>View coverage at</span>
            <select
              value={horizon}
              onChange={(event) =>
                setHorizon(Number(event.target.value) as (typeof HORIZONS)[number])
              }
              aria-label="View coverage at horizon"
            >
              {HORIZONS.map((option) => (
                <option key={option} value={option}>
                  {option} days{option === activeTargetDays ? ' (configured)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        {!viewingConfiguredDepth && (
          <p className="muted">
            Showing whether each wallet has ever verified {horizon} days of history, independent of
            the workflow&apos;s configured {activeTargetDays ?? '—'}-day depth. Retry always targets
            the configured depth — switch &quot;Requested history window&quot; above to retry at{' '}
            {horizon} days instead.
          </p>
        )}

        <DataTable<DataHistoryCoverageRow>
          rows={rows}
          getRowKey={(row) => row.walletAddress}
          wrapClassName="copytrade-table-wrap"
          tableClassName="copytrade-table"
          isLoading={loading}
          loadingMessage="Loading history coverage…"
          isError={Boolean(error)}
          errorMessage={error ?? 'History coverage could not be loaded.'}
          emptyMessage="No wallets match this filter."
          columns={[
            {
              key: 'wallet',
              header: 'Wallet',
              sortValue: (row) => row.name ?? row.walletAddress,
              render: (row) => (
                <div>
                  <strong>{row.name?.trim() || 'Unnamed wallet'}</strong>
                  <small>{row.walletAddress}</small>
                </div>
              ),
            },
            {
              key: 'coverage',
              header: `Coverage at ${horizon}d`,
              sortValue: (row) =>
                viewingConfiguredDepth ? row.deepestCompletedDays : row.milestones[horizon] ? 1 : 0,
              render: (row) =>
                viewingConfiguredDepth ? (
                  <div>
                    <StatusPill status={statusTone(row.status)}>
                      {statusLabel(row.status)}
                    </StatusPill>
                    <small>
                      Deepest verified:{' '}
                      {row.deepestCompletedDays === null
                        ? '—'
                        : `${row.deepestCompletedDays.toFixed(1)}d`}
                    </small>
                    {row.stopReason && <small>Stop: {row.stopReason}</small>}
                  </div>
                ) : (
                  <div>
                    <StatusPill status={row.milestones[horizon] ? 'pass' : 'missing'}>
                      {row.milestones[horizon]
                        ? `Verified ${horizon}d`
                        : `Not verified ${horizon}d`}
                    </StatusPill>
                    <small>
                      Deepest verified:{' '}
                      {row.deepestCompletedDays === null
                        ? '—'
                        : `${row.deepestCompletedDays.toFixed(1)}d`}
                    </small>
                  </div>
                ),
            },
            {
              key: 'activity',
              header: 'Activity',
              sortValue: (row) => row.tradeCount,
              render: (row) => (
                <div>
                  <strong>{numberFormatter.format(row.tradeCount)}</strong>
                  <small>{numberFormatter.format(row.pagesFetched ?? 0)} pages fetched</small>
                </div>
              ),
            },
            {
              key: 'available',
              header: 'Available span',
              sortValue: (row) => row.daysAvailable,
              render: (row) => (
                <div>
                  <strong>
                    {row.daysAvailable === null ? '—' : `${row.daysAvailable.toFixed(1)}d`}
                  </strong>
                  <small>
                    Oldest: <FormattedDate value={row.oldestTradeAt} />
                  </small>
                  <small>
                    Newest: <FormattedDate value={row.newestTradeAt} />
                  </small>
                </div>
              ),
            },
            {
              key: 'action',
              header: 'Action',
              render: (row) => {
                if (!viewingConfiguredDepth) {
                  return (
                    <span className="muted">
                      {row.milestones[horizon]
                        ? `Verified at ${horizon}d`
                        : `Not verified at ${horizon}d`}
                    </span>
                  );
                }
                return onRetryWallet && canRetry(row.status) ? (
                  <div>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => onRetryWallet(row.walletAddress)}
                      disabled={retryingWalletAddress === row.walletAddress}
                    >
                      {retryingWalletAddress === row.walletAddress ? 'Retrying…' : 'Retry wallet'}
                    </button>
                    {row.lastError && <small>{row.lastError}</small>}
                  </div>
                ) : (
                  <span className="muted">
                    {row.status === 'reached_target' ? 'Complete' : 'No retry'}
                  </span>
                );
              },
            },
          ]}
        />
      </Collapsible>
    </section>
  );
}
