import { useState } from 'react';
import { DataTable } from './DataTable.js';
import { Modal } from './Modal.js';
import type { CopyTradeRow } from '../types.js';
import { UI_STRINGS } from '../strings.js';

type DuneWalletSelectionDialogProps = {
  rows: CopyTradeRow[];
  selectedWallets: Set<string>;
  onToggleWallet: (walletAddress: string) => void;
  onToggleAll: () => void;
  onClose: () => void;
  onConfirm: () => void;
  periodDays: number;
  tradeCounts: Record<string, number>;
  profitability: Record<string, number | null>;
  onSelectProfitable: (enabled: boolean) => void;
};

const formatTradeCount = (trades: number | null): string =>
  trades === null ? '—' : new Intl.NumberFormat().format(trades);
const gmgnWalletUrl = (walletAddress: string): string =>
  `https://gmgn.ai/sol/address/${encodeURIComponent(walletAddress)}`;

export const DuneWalletSelectionDialog = ({
  rows,
  selectedWallets,
  onToggleWallet,
  onToggleAll,
  onClose,
  onConfirm,
  periodDays,
  tradeCounts,
  profitability,
  onSelectProfitable,
}: DuneWalletSelectionDialogProps) => {
  const [profitableOnly, setProfitableOnly] = useState(false);
  const allSelected =
    rows.length > 0 && rows.every((row) => selectedWallets.has(row.walletAddress));
  const selectedTradeCount = rows.reduce(
    (total, row) =>
      selectedWallets.has(row.walletAddress)
        ? total + (tradeCounts[row.walletAddress] ?? 0)
        : total,
    0,
  );
  const strings = UI_STRINGS.patternDiscovery.duneWalletSelection;

  return (
    <Modal
      onClose={onClose}
      ariaLabel="Choose wallets for Dune diagnostics"
      dialogClassName="dune-wallet-selection-modal"
    >
      <div className="copytrade-modal-head">
        <div>
          <p className="eyebrow">{strings.eyebrow}</p>
          <h3>{strings.title}</h3>
          <small>{strings.description}</small>
        </div>
        <button type="button" className="secondary" onClick={onClose}>
          {strings.cancel}
        </button>
      </div>
      <div className="dune-wallet-selection-summary">
        <strong>{strings.selected(selectedWallets.size, rows.length)}</strong>
        <span>·</span>
        <strong>{formatTradeCount(selectedTradeCount)}</strong> {strings.trades(periodDays)}
      </div>
      <label className="dune-wallet-selection-toggle">
        <input
          type="checkbox"
          checked={profitableOnly}
          onChange={(event) => {
            const enabled = event.target.checked;
            setProfitableOnly(enabled);
            onSelectProfitable(enabled);
          }}
        />
        {strings.profitableOnly(periodDays)}
      </label>
      <DataTable
        rows={rows}
        getRowKey={(row) => row.walletAddress}
        wrapClassName="table-wrap dune-wallet-selection-table"
        tableClassName="copytrade-table"
        emptyMessage={strings.empty}
        columns={[
          {
            key: 'select',
            header: (
              <label className="dune-wallet-selection-checkbox dune-wallet-selection-checkbox-only">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                  aria-label="Select all wallets"
                />
              </label>
            ),
            render: (row) => (
              <input
                type="checkbox"
                checked={selectedWallets.has(row.walletAddress)}
                onChange={() => onToggleWallet(row.walletAddress)}
                aria-label={`Select ${row.name ?? row.walletAddress}`}
              />
            ),
          },
          {
            key: 'wallet',
            // Keep the rank directly after the checkbox column so the roster context is visible
            // before the wallet identity and period metrics.
            header: strings.rank,
            sortValue: (row) => row.rankHistory.currentRank,
            render: (row) =>
              row.rankHistory.currentRank === null ? '—' : `#${row.rankHistory.currentRank}`,
          },
          {
            key: 'wallet-name',
            header: strings.wallet,
            sortValue: (row) => row.name ?? row.walletAddress,
            render: (row) => (
              <div>
                <a
                  href={gmgnWalletUrl(row.walletAddress)}
                  target="_blank"
                  rel="noreferrer"
                  className="dune-wallet-selection-wallet-link"
                  title="Open wallet on GMGN"
                >
                  <strong>{row.name ?? 'Unnamed wallet'}</strong>
                </a>
                <small className="dune-wallet-selection-address">{row.walletAddress}</small>
              </div>
            ),
          },
          {
            key: 'trades',
            header: strings.totalTrades(periodDays),
            render: (row) => formatTradeCount(tradeCounts[row.walletAddress] ?? null),
            sortValue: (row) => tradeCounts[row.walletAddress] ?? null,
          },
          {
            key: 'profitability',
            header: strings.profitability(periodDays),
            render: (row) => {
              const value = profitability[row.walletAddress];
              return value === null || value === undefined ? '—' : `${value.toFixed(1)}%`;
            },
            sortValue: (row) => profitability[row.walletAddress] ?? null,
          },
        ]}
      />
      <div className="dune-wallet-selection-actions">
        <button type="button" className="secondary" onClick={onClose}>
          {strings.cancel}
        </button>
        <button
          type="button"
          className="primary"
          disabled={selectedWallets.size === 0}
          onClick={onConfirm}
        >
          {strings.confirm}
        </button>
      </div>
    </Modal>
  );
};
