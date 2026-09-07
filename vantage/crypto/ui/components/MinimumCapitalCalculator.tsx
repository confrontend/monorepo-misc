import { useEffect, useMemo, useState } from 'react';
import { DataTable } from './DataTable.js';
import { Modal } from './Modal.js';
import { strings } from '../strings.js';
import type { ApiClient } from '../httpClient.js';
import { copyJson } from '../app/appExports.js';
import { gmgnWalletUrl } from '../app/appLinks.js';

export type MinimumCapitalWallet = {
  walletAddress: string;
  name: string | null;
  rank: number | null;
};

export type MinimumCapitalConfiguration = {
  startingCapitalUsd: number;
  copyAmountUsd: number;
  totalTrades?: number;
  eligibleTrades?: number;
  executedTrades: number;
  skippedTrades: number;
  insufficientCashSkips: number;
  feesUsd: number;
  endingCapitalUsd: number;
  returnPct: number;
};

export type MinimumCapitalResult = {
  walletAddress: string;
  walletName?: string | null;
  recommendedStartingCapitalUsd: number | null;
  recommendedCopyAmountUsd: number | null;
  technicallyPossibleMinimumCapitalUsd?: number | null;
  executedTrades: number;
  skippedTrades: number;
  executedTradeRate: number | null;
  insufficientCashSkips: number;
  maxConcurrentCapitalUsd: number | null;
  totalCapitalDeployedUsd: number | null;
  feesUsd: number | null;
  grossPnlUsd?: number | null;
  netPnlUsd?: number | null;
  endingCapitalUsd: number | null;
  returnPct: number | null;
  cached?: boolean;
  status?: 'cached' | 'needs_calculation' | 'outdated' | 'calculated';
  testedConfigurations?: MinimumCapitalConfiguration[];
};

type MinimumCapitalResponse = {
  results?: MinimumCapitalResult[];
  wallets?: MinimumCapitalResult[];
  runId?: number;
  status?: 'running' | 'completed' | 'error' | 'idle';
  walletTotal?: number;
  walletDone?: number;
  currentWalletAddress?: string | null;
  error?: string | null;
};

type MinimumCapitalCalculatorProps = {
  api: ApiClient;
  wallets: MinimumCapitalWallet[];
  selectedKeys: Set<string>;
};

const resultFor = (response: MinimumCapitalResponse): MinimumCapitalResult[] =>
  (response.results ?? response.wallets ?? []).filter(
    (result): result is MinimumCapitalResult => result !== null,
  );

const usd = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: Math.abs(value) < 10 ? 2 : 0,
      }).format(value);

const pct = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : `${Math.round(value)}%`;

const walletLabel = (result: MinimumCapitalResult, wallets: MinimumCapitalWallet[]) =>
  result.walletName?.trim() ||
  wallets.find((wallet) => wallet.walletAddress === result.walletAddress)?.name?.trim() ||
  `${result.walletAddress.slice(0, 6)}…${result.walletAddress.slice(-4)}`;

const statusLabel = (result: MinimumCapitalResult): string => {
  if (result.cached || result.status === 'cached') return strings.decisionLab.minimumCapital.cached;
  if (result.status === 'outdated') return strings.decisionLab.minimumCapital.outdated;
  if (result.status === 'needs_calculation')
    return strings.decisionLab.minimumCapital.needsCalculation;
  if (result.status === 'calculated') return strings.decisionLab.minimumCapital.calculated;
  return strings.decisionLab.minimumCapital.cached;
};

/** Winner-only capital planning UI. Calculation is delegated to the local API and never fetches
 * provider data from this component. */
export const MinimumCapitalCalculator = ({
  api,
  wallets,
  selectedKeys,
}: MinimumCapitalCalculatorProps) => {
  const [results, setResults] = useState<MinimumCapitalResult[]>([]);
  const [details, setDetails] = useState<MinimumCapitalResult | null>(null);
  const [running, setRunning] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
    current: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedWallets = useMemo(
    () => wallets.filter((wallet) => selectedKeys.has(wallet.walletAddress)),
    [selectedKeys, wallets],
  );
  const selectedAddressKey = selectedWallets.map((wallet) => wallet.walletAddress).join(',');

  useEffect(() => {
    let cancelled = false;
    if (!selectedAddressKey) {
      setResults([]);
      setDetails(null);
      return () => {
        cancelled = true;
      };
    }

    void api<MinimumCapitalResponse>(
      `/api/copytrade/minimum-capital?walletAddresses=${encodeURIComponent(selectedAddressKey)}`,
    )
      .then((response) => {
        if (cancelled) return;
        const savedResults = resultFor(response);
        setResults(savedResults);
        setDetails((current) =>
          current && savedResults.some((result) => result.walletAddress === current.walletAddress)
            ? savedResults.find((result) => result.walletAddress === current.walletAddress) ?? null
            : savedResults[0] ?? null,
        );
      })
      .catch(() => {
        // Saved results are optional; calculation errors remain visible when the user runs it.
      });

    return () => {
      cancelled = true;
    };
  }, [api, selectedAddressKey]);

  const calculate = async (force: boolean) => {
    if (!selectedWallets.length || running) return;
    setRunning(true);
    setError(null);
    setCopyStatus('idle');
    try {
      const response = await api<MinimumCapitalResponse>('/api/copytrade/minimum-capital', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          walletAddresses: selectedWallets.map((wallet) => wallet.walletAddress),
          force,
        }),
      });
      const runId = response.runId;
      if (!runId) {
        const completedResults = resultFor(response);
        setResults(completedResults);
        setDetails(completedResults[0] ?? null);
      } else {
        const total = response.walletTotal ?? selectedWallets.length;
        setProgress({ done: response.walletDone ?? 0, total, current: null });
        for (;;) {
          const state = await api<MinimumCapitalResponse>(
            `/api/copytrade/minimum-capital/status?runId=${runId}`,
          );
          setProgress({
            done: state.walletDone ?? 0,
            total: state.walletTotal ?? total,
            current: state.currentWalletAddress ?? null,
          });
          if (state.status === 'error') throw new Error(state.error ?? 'Calculation failed.');
          if (state.status === 'completed') {
            const completedResults = resultFor(state);
            setResults(completedResults);
            setDetails(completedResults[0] ?? null);
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 400));
        }
      }
    } catch (reason: unknown) {
      setError(
        reason instanceof Error ? reason.message : strings.decisionLab.minimumCapital.requestFailed,
      );
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const copyResults = async () => {
    const copied = await copyJson(results);
    setCopyStatus(copied ? 'copied' : 'failed');
  };

  return (
    <>
      <section className="minimum-capital-calculator" aria-label="Minimum capital calculator">
        <div className="minimum-capital-heading">
          <div>
            <p className="eyebrow">{strings.decisionLab.minimumCapital.eyebrow}</p>
            <strong>{strings.decisionLab.minimumCapital.title}</strong>
            <small>{strings.decisionLab.minimumCapital.description}</small>
          </div>
        </div>
        <div className="minimum-capital-actions">
          <span className="minimum-capital-selected">
            {strings.decisionLab.minimumCapital.selected(selectedWallets.length)}
          </span>
          <button
            type="button"
            className="primary"
            disabled={!selectedWallets.length || running}
            onClick={() => void calculate(false)}
          >
            {running
              ? strings.decisionLab.minimumCapital.calculating(
                  progress?.done ?? 0,
                  progress?.total ?? selectedWallets.length,
                )
              : strings.decisionLab.minimumCapital.calculate}
          </button>
        </div>
        {!selectedWallets.length && (
          <small className="muted">{strings.decisionLab.minimumCapital.chooseWinnerHint}</small>
        )}
        {running && progress && (
          <div className="minimum-capital-progress" role="status" aria-live="polite">
            <progress max={progress.total || 1} value={progress.done} />
            <span>
              {strings.decisionLab.minimumCapital.calculating(progress.done, progress.total)}
              {progress.current
                ? ` · ${progress.current.slice(0, 6)}…${progress.current.slice(-4)}`
                : ''}
            </span>
          </div>
        )}
        {error && <p className="copytrade-status-warning">{error}</p>}
        {results.length > 0 && (
          <div className="minimum-capital-inline-results">
            <strong>{strings.decisionLab.minimumCapital.resultsTitle}</strong>
            <span>
              {results.length} wallet{results.length === 1 ? '' : 's'} calculated
            </span>
            <div className="minimum-capital-results-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setDetails(results[0] ?? null)}
              >
                {strings.decisionLab.minimumCapital.viewResults}
              </button>
              <button type="button" className="secondary" onClick={() => void copyResults()}>
                {copyStatus === 'copied'
                  ? strings.decisionLab.minimumCapital.resultsCopied
                  : strings.decisionLab.minimumCapital.exportResults}
              </button>
            </div>
            {copyStatus === 'failed' && (
              <small className="muted" role="status">
                {strings.decisionLab.minimumCapital.copyResultsFailed}
              </small>
            )}
          </div>
        )}
      </section>
      {details && (
        <Modal
          onClose={() => setDetails(null)}
          ariaLabel={strings.decisionLab.minimumCapital.resultsTitle}
          dialogClassName="minimum-capital-results-modal"
        >
          <div className="copytrade-modal-head">
            <div>
              <p className="eyebrow">{strings.decisionLab.minimumCapital.eyebrow}</p>
              <h3>{strings.decisionLab.minimumCapital.resultsTitle}</h3>
            </div>
            <button type="button" className="secondary" onClick={() => setDetails(null)}>
              {strings.decisionLab.minimumCapital.close}
            </button>
          </div>
          <DataTable
            rows={results}
            getRowKey={(result) => result.walletAddress}
            rowProps={(result) => ({
              className: `minimum-capital-result-row${details.walletAddress === result.walletAddress ? ' selected' : ''}`,
              onClick: () => setDetails(result),
            })}
            tableClassName="minimum-capital-results-table"
            emptyMessage={strings.decisionLab.minimumCapital.noResults}
            columns={[
              {
                key: 'wallet',
                header: strings.decisionLab.minimumCapital.wallet,
                sortValue: (result) => walletLabel(result, wallets),
                render: (result) => (
                  <a
                    className="gmgn-wallet-link"
                    href={gmgnWalletUrl(result.walletAddress)}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(event) => event.stopPropagation()}
                    title="View wallet on GMGN"
                  >
                    {walletLabel(result, wallets)} ↗
                  </a>
                ),
              },
              {
                key: 'status',
                header: strings.decisionLab.minimumCapital.status,
                sortValue: (result) => result.status ?? '',
                render: (result) => statusLabel(result),
              },
              {
                key: 'capital',
                header: strings.decisionLab.minimumCapital.recommendedCapital,
                sortValue: (result) => result.recommendedStartingCapitalUsd,
                render: (result) => usd(result.recommendedStartingCapitalUsd),
              },
              {
                key: 'copyAmount',
                header: strings.decisionLab.minimumCapital.copyAmount,
                sortValue: (result) => result.recommendedCopyAmountUsd,
                render: (result) => usd(result.recommendedCopyAmountUsd),
              },
              {
                key: 'copied',
                header: strings.decisionLab.minimumCapital.copied,
                sortValue: (result) => result.executedTrades,
                render: (result) => `${result.executedTrades} (${pct(result.executedTradeRate)})`,
              },
              {
                key: 'skips',
                header: strings.decisionLab.minimumCapital.skipped,
                sortValue: (result) => result.skippedTrades,
                render: (result) => result.skippedTrades,
              },
              {
                key: 'fees',
                header: strings.decisionLab.minimumCapital.fees,
                sortValue: (result) => result.feesUsd,
                render: (result) => usd(result.feesUsd),
              },
              {
                key: 'ending',
                header: strings.decisionLab.minimumCapital.ending,
                sortValue: (result) => result.endingCapitalUsd,
                render: (result) => usd(result.endingCapitalUsd),
              },
              {
                key: 'return',
                header: strings.decisionLab.minimumCapital.return,
                sortValue: (result) => result.returnPct,
                render: (result) => (
                  <span className={result.returnPct !== null && result.returnPct < 0 ? 'minimum-capital-negative' : undefined}>
                    {pct(result.returnPct)}
                  </span>
                ),
              },
            ]}
          />
          <section className="minimum-capital-detail">
            <h4>
              {strings.decisionLab.minimumCapital.detailsTitle(walletLabel(details, wallets))}
            </h4>
            <div className="minimum-capital-detail-summary">
              <span>
                {strings.decisionLab.minimumCapital.recommendedCapital}{' '}
                <strong>{usd(details.recommendedStartingCapitalUsd)}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.technicalMinimum}{' '}
                <strong>{usd(details.technicallyPossibleMinimumCapitalUsd)}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.copyAmount}{' '}
                <strong>{usd(details.recommendedCopyAmountUsd)}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.copied}{' '}
                <strong>{details.executedTrades}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.skipped}{' '}
                <strong>{details.skippedTrades}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.cashSkips}{' '}
                <strong>{details.insufficientCashSkips}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.deployed}{' '}
                <strong>{usd(details.totalCapitalDeployedUsd)}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.maxOpenCapital}{' '}
                <strong>{usd(details.maxConcurrentCapitalUsd)}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.fees} <strong>{usd(details.feesUsd)}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.netPnl}{' '}
                <strong>{usd(details.netPnlUsd)}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.ending}{' '}
                <strong>{usd(details.endingCapitalUsd)}</strong>
              </span>
              <span>
                {strings.decisionLab.minimumCapital.return}{' '}
                <strong className={details.returnPct !== null && details.returnPct < 0 ? 'minimum-capital-negative' : undefined}>
                  {pct(details.returnPct)}
                </strong>
              </span>
            </div>
            <DataTable
              rows={details.testedConfigurations ?? []}
              getRowKey={(config, index) =>
                `${config.startingCapitalUsd}-${config.copyAmountUsd}-${index}`
              }
              tableClassName="minimum-capital-configurations-table"
              emptyMessage={strings.decisionLab.minimumCapital.noConfigurations}
              columns={[
                {
                  key: 'capital',
                  header: strings.decisionLab.minimumCapital.capital,
                  sortValue: (config) => config.startingCapitalUsd,
                  render: (config) => usd(config.startingCapitalUsd),
                },
                {
                  key: 'amount',
                  header: strings.decisionLab.minimumCapital.buyAmount,
                  sortValue: (config) => config.copyAmountUsd,
                  render: (config) => usd(config.copyAmountUsd),
                },
                {
                  key: 'copied',
                  header: strings.decisionLab.minimumCapital.copied,
                  sortValue: (config) => config.executedTrades,
                  render: (config) =>
                    `${config.executedTrades}/${config.eligibleTrades ?? config.totalTrades ?? config.executedTrades + config.skippedTrades}`,
                },
                {
                  key: 'skips',
                  header: strings.decisionLab.minimumCapital.cashSkips,
                  sortValue: (config) => config.insufficientCashSkips,
                  render: (config) => config.insufficientCashSkips,
                },
                {
                  key: 'fees',
                  header: strings.decisionLab.minimumCapital.fees,
                  sortValue: (config) => config.feesUsd,
                  render: (config) => usd(config.feesUsd),
                },
                {
                  key: 'ending',
                  header: strings.decisionLab.minimumCapital.ending,
                  sortValue: (config) => config.endingCapitalUsd,
                  render: (config) => usd(config.endingCapitalUsd),
                },
                {
                  key: 'return',
                  header: strings.decisionLab.minimumCapital.return,
                  sortValue: (config) => config.returnPct,
                  render: (config) => (
                    <span className={config.returnPct < 0 ? 'minimum-capital-negative' : undefined}>
                      {pct(config.returnPct)}
                    </span>
                  ),
                },
              ]}
            />
          </section>
        </Modal>
      )}
    </>
  );
};
