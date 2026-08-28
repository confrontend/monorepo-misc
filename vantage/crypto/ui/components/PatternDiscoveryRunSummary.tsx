import { useState } from 'react';
import { UI_STRINGS } from '../strings.js';

type PatternDiscoveryReportSummary = {
  status_counts: Record<string, number>;
  split: { discovery_rows?: number; validation_rows?: number; untouched_holdout_rows?: number };
};
type PatternDiscoverySensitivityPoint = {
  minimumCoveragePercent: number;
  wallets: number;
  rows: number;
  promotedPatterns: number;
  historicalStablePatterns: number;
  reportAvailable: boolean;
  error?: string;
};
type PatternDiscoverySensitivitySummary = {
  thresholds: PatternDiscoverySensitivityPoint[];
  note: string;
  crossCoveragePromotedPatterns?: unknown[];
};

export const PatternDiscoveryRunSummary = ({
  report,
  sensitivity,
}: {
  report: PatternDiscoveryReportSummary | null;
  sensitivity: PatternDiscoverySensitivitySummary | null;
}) => {
  const copy = UI_STRINGS.patternDiscovery;
  const [selectedCoverage, setSelectedCoverage] = useState<number | null>(null);
  const available = sensitivity?.thresholds.filter((row) => row.reportAvailable) ?? [];
  const stable = available.filter((row) => row.historicalStablePatterns > 0);
  const selected = sensitivity?.thresholds.find(
    (row) => row.minimumCoveragePercent === selectedCoverage,
  );
  const strictSurvivors = report?.status_counts['validation survivor'] ?? 0;
  const highestUseful = stable.length
    ? Math.max(...stable.map((row) => row.minimumCoveragePercent))
    : null;
  const promotedCount = sensitivity?.crossCoveragePromotedPatterns?.length ?? 0;

  return (
    <>
      {sensitivity && (
        <>
          <div className="pattern-discovery-summary-heading">
            <div>
              <span className="eyebrow">{copy.summaryEyebrow}</span>
              <h3>{copy.summaryTitle}</h3>
            </div>
            <span className="pattern-discovery-status">
              {copy.gridStatus(stable.length, available.length)}
            </span>
          </div>
          <div className="pattern-discovery-cards">
            <div>
              <strong>{promotedCount}</strong>
              <span>{copy.promotedPatterns}</span>
            </div>
            <div>
              <strong>
                {stable.length}/{available.length}
              </strong>
              <span>{copy.stableCoverageLevels}</span>
            </div>
            <div>
              <strong>{highestUseful === null ? '—' : `${highestUseful}%`}</strong>
              <span>{copy.highestUsefulCoverage}</span>
            </div>
            <div>
              <strong>
                {sensitivity.thresholds.find((row) => row.minimumCoveragePercent === 100)
                  ?.historicalStablePatterns ?? 0}
              </strong>
              <span>{copy.stableAtFullCoverage}</span>
            </div>
          </div>
          <p className="pattern-discovery-signal-line">
            <strong>{copy.strongestSignal}</strong> {copy.strongestSignalText}
          </p>
          <div className="pattern-discovery-sensitivity">
            <div className="pattern-discovery-results-heading">
              <div>
                <h4>{copy.coverageSensitivityTitle}</h4>
                <p className="muted">{copy.coverageSensitivityHint}</p>
              </div>
            </div>
            <div className="pattern-discovery-coverage-chart" role="list">
              {sensitivity.thresholds.map((row) => (
                <button
                  type="button"
                  role="listitem"
                  key={row.minimumCoveragePercent}
                  className={`pattern-discovery-coverage-row${selectedCoverage === row.minimumCoveragePercent ? ' selected' : ''}`}
                  onClick={() => setSelectedCoverage(row.minimumCoveragePercent)}
                >
                  <strong>{row.minimumCoveragePercent}%</strong>
                  <span>{row.reportAvailable ? row.wallets.toLocaleString() : '—'} wallets</span>
                  <span className="pattern-discovery-coverage-bar" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, row.promotedPatterns * 4)}%` }} />
                  </span>
                  <b>{row.reportAvailable ? row.promotedPatterns : '—'}</b>
                  <span>{copy.promoted}</span>
                </button>
              ))}
            </div>
            {selected && (
              <div className="pattern-discovery-coverage-detail">
                <strong>{selected.minimumCoveragePercent}% coverage</strong>
                <span>
                  {selected.reportAvailable
                    ? copy.coverageDetailEvents(
                        selected.wallets.toLocaleString(),
                        selected.rows.toLocaleString(),
                        selected.historicalStablePatterns,
                      )
                    : (selected.error ?? 'No report available for this level.')}
                </span>
                {selected.minimumCoveragePercent === 100 && (
                  <small>{copy.strictCoverageNote}</small>
                )}
              </div>
            )}
            <p className="muted">{sensitivity.note}</p>
          </div>
        </>
      )}
      {report && (
        <details className="pattern-discovery-secondary-details">
          <summary>{copy.methodologyDiagnostics}</summary>
          <div className="pattern-discovery-cards">
            <div>
              <strong>{strictSurvivors}</strong>
              <span>{copy.validationSurvivorsAtFullCoverage}</span>
            </div>
            <div>
              <strong>{report.split.discovery_rows ?? 0}</strong>
              <span>{copy.discoveryRows}</span>
            </div>
            <div>
              <strong>{report.split.validation_rows ?? 0}</strong>
              <span>{copy.validationRows}</span>
            </div>
            <div>
              <strong>{report.split.untouched_holdout_rows ?? 0}</strong>
              <span>{copy.holdoutRows}</span>
            </div>
          </div>
          <p className="pattern-discovery-explainer">{copy.strictExplanation}</p>
        </details>
      )}
    </>
  );
};
