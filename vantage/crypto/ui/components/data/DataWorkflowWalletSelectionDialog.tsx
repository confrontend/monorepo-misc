import { useEffect, useState } from 'react';
import type { ApiClient } from '../../httpClient.js';
import { DataTable } from '../DataTable.js';
import { Modal } from '../Modal.js';
import { StatusPill } from '../StatusPill.js';
import type { DataWorkflowRosterWallet } from './dataWorkflowRosterTypes.js';

type DataWorkflowWalletSelectionDialogProps = {
  wallets: DataWorkflowRosterWallet[];
  selectedWallets: Set<string>;
  onToggleWallet: (walletAddress: string) => void;
  onSetSelectedWallets: (walletAddresses: string[]) => void;
  onClose: () => void;
  onConfirm: () => void;
  periodDays: number;
  chain: string;
  api: ApiClient;
};

type FetchProjection = {
  estimatedSeconds: number;
  estimatedRequests: number;
  walletCount: number;
  freshWallets: number;
  coveredWallets: number;
  confidence: 'seeded' | 'low' | 'medium' | 'high';
  basis: {
    source: 'measured' | 'default';
    runsCounted: number;
  };
};

const gmgnWalletUrl = (walletAddress: string): string =>
  `https://gmgn.ai/sol/address/${encodeURIComponent(walletAddress)}`;

const walletName = (wallet: DataWorkflowRosterWallet): string => wallet.name ?? 'Unnamed wallet';

const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
};

const errorMessage = (reason: unknown): string =>
  reason instanceof Error ? reason.message : 'Fetch estimate unavailable.';

export function DataWorkflowWalletSelectionDialog({
  wallets,
  selectedWallets,
  onToggleWallet,
  onSetSelectedWallets,
  onClose,
  onConfirm,
  periodDays,
  chain,
  api,
}: DataWorkflowWalletSelectionDialogProps) {
  const [minProfitabilityInput, setMinProfitabilityInput] = useState('');
  const [minTradesInput, setMinTradesInput] = useState('');
  const [maxTradesInput, setMaxTradesInput] = useState('');
  const [verified60dOnly, setVerified60dOnly] = useState(false);
  const [estimate, setEstimate] = useState<FetchProjection | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const [loadingEstimate, setLoadingEstimate] = useState(false);
  const minProfitability =
    minProfitabilityInput.trim() === '' ? null : Number(minProfitabilityInput);
  const minTrades = minTradesInput.trim() === '' ? null : Number(minTradesInput);
  const maxTrades = maxTradesInput.trim() === '' ? null : Number(maxTradesInput);
  const hasValidMinProfitability = minProfitability === null || Number.isFinite(minProfitability);
  const hasValidMinTrades = minTrades === null || (Number.isInteger(minTrades) && minTrades >= 0);
  const hasValidMaxTrades = maxTrades === null || (Number.isInteger(maxTrades) && maxTrades >= 0);
  const matchesFilters = (
    wallet: DataWorkflowRosterWallet,
    requireVerified60d = verified60dOnly,
  ): boolean =>
    hasValidMinProfitability &&
    hasValidMinTrades &&
    hasValidMaxTrades &&
    (minProfitability === null ||
      (wallet.realizedPnlPercent !== null && wallet.realizedPnlPercent >= minProfitability)) &&
    (minTrades === null || wallet.tradeCount >= minTrades) &&
    (maxTrades === null || wallet.tradeCount <= maxTrades) &&
    (!requireVerified60d || wallet.verified60d);
  const isEligible = (wallet: DataWorkflowRosterWallet): boolean => matchesFilters(wallet);
  const eligibleWallets = wallets.filter(isEligible);

  const allEligibleSelected =
    eligibleWallets.length > 0 &&
    eligibleWallets.every((wallet) => selectedWallets.has(wallet.walletAddress));
  const selectedTradeCount = wallets.reduce(
    (total, wallet) =>
      selectedWallets.has(wallet.walletAddress) ? total + wallet.tradeCount : total,
    0,
  );

  useEffect(() => {
    if (selectedWallets.size === 0) {
      setEstimate(null);
      setEstimateError(null);
      setLoadingEstimate(false);
      return undefined;
    }

    let disposed = false;
    setLoadingEstimate(true);
    setEstimateError(null);
    const timer = window.setTimeout(() => {
      const query = new URLSearchParams({
        chain,
        periodDays: String(periodDays),
        limit: String(selectedWallets.size),
        walletAddresses: [...selectedWallets].join(','),
      });
      setLoadingEstimate(true);
      void api<FetchProjection>(`/api/copytrade/fetch/estimate?${query.toString()}`)
        .then((result) => {
          if (disposed) return;
          setEstimate(result);
          setEstimateError(null);
        })
        .catch((reason: unknown) => {
          if (!disposed) {
            setEstimate(null);
            setEstimateError(errorMessage(reason));
          }
        })
        .finally(() => {
          if (!disposed) setLoadingEstimate(false);
        });
    }, 250);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [api, chain, periodDays, selectedWallets]);

  const toggleAllEligible = () => {
    onSetSelectedWallets(
      allEligibleSelected ? [] : eligibleWallets.map((wallet) => wallet.walletAddress),
    );
  };

  const applyFilters = (
    nextMinProfitabilityInput: string,
    nextMinTradesInput: string,
    nextMaxTradesInput: string,
  ) => {
    const nextMinProfitability =
      nextMinProfitabilityInput.trim() === '' ? null : Number(nextMinProfitabilityInput);
    const nextMinTrades = nextMinTradesInput.trim() === '' ? null : Number(nextMinTradesInput);
    const nextMaxTrades = nextMaxTradesInput.trim() === '' ? null : Number(nextMaxTradesInput);
    setMinProfitabilityInput(nextMinProfitabilityInput);
    setMinTradesInput(nextMinTradesInput);
    setMaxTradesInput(nextMaxTradesInput);
    if (
      (nextMinProfitability !== null && !Number.isFinite(nextMinProfitability)) ||
      (nextMinTrades !== null && (!Number.isInteger(nextMinTrades) || nextMinTrades < 0)) ||
      (nextMaxTrades !== null && (!Number.isInteger(nextMaxTrades) || nextMaxTrades < 0))
    )
      return;
    onSetSelectedWallets(
      wallets
        .filter((wallet) =>
          nextMinProfitability !== null && !Number.isFinite(nextMinProfitability)
            ? false
            : nextMinTrades !== null && (!Number.isInteger(nextMinTrades) || nextMinTrades < 0)
              ? false
              : nextMaxTrades !== null && (!Number.isInteger(nextMaxTrades) || nextMaxTrades < 0)
                ? false
                : (nextMinProfitability === null ||
                    (wallet.realizedPnlPercent !== null &&
                      wallet.realizedPnlPercent >= nextMinProfitability)) &&
                  (nextMinTrades === null || wallet.tradeCount >= nextMinTrades) &&
                  (nextMaxTrades === null || wallet.tradeCount <= nextMaxTrades) &&
                  (!verified60dOnly || wallet.verified60d),
        )
        .map((wallet) => wallet.walletAddress),
    );
  };

  const toggleVerified60dOnly = () => {
    const nextValue = !verified60dOnly;
    setVerified60dOnly(nextValue);
    onSetSelectedWallets(
      wallets
        .filter((wallet) => matchesFilters(wallet, nextValue))
        .map((wallet) => wallet.walletAddress),
    );
  };

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Choose wallets for the Data workflow"
      dialogClassName="data-workflow-wallet-selection-modal"
    >
      <div className="copytrade-modal-head">
        <div>
          <p className="eyebrow">DATA WORKFLOW</p>
          <h3>Choose wallets to process</h3>
          <small>Select the wallets for this new run. Nothing starts until you confirm.</small>
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
      </div>

      <div className="dune-wallet-selection-summary">
        <strong>
          {selectedWallets.size} of {wallets.length} wallets selected
        </strong>
        <span>·</span>
        <strong>
          {selectedTradeCount.toLocaleString()} total trades ({periodDays}d)
        </strong>
      </div>

      <div className="data-workflow-fetch-estimate" role="status" aria-live="polite">
        <strong>
          Estimated fetch time:{' '}
          {loadingEstimate
            ? 'Calculating…'
            : estimate
              ? formatDuration(estimate.estimatedSeconds)
              : '—'}
        </strong>
        {estimate && (
          <small>
            {estimate.estimatedRequests.toLocaleString()} requests · {estimate.freshWallets} fresh
            wallets · {estimate.coveredWallets} already covered · {estimate.confidence} confidence
            {estimate.basis.source === 'measured'
              ? ` from ${estimate.basis.runsCounted} completed ${estimate.basis.runsCounted === 1 ? 'run' : 'runs'}`
              : ' (seed estimate)'}
          </small>
        )}
        {estimateError && <small className="error-message">{estimateError}</small>}
      </div>

      <div className="data-workflow-wallet-selection-filters" aria-label="Wallet selection filters">
        <label className="data-workflow-wallet-selection-checkbox-filter">
          <input type="checkbox" checked={verified60dOnly} onChange={toggleVerified60dOnly} />
          Only wallets with verified 60d coverage
        </label>
        <small>
          Based on saved coverage records; a future fetch may still recheck the provider.
        </small>
        <label>
          Min profitability ({periodDays}d, %)
          <input
            type="number"
            step="0.1"
            inputMode="decimal"
            value={minProfitabilityInput}
            onChange={(event) => applyFilters(event.target.value, minTradesInput, maxTradesInput)}
            placeholder="No minimum"
            aria-label={`Minimum profitability percentage in ${periodDays} days`}
          />
        </label>
        <label>
          Min trades ({periodDays}d)
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={minTradesInput}
            onChange={(event) =>
              applyFilters(minProfitabilityInput, event.target.value, maxTradesInput)
            }
            placeholder="No minimum"
            aria-label={`Minimum trades in ${periodDays} days`}
          />
        </label>
        <label>
          Max trades ({periodDays}d)
          <input
            type="number"
            min="0"
            step="1"
            inputMode="numeric"
            value={maxTradesInput}
            onChange={(event) =>
              applyFilters(minProfitabilityInput, minTradesInput, event.target.value)
            }
            placeholder="No limit"
            aria-label={`Maximum trades in ${periodDays} days`}
          />
        </label>
        {!hasValidMinProfitability && (
          <small className="error-message">Enter a valid percentage.</small>
        )}
        {!hasValidMinTrades && (
          <small className="error-message">Enter a whole number of trades.</small>
        )}
        {!hasValidMaxTrades && (
          <small className="error-message">Enter a whole number of trades.</small>
        )}
        <small>{eligibleWallets.length} wallets match the active filters.</small>
      </div>

      <DataTable
        rows={wallets}
        getRowKey={(wallet) => wallet.walletAddress}
        wrapClassName="table-wrap dune-wallet-selection-table data-workflow-wallet-selection-table"
        tableClassName="copytrade-table"
        emptyMessage="No saved GMGN roster is available. Refresh or import the roster first."
        columns={[
          {
            key: 'select',
            header: (
              <input
                type="checkbox"
                checked={allEligibleSelected}
                onChange={toggleAllEligible}
                aria-label="Select all wallets"
              />
            ),
            render: (wallet) => (
              <input
                type="checkbox"
                checked={selectedWallets.has(wallet.walletAddress)}
                onChange={() => onToggleWallet(wallet.walletAddress)}
                disabled={!isEligible(wallet)}
                aria-label={`Select ${walletName(wallet)}`}
              />
            ),
          },
          {
            key: 'rank',
            header: 'Rank',
            sortValue: (wallet) => wallet.rankPosition ?? Number.MAX_SAFE_INTEGER,
            render: (wallet) => (wallet.rankPosition === null ? '—' : `#${wallet.rankPosition}`),
          },
          {
            key: 'coverage60d',
            header: '60d coverage',
            sortValue: (wallet) => (wallet.verified60d ? 1 : 0),
            render: (wallet) => (
              <div>
                <StatusPill status={wallet.verified60d ? 'pass' : 'insufficient_evidence'}>
                  {wallet.verified60d ? 'Yes' : 'No'}
                </StatusPill>
                <small>
                  Deepest verified:{' '}
                  {wallet.deepestCompletedDays === null
                    ? '—'
                    : `${wallet.deepestCompletedDays.toFixed(1)}d`}
                </small>
              </div>
            ),
          },
          {
            key: 'wallet',
            header: 'Wallet',
            sortValue: (wallet) => walletName(wallet),
            render: (wallet) => (
              <div>
                <a
                  href={gmgnWalletUrl(wallet.walletAddress)}
                  target="_blank"
                  rel="noreferrer"
                  className="dune-wallet-selection-wallet-link"
                  title="Open wallet on GMGN"
                >
                  <strong>{walletName(wallet)}</strong>
                </a>
                <small className="dune-wallet-selection-address">{wallet.walletAddress}</small>
              </div>
            ),
          },
          {
            key: 'pnl',
            header: `Realized PNL (${periodDays}d)`,
            sortValue: (wallet) => wallet.realizedPnlPercent ?? Number.NEGATIVE_INFINITY,
            render: (wallet) =>
              wallet.realizedPnlPercent === null
                ? '—'
                : `${wallet.realizedPnlPercent >= 0 ? '+' : ''}${wallet.realizedPnlPercent.toFixed(1)}% ($${(wallet.realizedProfitUsd ?? 0).toFixed(2)})`,
          },
          {
            key: 'trades',
            header: `Trades (${periodDays}d)`,
            sortValue: (wallet) => wallet.tradeCount,
            render: (wallet) => wallet.tradeCount.toLocaleString(),
          },
        ]}
      />

      <div className="dune-wallet-selection-actions">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={selectedWallets.size === 0}
          onClick={onConfirm}
        >
          Start with selected wallets
        </button>
      </div>
    </Modal>
  );
}
