import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../httpClient.js';
import { DataTable } from '../DataTable.js';

type Wallet = { walletAddress: string; name?: string | null; rank?: number | null };
type Summary = {
  tradeCount: number | null;
  winRate: number | null;
  pnl: number | null;
  holdSeconds: number | null;
  fetchedAt: string | null;
};
type Row = Wallet & { summary7d: Summary | null; summary30d: Summary | null };
type Props = {
  api: ApiClient;
  busy: boolean;
  completed?: boolean;
  onBusyChange: (busy: boolean) => void;
};
type FetchEstimate = {
  walletCount: number;
  freshWallets: number;
  coveredWallets: number;
  estimatedRequests: number;
  estimatedSeconds: number;
  confidence?: string;
};
const GMGN_PAGE_SIZE = 50;
const shortWalletAddress = (walletAddress: string): string =>
  walletAddress.length > 14
    ? `${walletAddress.slice(0, 7)}…${walletAddress.slice(-5)}`
    : walletAddress;

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'less than a minute';
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
};

const countFromStats = (raw: unknown): number | null => {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const nested = [
    value.trade_num,
    value.trade_count,
    value.trades,
    value.buy_count,
    value.sell_count,
  ];
  const direct = nested.find((item) => typeof item === 'number' && Number.isFinite(item));
  if (typeof direct === 'number') return direct;
  const pnl = value.pnl_stat;
  if (pnl && typeof pnl === 'object') return countFromStats(pnl);
  const buy = typeof value.buy === 'number' ? value.buy : null;
  const sell = typeof value.sell === 'number' ? value.sell : null;
  return buy !== null && sell !== null ? buy + sell : null;
};

const summaryFromStats = (rawPayload: string, fetchedAt: string): Summary => {
  try {
    const raw = JSON.parse(rawPayload) as Record<string, unknown>;
    const pnlStat = (raw.pnl_stat ?? {}) as Record<string, unknown>;
    const buy = typeof raw.buy === 'number' ? raw.buy : null;
    const sell = typeof raw.sell === 'number' ? raw.sell : null;
    return {
      tradeCount: buy !== null && sell !== null ? buy + sell : countFromStats(raw),
      winRate: typeof pnlStat.winrate === 'number' ? pnlStat.winrate : null,
      pnl:
        typeof raw.realized_profit_pnl === 'number'
          ? raw.realized_profit_pnl
          : Number(raw.realized_profit_pnl) || null,
      holdSeconds:
        typeof pnlStat.avg_holding_period === 'number'
          ? pnlStat.avg_holding_period
          : Number(pnlStat.avg_holding_period) || null,
      fetchedAt,
    };
  } catch {
    return { tradeCount: null, winRate: null, pnl: null, holdSeconds: null, fetchedAt: null };
  }
};

export function GmgnHistorySelectionPanel({ api, busy, completed = false, onBusyChange }: Props) {
  const [rows, setRows] = useState<Row[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<FetchEstimate | null>(null);
  const [hideNegativePnl, setHideNegativePnl] = useState(false);
  const [minTrades, setMinTrades] = useState('');
  const [maxTrades, setMaxTrades] = useState('');
  const [collapsed, setCollapsed] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [report, stats] = await Promise.all([
        api<{ wallets: Wallet[] }>('/api/copytrade/experimental-decision?limit=100'),
        api<{
          roster: Wallet[];
          stats: Array<{
            walletAddress: string;
            period: string;
            fetchedAt: string;
            rawPayload: string;
          }>;
        }>('/api/copytrade/stats?limit=100'),
      ]);
      const statMap = new Map<string, { summary7d: Summary | null; summary30d: Summary | null }>();
      for (const item of stats.stats) {
        const entry = statMap.get(item.walletAddress) ?? { summary7d: null, summary30d: null };
        const summary = summaryFromStats(item.rawPayload, item.fetchedAt);
        if (item.period === '7d') entry.summary7d = summary;
        if (item.period === '30d') entry.summary30d = summary;
        statMap.set(item.walletAddress, entry);
      }
      setRows(
        report.wallets.map((wallet) => ({
          ...wallet,
          ...(statMap.get(wallet.walletAddress) ?? { summary7d: null, summary30d: null }),
        })),
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load GMGN wallet summaries.');
    } finally {
      setLoading(false);
    }
  };
  const formatPercent = (value: number | null) =>
    value === null ? '—' : `${(value * 100).toFixed(1)}%`;
  const formatHold = (seconds: number | null) =>
    seconds === null
      ? '—'
      : seconds >= 3600
        ? `${(seconds / 3600).toFixed(1)}h`
        : `${Math.round(seconds / 60)}m`;
  useEffect(() => {
    void load();
  }, [api]);
  const visibleRows = useMemo(
    () =>
      rows.filter((row) => {
        if (hideNegativePnl && (row.summary30d?.pnl ?? 0) < 0) return false;
        const trades = row.summary30d?.tradeCount;
        const minimum = minTrades === '' ? null : Number(minTrades);
        const maximum = maxTrades === '' ? null : Number(maxTrades);
        if (
          minimum !== null &&
          Number.isFinite(minimum) &&
          (trades === null || trades === undefined || trades < minimum)
        )
          return false;
        if (
          maximum !== null &&
          Number.isFinite(maximum) &&
          (trades === null || trades === undefined || trades > maximum)
        )
          return false;
        return true;
      }),
    [hideNegativePnl, maxTrades, minTrades, rows],
  );
  const selectedRows = useMemo(
    () => visibleRows.filter((row) => selected.has(row.walletAddress)),
    [visibleRows, selected],
  );
  const pageBasedRequests = useMemo(
    () =>
      selectedRows.reduce((total, row) => {
        const trades = row.summary30d?.tradeCount ?? 0;
        return total + Math.max(1, Math.ceil(trades / GMGN_PAGE_SIZE)) + 1;
      }, 0),
    [selectedRows],
  );
  useEffect(() => {
    if (!hideNegativePnl) return;
    const visibleAddresses = new Set(visibleRows.map((row) => row.walletAddress));
    setSelected(
      (current) => new Set([...current].filter((address) => visibleAddresses.has(address))),
    );
  }, [hideNegativePnl, visibleRows]);
  useEffect(() => {
    if (!selectedRows.length) {
      setEstimate(null);
      return;
    }
    let disposed = false;
    const query = encodeURIComponent(selectedRows.map((row) => row.walletAddress).join(','));
    void api<FetchEstimate>(`/api/copytrade/fetch/estimate?periodDays=365&walletAddresses=${query}`)
      .then((result) => {
        if (!disposed) setEstimate(result);
      })
      .catch(() => {
        if (!disposed) setEstimate(null);
      });
    return () => {
      disposed = true;
    };
  }, [api, selectedRows]);
  useEffect(() => {
    if (busy) setCollapsed(false);
    else if (completed) setCollapsed(true);
  }, [busy, completed]);
  const start = async () => {
    if (!selectedRows.length) return;
    onBusyChange(true);
    setMessage(null);
    try {
      const walletAddresses = selectedRows.map((row) => row.walletAddress);
      await api('/api/copytrade/fetch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          walletAddresses,
          limit: walletAddresses.length,
          periodDays: 365,
          scope: 'single',
        }),
      });
      setMessage(
        `GMGN history fetch started for ${walletAddresses.length} wallet${walletAddresses.length === 1 ? '' : 's'}.`,
      );
    } catch (error) {
      onBusyChange(false);
      setMessage(error instanceof Error ? error.message : 'GMGN history fetch could not start.');
    }
  };
  if (collapsed) {
    return (
      <section
        className="copytrade-data-fetch-panel copytrade-stage-collapsed"
        aria-labelledby="history-selection-title"
      >
        <button
          type="button"
          className="copytrade-stage-collapsed-toggle"
          onClick={() => setCollapsed(false)}
          aria-expanded="false"
        >
          <span>
            <strong>STAGE 2 · GMGN history</strong>
            <small>Completed · {rows.length} wallet summaries available</small>
          </span>
          <span>Show details</span>
        </button>
      </section>
    );
  }
  return (
    <section className="copytrade-data-fetch-panel" aria-labelledby="history-selection-title">
      <p className="eyebrow">STAGE 2 · SELECT GMGN HISTORY</p>
      <h3 id="history-selection-title">Choose wallets for history</h3>
      <p>
        GMGN summaries are fetched first. Select only the wallets whose full activity history you
        want to retrieve.
      </p>
      {selectedRows.length > 0 && estimate && (
        <div className="copytrade-fetch-estimate" role="status">
          <strong>Estimated fetch</strong> {estimate.walletCount} wallet
          {estimate.walletCount === 1 ? '' : 's'} · {formatDuration(estimate.estimatedSeconds)} · ~
          {estimate.estimatedRequests.toLocaleString()} requests
          <small>
            Minimum ~{pageBasedRequests.toLocaleString()} requests · {estimate.coveredWallets}{' '}
            covered · {estimate.freshWallets} need history
          </small>
        </div>
      )}
      <div className="copytrade-data-fetch-toolbar">
        <button
          type="button"
          className="secondary"
          onClick={() => void load()}
          disabled={loading || busy}
        >
          Refresh summaries
        </button>
        <label className="copytrade-toggle-label">
          <input
            type="checkbox"
            checked={hideNegativePnl}
            disabled={busy}
            onChange={(event) => setHideNegativePnl(event.currentTarget.checked)}
          />{' '}
          Hide negative P&amp;L
        </label>
        <label className="copytrade-filter-label">
          Min trades (30d)
          <input
            type="number"
            min="0"
            inputMode="numeric"
            value={minTrades}
            disabled={busy}
            onChange={(event) => setMinTrades(event.currentTarget.value)}
          />
        </label>
        <label className="copytrade-filter-label">
          Max trades (30d)
          <input
            type="number"
            min="0"
            inputMode="numeric"
            value={maxTrades}
            disabled={busy}
            onChange={(event) => setMaxTrades(event.currentTarget.value)}
          />
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => void start()}
          disabled={!selectedRows.length || busy}
        >
          Fetch GMGN history ({selectedRows.length})
        </button>
      </div>
      {message && (
        <p className="copytrade-status-warning" role="status">
          {message}
        </p>
      )}
      {completed && !busy && (
        <button
          type="button"
          className="secondary copytrade-stage-collapse-button"
          onClick={() => setCollapsed(true)}
        >
          Collapse completed stage
        </button>
      )}
      <DataTable
        rows={visibleRows}
        getRowKey={(row) => row.walletAddress}
        tableClassName="copytrade-data-fetch-table"
        emptyMessage="No wallet summaries available."
        selection={{
          selectedKeys: selected,
          disabled: busy,
          onChange: (keys) => setSelected(new Set([...keys].map(String))),
        }}
        columns={[
          {
            key: 'wallet',
            header: 'Wallet',
            sortValue: (row) => row.name || row.walletAddress,
            render: (row) => (
              <>
                <strong>{row.name || shortWalletAddress(row.walletAddress)}</strong>
                <small title={row.walletAddress}>{shortWalletAddress(row.walletAddress)}</small>
              </>
            ),
          },
          {
            key: 'rank',
            header: 'Rank',
            sortValue: (row) => row.rank,
            render: (row) => row.rank ?? '—',
          },
          {
            key: 'trades7d',
            header: 'Trades (7d)',
            sortValue: (row) => row.summary7d?.tradeCount,
            render: (row) => row.summary7d?.tradeCount?.toLocaleString() ?? '—',
          },
          {
            key: 'trades30d',
            header: 'Trades (30d)',
            sortValue: (row) => row.summary30d?.tradeCount,
            render: (row) => row.summary30d?.tradeCount?.toLocaleString() ?? '—',
          },
          {
            key: 'winRate',
            header: 'Win rate (30d)',
            sortValue: (row) => row.summary30d?.winRate,
            render: (row) => formatPercent(row.summary30d?.winRate ?? null),
          },
          {
            key: 'pnl',
            header: 'Realized PnL (30d)',
            sortValue: (row) => row.summary30d?.pnl,
            render: (row) => formatPercent(row.summary30d?.pnl ?? null),
          },
          {
            key: 'hold',
            header: 'Avg hold',
            sortValue: (row) => row.summary30d?.holdSeconds,
            render: (row) => formatHold(row.summary30d?.holdSeconds ?? null),
          },
          {
            key: 'updated',
            header: 'Updated',
            sortValue: (row) => row.summary30d?.fetchedAt,
            render: (row) =>
              row.summary30d?.fetchedAt
                ? new Date(row.summary30d.fetchedAt).toLocaleDateString()
                : '—',
          },
        ]}
      />
    </section>
  );
}
