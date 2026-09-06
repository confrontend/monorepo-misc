import type { Dispatch, SetStateAction } from 'react';
import { formatTime, type ApiClient } from '../httpClient.js';
import { DataTable } from './DataTable.js';
import { Collapsible } from './Collapsible.js';
import { PanelHeading } from './PanelHeading.js';
import {
  PatternDiscoveryRuleDialog,
  type PatternDiscoveryRule,
} from './PatternDiscoveryRuleDialog.js';
import { PatternDiscoveryPromotedPatterns } from './PatternDiscoveryPromotedPatterns.js';
import { PatternDiscoveryProgressPanel } from './PatternDiscoveryProgressPanel.js';
import { PatternDiscoveryRunSummary } from './PatternDiscoveryRunSummary.js';
import { UI_STRINGS } from '../strings.js';
import type {
  PatternDiscoveryExport,
  PatternDiscoveryReport,
  PatternDiscoveryExecution,
  PatternDiscoverySensitivity,
  PatternDiscoveryProgress,
  PatternDiscoveryRunResponse,
} from '../types.js';

const COVERAGE_GRID = [50, 60, 70, 80, 90, 95, 100] as const;
const PERIODS = [30, 60, 90] as const;
const shortAddress = (address: string) => `${address.slice(0, 6)}...`;
const copyAddress = (address: string) => navigator.clipboard?.writeText(address);

export type PatternDiscoverySectionProps = {
  api: ApiClient;
  periodDays: number;
  onPeriodDaysChange: (days: number) => void;
  onGoToData: () => void;
  patternHistoryAvailable: boolean;
  onAvailabilityChange: (available: boolean) => void;
  patternDiscoveryIsActive: boolean;
  patternDiscoveryExport: PatternDiscoveryExport | null;
  patternDiscoveryProgress: PatternDiscoveryProgress | null;
  patternDiscoveryLoadingDetail: string;
  patternDiscoveryReport: PatternDiscoveryReport | null;
  patternDiscoverySensitivity: PatternDiscoverySensitivity | null;
  patternDiscoveryFreshness: PatternDiscoveryRunResponse['freshness'];
  patternDiscoveryExecution: PatternDiscoveryExecution | null;
  patternDiscoveryRunLoading: boolean;
  patternDiscoveryElapsedSeconds: number;
  patternDiscoveryRunError: string | null;
  patternDiscoverySourceOpen: boolean;
  onSourceOpenChange: (open: boolean) => void;
  selectedPatternRule: PatternDiscoveryRule | null;
  onSelectedPatternRuleChange: (rule: PatternDiscoveryRule | null) => void;
  onExport: () => void;
  onRun: () => void;
  onStop: () => void;
};

export function PatternDiscoverySection({
  api,
  periodDays,
  onPeriodDaysChange,
  onGoToData,
  patternHistoryAvailable,
  onAvailabilityChange,
  patternDiscoveryIsActive,
  patternDiscoveryExport,
  patternDiscoveryProgress,
  patternDiscoveryLoadingDetail,
  patternDiscoveryReport,
  patternDiscoverySensitivity,
  patternDiscoveryFreshness,
  patternDiscoveryExecution,
  patternDiscoveryElapsedSeconds,
  patternDiscoveryRunError,
  patternDiscoverySourceOpen,
  onSourceOpenChange,
  selectedPatternRule,
  onSelectedPatternRuleChange,
  onExport,
  onRun,
  onStop,
}: PatternDiscoverySectionProps) {
  return (
    <section
      id="copytrade-pattern-discovery"
      className="menu-section panel copytrade-research-route pattern-discovery-panel"
    >
      <PanelHeading
        eyebrow="GMGN COPYTRADE · SHARED ENGINE EXPORT"
        title="Pattern Discovery"
        tag="POINT-IN-TIME FEATURES"
      />
      <div className="copytrade-coverage-controls">
        <label>
          Selected period (days)
          <select
            value={periodDays}
            onChange={(event) => onPeriodDaysChange(Number(event.target.value))}
          >
            {PERIODS.map((period) => (
              <option key={period} value={period}>
                {period} days
              </option>
            ))}
          </select>
        </label>
        <span className="pattern-discovery-threshold-summary">
          <strong>Coverage levels</strong>
          <small>{COVERAGE_GRID.map((value) => `${value}%`).join(' · ')}</small>
        </span>
        <button
          type="button"
          className="secondary"
          disabled={
            patternDiscoveryIsActive ||
            (!patternDiscoveryExport && !patternDiscoveryReport && !patternDiscoverySensitivity)
          }
          onClick={onExport}
        >
          {UI_STRINGS.patternDiscovery.exportPageData}
        </button>
        {patternDiscoveryIsActive ? (
          <button type="button" className="secondary pattern-discovery-stop" onClick={onStop}>
            Stop discovery
          </button>
        ) : (
          <button
            type="button"
            className="primary"
            onClick={onRun}
            disabled={!patternHistoryAvailable}
            title={
              patternHistoryAvailable
                ? undefined
                : UI_STRINGS.patternDiscovery.historyUnavailable(periodDays)
            }
          >
            Run discovery
          </button>
        )}
      </div>
      <Collapsible className="pattern-discovery-advanced" summary="Advanced">
        <p className="muted">
          One run evaluates the full 50–100% coverage grid using the same point-in-time features,
          wallet-balanced validation, and leakage protections.
        </p>
        <p className="muted">
          Only the event-time <code>features</code> object is eligible. Return, hold duration,
          delay, fee, outcome, and post-event matching fields are rejected as leakage.
        </p>
      </Collapsible>
      {patternDiscoveryIsActive && (
        <PatternDiscoveryProgressPanel
          progress={patternDiscoveryProgress}
          elapsedSeconds={patternDiscoveryElapsedSeconds}
          fallbackMessage={patternDiscoveryLoadingDetail}
          periodDays={periodDays}
        />
      )}
      {patternDiscoveryExport && !patternDiscoveryIsActive && (
        <>
          <div className="copytrade-table-overview">
            <span>
              <strong>{patternDiscoveryExport.metadata.selected_wallet_count}</strong> wallets in
              the 100% coverage level
            </span>
            <span>
              <strong>{patternDiscoveryExport.metadata.exported_rows}</strong> normalized events
            </span>
            <span>
              <strong>
                {patternDiscoveryExport.metadata.eligible_wallets_before_threshold -
                  patternDiscoveryExport.metadata.selected_wallet_count}
              </strong>{' '}
              below the 100% coverage level
            </span>
          </div>
          <Collapsible
            className="copytrade-info-panel pattern-discovery-source-data"
            open={patternDiscoverySourceOpen}
            onToggle={onSourceOpenChange}
            summary={`100% coverage-level source data · ${patternDiscoveryExport.metadata.exported_rows} events`}
          >
            <DataTable
              enableColumnHiding
              columnVisibilityStorageKey="vantage-pattern-discovery-source-columns"
              wrapClassName="table-wrap copytrade-table-wrap"
              tableClassName="copytrade-table fully-covered-table"
              rows={patternDiscoveryExport.rows.slice(0, 100)}
              getRowKey={(row) => row.event_id}
              emptyMessage="No wallets currently meet the selected outcome-coverage threshold for this period."
              columns={[
                {
                  key: 'wallet',
                  header: 'Wallet',
                  render: (row) => (
                    <>
                      <a
                        className="copytrade-gmgn-link"
                        href={`https://gmgn.ai/sol/address/${row.wallet_address}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddress(row.wallet_address)} ↗
                      </a>
                      <button
                        type="button"
                        className="copy-address-button"
                        onClick={() => void copyAddress(row.wallet_address)}
                        aria-label="Copy wallet address"
                      >
                        ⧉
                      </button>
                    </>
                  ),
                },
                {
                  key: 'eventTime',
                  header: 'Event time',
                  render: (row) => formatTime(row.event_time),
                },
                {
                  key: 'token',
                  header: 'Token',
                  cellProps: (row) => ({ title: row.token_address }),
                  render: (row) => row.entity_id,
                },
                {
                  key: 'copyOutcome',
                  header: 'Copy outcome',
                  cellProps: (row) => ({
                    className: row.net_return_after_costs >= 0 ? 'positive' : 'negative',
                  }),
                  render: (row) => `${row.net_return_after_costs.toFixed(2)}%`,
                },
                {
                  key: 'coverage',
                  header: 'Coverage',
                  render: (row) => `${row.coverage_rate_percent}%`,
                },
              ]}
            />
            <p className="muted">{patternDiscoveryExport.metadata.coverage_semantics}</p>
          </Collapsible>
          <Collapsible className="copytrade-info-panel" summary="Configured shared-engine fallback">
            <p>
              The browser view only exports JSON. From the Vantage workspace, run the JSON-only
              adapter and then the isolated Python report command:
            </p>
            <pre className="pattern-discovery-command">
              python -m shared_pattern_discovery.exporters.gmgn --project crypto --input
              &lt;downloaded-export.json&gt; --output runs/crypto/gmgn-pattern-discovery.json{`\n`}
              python -m shared_pattern_discovery.cli --project crypto --input
              runs/crypto/gmgn-pattern-discovery.json --output
              runs/crypto/pattern-discovery-report.json --min-n 10
            </pre>
            <p className="muted">
              The shared engine reads this normalized JSON only; it never opens the crypto SQLite
              database.
            </p>
          </Collapsible>
        </>
      )}
      {!patternDiscoveryIsActive && patternDiscoveryExport?.metadata.exported_rows === 0 && (
        <p className="muted">No wallets meet the 100% coverage level for this period.</p>
      )}
      {patternDiscoveryExport &&
        !patternDiscoveryReport &&
        !patternDiscoveryIsActive &&
        !patternDiscoveryRunError && (
          <p className="muted">
            Normalized export loaded. The shared Python engine has not run yet; click “Run shared
            discovery” to generate the report.
          </p>
        )}
      {patternDiscoveryRunError && <p className="error-text">{patternDiscoveryRunError}</p>}
      {(patternDiscoveryReport || patternDiscoverySensitivity) && !patternDiscoveryIsActive && (
        <div className="copytrade-info-panel pattern-discovery-readable">
          {patternDiscoveryFreshness?.state === 'stale' ? (
            <div className="copytrade-outcome-coverage-warning" role="status">
              <strong>
                {UI_STRINGS.patternDiscovery.staleResult(
                  patternDiscoveryFreshness.cachedAt
                    ? new Date(patternDiscoveryFreshness.cachedAt).toLocaleString()
                    : 'an earlier run',
                )}
              </strong>{' '}
              {UI_STRINGS.patternDiscovery.staleResultSafety}
            </div>
          ) : (
            <p className="muted">{UI_STRINGS.patternDiscovery.currentResult}</p>
          )}
          <PatternDiscoveryRunSummary
            report={patternDiscoveryReport}
            sensitivity={patternDiscoverySensitivity}
          />
          {patternDiscoveryReport && (
            <>
              <div className="pattern-discovery-flow">
                <div>
                  <b>1</b>
                  <span>Look at older trades</span>
                </div>
                <i>→</i>
                <div>
                  <b>2</b>
                  <span>Find a simple relationship</span>
                </div>
                <i>→</i>
                <div>
                  <b>3</b>
                  <span>Check it on newer trades</span>
                </div>
              </div>
              <p className="pattern-discovery-explainer">
                <strong>Read this as:</strong> a behavior that appeared often enough in the selected
                data to test again.
              </p>
              {(() => {
                const insufficientCount = patternDiscoveryReport.patterns.filter(
                  (pattern) => pattern.validationStatus === 'insufficient data',
                ).length;
                return insufficientCount > 0 ? (
                  <p className="copytrade-outcome-coverage-warning">
                    <strong>{insufficientCount} candidate rules were not shown:</strong> the
                    validation sample was below the configured minimum-N. The full per-rule reasons
                    remain in the exported report.
                  </p>
                ) : null;
              })()}
              {patternDiscoverySensitivity && (
                <PatternDiscoveryPromotedPatterns
                  sensitivity={patternDiscoverySensitivity}
                  onSelectPattern={onSelectedPatternRuleChange}
                />
              )}
              {selectedPatternRule && (
                <PatternDiscoveryRuleDialog
                  rule={selectedPatternRule}
                  onClose={() => onSelectedPatternRuleChange(null)}
                />
              )}
              <Collapsible className="pattern-discovery-details" summary="Technical details">
                <p>
                  Features come from wallet and token history available before each event. The final
                  holdout is reserved for a later check.
                </p>
                {patternDiscoveryExecution && (
                  <p className="muted">Report file: {patternDiscoveryExecution.outputPath}</p>
                )}
              </Collapsible>
            </>
          )}
        </div>
      )}
    </section>
  );
}
