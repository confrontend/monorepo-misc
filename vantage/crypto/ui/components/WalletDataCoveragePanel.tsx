import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../httpClient.js';
import { DataTable } from './DataTable.js';
import { FormattedDate } from './FormattedDate.js';
import { StatusPill } from './StatusPill.js';

export type WalletDataCoverageAssessment = 'complete_requested_window' | 'incomplete' | 'unknown';

export type WalletDataCoverageRow = {
  walletAddress: string;
  name: string | null;
  rankPosition: number | null;
  rawActivityCount: number;
  buyCount: number;
  sellCount: number;
  oldestActivityAt: string | null;
  newestActivityAt: string | null;
  availableSpanDays: number | null;
  assessment: WalletDataCoverageAssessment;
  coverageRequestedPeriodDays: number | null;
  truncated: boolean | null;
  stopReason: string | null;
  requestsUsed: number | null;
  coverageUpdatedAt: string | null;
  officialStatsPeriod: string | null;
  officialStatsFetchedAt: string | null;
  snapshotCount: number;
  latestFeatureSnapshotAt: string | null;
};

export type WalletDataCoverageResponse = {
  generatedAt: string;
  chain: string;
  requestedPeriodDays: number;
  availabilitySemantics: {
    description: string;
  };
  summary: {
    total: number;
    complete: number;
    incomplete: number;
    unknown: number;
  };
  rows: WalletDataCoverageRow[];
};

const ENDPOINT = '/api/copytrade/feature-coverage?periodDays=30&limit=100';
const COPY = {
  title: 'Wallet data coverage',
  description: 'Read-only inventory of locally available wallet evidence.',
  generated: 'Generated',
  total: 'Wallets',
  complete: 'Complete',
  incomplete: 'Incomplete',
  unknown: 'Unknown',
  details: 'Coverage details',
  filterLabel: 'Filter coverage by wallet or name',
  filterPlaceholder: 'Filter wallet or name',
  loading: 'Loading wallet data coverage…',
  error: 'Wallet data coverage could not be loaded.',
  empty: 'No wallets match this filter.',
  availabilityWarning:
    'Oldest activity is an availability marker only. It does not prove continuous coverage between the oldest and newest stored rows.',
} as const;

const numberFormatter = new Intl.NumberFormat('en-CA');

const numberOrDash = (value: number | null): string =>
  value === null ? '—' : numberFormatter.format(value);

const periodDaysOrDash = (value: number | null): string =>
  value === null ? '—' : `${numberFormatter.format(value)}d`;

const daysOrDash = (value: number | null): string =>
  value === null ? '—' : `${value.toFixed(1)}d`;

const assessmentLabel = (assessment: WalletDataCoverageAssessment): string => {
  if (assessment === 'complete_requested_window') return 'Complete requested window';
  if (assessment === 'incomplete') return 'Incomplete';
  return 'Unknown';
};

const assessmentTone = (assessment: WalletDataCoverageAssessment): string => {
  if (assessment === 'complete_requested_window') return 'pass';
  if (assessment === 'incomplete') return 'insufficient_evidence';
  return 'missing';
};

export const WalletDataCoveragePanel = ({ api }: { api: ApiClient }) => {
  const [response, setResponse] = useState<WalletDataCoverageResponse | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    void api<WalletDataCoverageResponse>(ENDPOINT)
      .then((result) => {
        if (!isMounted) return;
        setResponse(result);
        setError(null);
      })
      .catch((reason: unknown) => {
        if (!isMounted) return;
        setError(reason instanceof Error ? reason.message : COPY.error);
      });

    return () => {
      isMounted = false;
    };
  }, [api]);

  const rows = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return response?.rows ?? [];
    return (response?.rows ?? []).filter(
      (row) =>
        row.walletAddress.toLocaleLowerCase().includes(query) ||
        row.name?.toLocaleLowerCase().includes(query),
    );
  }, [filter, response]);

  const summary = response?.summary ?? { total: 0, complete: 0, incomplete: 0, unknown: 0 };

  return (
    <section className="copytrade-method-card" aria-labelledby="wallet-data-coverage-title">
      <div className="copytrade-results-meta">
        <div>
          <h3 id="wallet-data-coverage-title">{COPY.title}</h3>
          <small>{COPY.description}</small>
        </div>
        {response && (
          <small>
            {response.chain.toUpperCase()} · {response.requestedPeriodDays}d · {COPY.generated}{' '}
            <FormattedDate value={response.generatedAt} />
          </small>
        )}
      </div>

      <div className="copytrade-update-summary-grid" aria-label="Wallet data coverage summary">
        <div>
          <b>{numberFormatter.format(summary.total)}</b>
          <span>{COPY.total}</span>
        </div>
        <div>
          <b>{numberFormatter.format(summary.complete)}</b>
          <span>{COPY.complete}</span>
        </div>
        <div>
          <b>{numberFormatter.format(summary.incomplete)}</b>
          <span>{COPY.incomplete}</span>
        </div>
        <div>
          <b>{numberFormatter.format(summary.unknown)}</b>
          <span>{COPY.unknown}</span>
        </div>
      </div>

      <details className="copytrade-update-summary">
        <summary>
          <strong>{COPY.details}</strong>
          <span>
            {numberFormatter.format(rows.length)} of {numberFormatter.format(summary.total)} wallets
          </span>
        </summary>

        <div className="copytrade-update-changes">
          <span>{response?.availabilitySemantics.description ?? COPY.availabilityWarning}</span>
          <small>{COPY.availabilityWarning}</small>
        </div>

        <div className="experimental-table-toolbar">
          <label className="experimental-wallet-filter">
            <span className="visually-hidden">{COPY.filterLabel}</span>
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={COPY.filterPlaceholder}
              aria-label={COPY.filterLabel}
            />
          </label>
        </div>

        <DataTable<WalletDataCoverageRow>
          rows={rows}
          getRowKey={(row) => row.walletAddress}
          wrapClassName="copytrade-table-wrap"
          tableClassName="copytrade-table"
          enableColumnHiding
          columnVisibilityStorageKey="vantage-wallet-data-coverage-columns"
          isLoading={!response && !error}
          loadingMessage={COPY.loading}
          isError={Boolean(error)}
          errorMessage={error ?? COPY.error}
          emptyMessage={COPY.empty}
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
              key: 'rank',
              header: 'Rank',
              sortValue: (row) => row.rankPosition,
              render: (row) => (row.rankPosition === null ? '—' : `#${row.rankPosition}`),
            },
            {
              key: 'assessment',
              header: 'Coverage',
              sortValue: (row) => row.assessment,
              render: (row) => (
                <div>
                  <StatusPill status={assessmentTone(row.assessment)}>
                    {assessmentLabel(row.assessment)}
                  </StatusPill>
                  <small>
                    Requested: {periodDaysOrDash(row.coverageRequestedPeriodDays)} · Truncated:{' '}
                    {row.truncated === null ? 'Unknown' : row.truncated ? 'Yes' : 'No'}
                  </small>
                  {row.stopReason && <small>{row.stopReason}</small>}
                </div>
              ),
            },
            {
              key: 'activity',
              header: 'Activity',
              sortValue: (row) => row.rawActivityCount,
              render: (row) => (
                <div>
                  <strong>{numberFormatter.format(row.rawActivityCount)}</strong>
                  <small>
                    {numberFormatter.format(row.buyCount)} buys ·{' '}
                    {numberFormatter.format(row.sellCount)} sells
                  </small>
                </div>
              ),
            },
            {
              key: 'available-span',
              header: 'Available span',
              sortValue: (row) => row.availableSpanDays,
              render: (row) => (
                <div>
                  <strong>{daysOrDash(row.availableSpanDays)}</strong>
                  <small>
                    Oldest: <FormattedDate value={row.oldestActivityAt} />
                  </small>
                  <small>
                    Newest: <FormattedDate value={row.newestActivityAt} />
                  </small>
                </div>
              ),
            },
            {
              key: 'coverage-marker',
              header: 'Coverage marker',
              sortValue: (row) => row.coverageUpdatedAt,
              render: (row) => (
                <div>
                  <FormattedDate value={row.coverageUpdatedAt} />
                  <small>{numberOrDash(row.requestsUsed)} requests used</small>
                </div>
              ),
            },
            {
              key: 'official-stats',
              header: 'Official stats',
              sortValue: (row) => row.officialStatsFetchedAt,
              render: (row) => (
                <div>
                  <strong>{row.officialStatsPeriod ?? '—'}</strong>
                  <small>
                    Fetched: <FormattedDate value={row.officialStatsFetchedAt} />
                  </small>
                </div>
              ),
            },
            {
              key: 'snapshots',
              header: 'Feature snapshots',
              sortValue: (row) => row.snapshotCount,
              render: (row) => (
                <div>
                  <strong>{numberFormatter.format(row.snapshotCount)}</strong>
                  <small>
                    Latest: <FormattedDate value={row.latestFeatureSnapshotAt} />
                  </small>
                </div>
              ),
            },
          ]}
        />
      </details>
    </section>
  );
};
