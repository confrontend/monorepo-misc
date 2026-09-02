import { DataTable } from '../DataTable.js';
import { FormattedDate } from '../FormattedDate.js';
import { StatusPill } from '../StatusPill.js';
import type {
  DatasetReadinessCheck,
  DatasetReadinessResponse,
  DatasetReadinessStatus,
} from './dataWorkflowTypes.js';
export type { DatasetReadinessResponse, DatasetReadinessStatus } from './dataWorkflowTypes.js';

export type DatasetReadinessPanelProps = {
  response: DatasetReadinessResponse | null;
  loading?: boolean;
  error?: string | null;
};

const numberFormatter = new Intl.NumberFormat('en-CA');

const statusTone = (status: DatasetReadinessStatus | DatasetReadinessCheck['status']): string => {
  if (status === 'ready' || status === 'pass') return 'pass';
  if (status === 'blocked' || status === 'not_ready' || status === 'fail') return 'fail';
  if (status === 'ready_with_warnings' || status === 'warning') return 'insufficient_evidence';
  return 'missing';
};

const statusLabel = (status: string): string =>
  status.replaceAll('_', ' ').replace(/\b\w/g, (character) => character.toUpperCase());

export function DatasetReadinessPanel({
  response,
  loading = false,
  error = null,
}: DatasetReadinessPanelProps) {
  return (
    <section className="copytrade-method-card" aria-labelledby="dataset-readiness-title">
      <div className="copytrade-results-meta">
        <div>
          <h3 id="dataset-readiness-title">Dataset readiness</h3>
          <small>
            Readiness is an evidence gate. Current metadata is reported separately from historical
            point-in-time evidence.
          </small>
        </div>
        {response && (
          <small>
            {response.chain.toUpperCase()} · {response.targetDays}d · generated{' '}
            <FormattedDate value={response.generatedAt} />
          </small>
        )}
      </div>

      {loading && !response ? (
        <p className="muted" role="status">
          <span className="loading-spinner" aria-hidden="true" /> Assessing dataset readiness…
        </p>
      ) : error ? (
        <p className="error-message" role="alert">
          {error}
        </p>
      ) : !response ? (
        <p className="muted">Readiness output is not available yet.</p>
      ) : (
        <>
          <div className="copytrade-results-meta">
            <StatusPill status={statusTone(response.status)}>
              {statusLabel(response.status)}
            </StatusPill>
            <small>
              Completeness threshold: {response.completenessThresholdPercent}% · window:{' '}
              <FormattedDate value={response.output.analysisWindowStart} /> →{' '}
              <FormattedDate value={response.output.analysisWindowEnd} />
            </small>
          </div>

          <div className="copytrade-update-summary-grid" aria-label="Dataset readiness output">
            <div>
              <b>{numberFormatter.format(response.output.eligibleWallets)}</b>
              <span>Eligible wallets</span>
              <small>of {numberFormatter.format(response.output.totalWallets)} total</small>
            </div>
            <div>
              <b>{numberFormatter.format(response.output.completeWallets)}</b>
              <span>Complete history</span>
              <small>{numberFormatter.format(response.output.incompleteWallets)} incomplete</small>
            </div>
            <div>
              <b>{numberFormatter.format(response.output.historicalEvidenceWallets)}</b>
              <span>Historical evidence</span>
              <small>Point-in-time valid</small>
            </div>
            <div>
              <b>{numberFormatter.format(response.output.outcomeCoveredWallets)}</b>
              <span>Outcome covered</span>
              <small>
                {numberFormatter.format(response.output.currentMetadataWallets)} current metadata
                only
              </small>
            </div>
          </div>

          {response.blockers.length > 0 && (
            <div className="copytrade-update-changes" role="alert">
              <strong>Blocked because:</strong>
              {response.blockers.map((blocker) => (
                <span key={blocker}>{blocker}</span>
              ))}
            </div>
          )}
          {response.warnings.length > 0 && (
            <div className="copytrade-update-changes" role="note">
              <strong>Warnings:</strong>
              {response.warnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </div>
          )}

          <DataTable<DatasetReadinessCheck>
            rows={response.checks}
            getRowKey={(row) => row.key}
            wrapClassName="copytrade-table-wrap"
            tableClassName="copytrade-table"
            emptyMessage="No readiness checks were returned."
            columns={[
              {
                key: 'check',
                header: 'Readiness check',
                sortValue: (row) => row.label,
                render: (row) => (
                  <div>
                    <strong>{row.label}</strong>
                    <small>{row.required ? 'Required' : 'Advisory'}</small>
                  </div>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                sortValue: (row) => row.status,
                render: (row) => (
                  <div>
                    <StatusPill status={statusTone(row.status)}>
                      {statusLabel(row.status)}
                    </StatusPill>
                    {row.value !== null && <small>Value: {String(row.value)}</small>}
                  </div>
                ),
              },
              {
                key: 'detail',
                header: 'Detail',
                render: (row) => (
                  <div>
                    <span>{row.detail}</span>
                    {row.disabledReason && <small>Disabled: {row.disabledReason}</small>}
                  </div>
                ),
              },
            ]}
          />
        </>
      )}
    </section>
  );
}
