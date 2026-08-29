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
};

const formatTradeCount = (trades: number | null): string =>
  trades === null ? '—' : new Intl.NumberFormat().format(trades);

export const DuneWalletSelectionDialog = ({
  rows,
  selectedWallets,
  onToggleWallet,
  onToggleAll,
  onClose,
  onConfirm,
}: DuneWalletSelectionDialogProps) => {
  const allSelected =
    rows.length > 0 && rows.every((row) => selectedWallets.has(row.walletAddress));
  const selectedTradeCount = rows.reduce(
    (total, row) =>
      selectedWallets.has(row.walletAddress) && row.trades !== null ? total + row.trades : total,
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
        <strong>{formatTradeCount(selectedTradeCount)}</strong> {strings.trades}
      </div>
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
              <label className="dune-wallet-selection-checkbox">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={onToggleAll}
                  aria-label="Select all wallets"
                />
                {strings.selectAll}
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
            header: strings.wallet,
            render: (row) => (
              <div>
                <strong>{row.name ?? 'Unnamed wallet'}</strong>
                <small className="dune-wallet-selection-address">{row.walletAddress}</small>
              </div>
            ),
          },
          {
            key: 'trades',
            header: strings.totalTrades,
            render: (row) => formatTradeCount(row.trades),
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
