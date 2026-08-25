import { DataTable } from './DataTable.js';
import { UI_STRINGS } from '../strings.js';

type PatternDiscoveryReportSummary = {
  status_counts: Record<string, number>;
  split: {
    discovery_rows?: number;
    validation_rows?: number;
    untouched_holdout_rows?: number;
  };
};

type PatternDiscoverySensitivityPoint = {
  minimumCoveragePercent: number;
  wallets: number;
  rows: number;
  independentEntries: number;
  validationSurvivors: number;
  discoveredCandidates: number;
  promotedPatterns: number;
  historicalStablePatterns: number;
  reportAvailable: boolean;
  error?: string;
};

type PatternDiscoverySensitivitySummary = {
  thresholds: PatternDiscoverySensitivityPoint[];
  note: string;
};

export const PatternDiscoveryRunSummary = ({
  report,
  sensitivity,
}: {
  report: PatternDiscoveryReportSummary | null;
  sensitivity: PatternDiscoverySensitivitySummary | null;
}) => {
  const copy = UI_STRINGS.patternDiscovery;
  const availableLevels = sensitivity?.thresholds.filter((row) => row.reportAvailable) ?? [];
  const eligibleLevels = availableLevels.filter((row) => row.promotedPatterns > 0);
  const highestEligibleLevel = eligibleLevels.length
    ? Math.max(...eligibleLevels.map((row) => row.minimumCoveragePercent))
    : null;
  const unavailableLevels = (sensitivity?.thresholds.length ?? 0) - availableLevels.length;
  const strictSurvivors = report?.status_counts['validation survivor'] ?? 0;

  return (
    <>
      {sensitivity && (
        <>
          <div className="pattern-discovery-headline">
            <div>
              <span className="eyebrow">{copy.gridEyebrow}</span>
              <h3>{copy.gridTitle}</h3>
            </div>
            <span className="pattern-discovery-status">
              {copy.gridStatus(eligibleLevels.length, availableLevels.length)}
            </span>
          </div>
          <div className="pattern-discovery-cards">
            <div>
              <strong>{availableLevels.length}</strong>
              <span>{copy.completedLevels}</span>
            </div>
            <div>
              <strong>{eligibleLevels.length}</strong>
              <span>{copy.eligibleLevels}</span>
            </div>
            <div>
              <strong>{highestEligibleLevel === null ? '—' : `${highestEligibleLevel}%`}</strong>
              <span>{copy.highestEligibleLevel}</span>
            </div>
            <div>
              <strong>{unavailableLevels}</strong>
              <span>{copy.unavailableLevels}</span>
            </div>
          </div>
          <p className="pattern-discovery-explainer">
            <strong>{copy.gridExplanation}</strong>
          </p>
          <div className="pattern-discovery-sensitivity">
            <div className="pattern-discovery-results-heading">
              <div>
                <h4>{copy.sensitivityTitle}</h4>
                <p className="muted">{copy.sensitivityExplanation}</p>
              </div>
              <span>{copy.sensitivityRange}</span>
            </div>
            <DataTable
              enableColumnHiding
              columnVisibilityStorageKey="vantage-pattern-discovery-sensitivity-columns"
              wrapClassName="table-wrap copytrade-table-wrap"
              tableClassName="copytrade-table pattern-sensitivity-table"
              rows={sensitivity.thresholds}
              getRowKey={(row) => String(row.minimumCoveragePercent)}
              columns={[
                {
                  key: 'threshold',
                  header: 'Minimum coverage',
                  render: (row) => `${row.minimumCoveragePercent}%`,
                },
                {
                  key: 'wallets',
                  header: 'Wallets',
                  render: (row) => (row.reportAvailable ? row.wallets.toLocaleString() : '—'),
                },
                {
                  key: 'entries',
                  header: 'Independent entries',
                  render: (row) =>
                    row.reportAvailable ? row.independentEntries.toLocaleString() : '—',
                },
                {
                  key: 'rows',
                  header: 'Rows',
                  render: (row) => (row.reportAvailable ? row.rows.toLocaleString() : '—'),
                },
                {
                  key: 'survivors',
                  header: 'Validation survivors',
                  render: (row) =>
                    row.reportAvailable ? row.validationSurvivors.toLocaleString() : '—',
                },
                {
                  key: 'candidates',
                  header: 'Candidate patterns',
                  render: (row) =>
                    row.reportAvailable ? row.discoveredCandidates.toLocaleString() : '—',
                },
                {
                  key: 'stable',
                  header: copy.stableEligibleHeader,
                  render: (row) =>
                    row.reportAvailable
                      ? `${row.historicalStablePatterns.toLocaleString()} / ${row.promotedPatterns.toLocaleString()}`
                      : '—',
                },
                {
                  key: 'status',
                  header: 'Status',
                  render: (row) => (row.reportAvailable ? 'Available' : (row.error ?? 'No report')),
                },
              ]}
            />
            <p className="muted">{sensitivity.note}</p>
          </div>
        </>
      )}

      {report && (
        <>
          <div className="pattern-discovery-headline">
            <div>
              <span className="eyebrow">{copy.strictEyebrow}</span>
              <h3>{copy.strictTitle}</h3>
            </div>
            <span className="pattern-discovery-status">
              {strictSurvivors > 0
                ? copy.strictStatusWithEvidence
                : copy.strictStatusWithoutEvidence}
            </span>
          </div>
          <div className="pattern-discovery-cards">
            <div>
              <strong>{strictSurvivors}</strong>
              <span>{copy.strictSurvivors}</span>
            </div>
            <div>
              <strong>{report.split.discovery_rows ?? 0}</strong>
              <span>older trades used to discover rules</span>
            </div>
            <div>
              <strong>{report.split.validation_rows ?? 0}</strong>
              <span>newer trades used to check them</span>
            </div>
            <div>
              <strong>{report.split.untouched_holdout_rows ?? 0}</strong>
              <span>trades kept untouched</span>
            </div>
          </div>
          <p className="pattern-discovery-explainer">{copy.strictExplanation}</p>
        </>
      )}
    </>
  );
};
