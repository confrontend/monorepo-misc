import { useMemo, useState } from 'react';
import type { DataConsolidationJob, DataFileReport, DataStatus, ImportSummary } from '../../../api';
import { LoadingState } from '../../../shared/components/LoadingState';
import { LegendPanel } from '../../../shared/components/LegendPanel';

const KIND_LABELS: Record<DataFileReport['kind'], string> = {
  capture: 'Daily rating snapshot',
  api_prices: 'Prices (API)',
  api_changes: 'Rating changes (API)',
  bundle: 'Bundled capture',
  benchmark: 'Benchmark prices',
  unknown: 'Not recognised',
};

const STATUS_CLASS: Record<DataFileReport['status'], string> = {
  new: 'verdict-good',
  changed: 'verdict-mixed',
  imported: 'verdict-not-enough-data',
  failed: 'verdict-poor',
};

const STATUS_LABEL: Record<DataFileReport['status'], string> = {
  new: 'New',
  changed: 'Changed',
  imported: 'Imported',
  failed: 'Failed',
};

const bytesLabel = (bytes: number) => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

const countLabel = (value: number | null | undefined) =>
  (value === null || value === undefined ? '—' : value.toLocaleString());

export function DataView({ status, importing, consolidationJob, lastSummary, onImport, onConsolidate, error }: {
  status: DataStatus | null;
  importing: boolean;
  consolidationJob: DataConsolidationJob | null;
  lastSummary: ImportSummary | null;
  onImport: () => void;
  onConsolidate: () => void;
  error: string | null;
}) {
  const [filter, setFilter] = useState<'pending' | 'all' | 'failed'>('pending');

  const files = useMemo(() => {
    const all = status?.files ?? [];
    const rows = filter === 'all' ? all
      : filter === 'failed' ? all.filter((file) => file.status === 'failed')
        : all.filter((file) => file.status === 'new' || file.status === 'changed' || file.status === 'failed');
    // Anything needing attention first; the long tail of already-imported files after it.
    const weight = (file: DataFileReport) =>
      (file.status === 'failed' ? 0 : file.status === 'new' ? 1 : file.status === 'changed' ? 2 : 3);
    return [...rows].sort((left, right) => weight(left) - weight(right) || left.relPath.localeCompare(right.relPath));
  }, [status, filter]);

  if (!status) return null;
  const pending = status.pending;
  const failed = status.files.filter((file) => file.status === 'failed').length;
  const rawFiles = status.files.filter((file) => /^3-year\/raw_.*\.json$/i.test(file.relPath));
  const standaloneTickerFiles = status.files.filter((file) =>
    (/^[^/]+\.json$/i.test(file.relPath) && file.kind === 'capture')
    || (/^3-year\/[^/]+\.json$/i.test(file.relPath) && (file.kind === 'api_prices' || file.kind === 'api_changes')));
  const replaceableSources = rawFiles.length + standaloneTickerFiles.length;
  const consolidating = consolidationJob?.status === 'running';

  return (
    <>
      <LegendPanel
        title="How to read the data table"
        items={[
          { term: 'New', meaning: 'The file is present but has not been imported yet.' },
          { term: 'Changed', meaning: 'The file changed since its last import.' },
          { term: 'Imported', meaning: 'The database already contains this file.' },
          { term: 'Failed', meaning: 'The file could not be read; the reason is shown in the row.' },
          { term: 'Consolidate', meaning: 'Merge raw bundles and individual ticker files, keep a verified local ZIP of the originals, retain one consolidated file, and import it automatically. Benchmark files are never touched.' },
        ]}
      />
      <section className="conclusion-box data-summary-box" aria-labelledby="data-title">
        <div className="eyebrow">Input folder</div>
        <h3 id="data-title">
          {pending === 0
            ? 'Everything in the folder is in the database'
            : `${pending} file${pending === 1 ? '' : 's'} waiting to be imported`}
        </h3>
        <p>
          Drop <code>.json</code> files anywhere under <code>input/</code> — subfolders are fine. Files are
          identified by what is inside them, not by their names, so nothing has to be renamed or sorted.
        </p>
        <div className="conclusion-stats">
          <div><span>Files tracked</span><strong>{countLabel(status.files.length)}</strong></div>
          <div><span>Tickers</span><strong>{countLabel(status.counts.tickers)}</strong></div>
          <div><span>Price rows</span><strong>{countLabel(status.counts.priceRows)}</strong></div>
          <div><span>Rating events</span><strong>{countLabel(status.counts.ratingRows)}</strong></div>
          <div><span>Daily snapshots</span><strong>{countLabel(status.counts.quantRows)}</strong></div>
          <div><span>Benchmark rows</span><strong>{countLabel(status.counts.benchmarkRows)}</strong></div>
          <div><span>Covering</span><strong className="data-range">{status.counts.priceStart ?? '—'} → {status.counts.priceEnd ?? '—'}</strong></div>
          <div><span>Data version</span><strong>{status.dataVersion}</strong></div>
        </div>
        {status.recentProcessedSymbols.length > 0 && (
          <section className="recent-symbols" aria-labelledby="recent-symbols-title">
            <div>
              <span className="eyebrow" id="recent-symbols-title">Latest processed symbols</span>
              <p>Newest first. Use these four symbols as a checkpoint when continuing the upstream fetch.</p>
            </div>
            <ol>
              {status.recentProcessedSymbols.map((item) => (
                <li key={item.slug}>
                  <strong>{item.symbol}</strong>
                  <span>{item.fundType?.toUpperCase() === 'ETF' ? 'ETF' : item.fundType ?? 'Stock / unknown'}</span>
                  <time dateTime={item.processedAt}>{new Date(item.processedAt).toLocaleString()}</time>
                </li>
              ))}
            </ol>
          </section>
        )}
        <div className="data-actions">
          <button className="primary-button" type="button" onClick={onConsolidate} disabled={importing || consolidating || replaceableSources === 0}>
            {consolidating ? 'Consolidating…' : replaceableSources === 0 ? 'Nothing to consolidate' : `Consolidate, archive & import ${replaceableSources} ticker source${replaceableSources === 1 ? '' : 's'}`}
          </button>
          <button className="reset-button" type="button" onClick={onImport} disabled={importing || consolidating || pending === 0}>
            {importing ? 'Importing…' : pending === 0 ? 'Everything is up to date' : `Import ${pending} file${pending === 1 ? '' : 's'}`}
          </button>
          {importing && (
            <LoadingState
              compact
              label="Importing files"
              detail="Parsing and writing data. Large bundles can take a couple of minutes."
            />
          )}
          {!importing && lastSummary && (
            <span className="muted">
              Last import: {lastSummary.filesImported} imported, {lastSummary.filesFailed} failed,
              {' '}{lastSummary.filesUnchanged} unchanged in {(lastSummary.elapsedMs / 1000).toFixed(1)}s
            </span>
          )}
        </div>
        {consolidationJob && (
          <div className={`data-consolidation-job ${consolidationJob.status}`} role="status" aria-live="polite">
            <div className="data-consolidation-job-copy">
              <strong>{consolidationJob.status === 'running' ? `Working: ${consolidationJob.stage}` : consolidationJob.status === 'completed' ? 'Consolidation completed' : 'Consolidation stopped'}</strong>
              <span>{consolidationJob.message}</span>
            </div>
            <div className="data-consolidation-progress" aria-label={`${consolidationJob.progress}% complete`}>
              <i style={{ width: `${consolidationJob.progress}%` }} />
            </div>
            <span className="data-consolidation-percent">{consolidationJob.progress}%</span>
            {consolidationJob.status === 'completed' && consolidationJob.summary && (
              <div className="data-consolidation-result">
                <span><strong>{countLabel(consolidationJob.summary.uniqueTickers)}</strong> symbols</span>
                <span><strong>{countLabel(consolidationJob.summary.etfTickers)}</strong> ETFs</span>
                <span><strong>{countLabel(consolidationJob.summary.mergedDataRows)}</strong> unique rows</span>
                <span><strong>{consolidationJob.summary.rawFilesArchived.length}</strong> sources archived</span>
                <span><strong>{consolidationJob.summary.removedSourceFiles.length}</strong> old files removed</span>
                <span><strong>{bytesLabel(consolidationJob.summary.outputBytes)}</strong> consolidated</span>
                {consolidationJob.summary.payloadsWithNoUsableUpstreamData.length > 0 && <span className="negative"><strong>{consolidationJob.summary.payloadsWithNoUsableUpstreamData.length}</strong> unusable upstream payloads</span>}
              </div>
            )}
          </div>
        )}
      </section>

      {error && <div className="data-status data-error">Data operation failed: {error}</div>}

      {failed > 0 && (
        <div className="trust-warning">
          {failed} file{failed === 1 ? '' : 's'} could not be read. They are listed below with the reason —
          nothing is skipped silently, and the rest of the import still completed.
        </div>
      )}

      {status.missing.length > 0 && (
        <div className="trust-warning">
          {status.missing.length} file{status.missing.length === 1 ? ' is' : 's are'} in the database but no longer
          in the folder. Their rows are kept — data is never deleted because a file moved. First few:{' '}
          {status.missing.slice(0, 3).join(', ')}{status.missing.length > 3 ? ' …' : ''}
        </div>
      )}

      <section className="table-panel" aria-labelledby="data-files-title">
        <div className="table-heading">
          <div>
            <h2 id="data-files-title">Files</h2>
            <p>What each file contributed, and whether the database is current with it</p>
          </div>
          <span className="data-badge">{files.length} shown of {status.files.length}</span>
        </div>
        <section className="toolbar" aria-label="File list controls">
          <div className="field">
            <label htmlFor="data-filter">Show</label>
            <select id="data-filter" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
              <option value="pending">Needs attention</option>
              <option value="all">All files</option>
              <option value="failed">Failed only</option>
            </select>
          </div>
          <span className="toolbar-count">{status.files.length - pending - failed} already imported and unchanged</span>
        </section>
        <div className="table-scroll">
          <table className="aggregate-table data-table">
            <thead>
              <tr>
                <th title="The input file that supplied the data.">File</th><th title="The kind of data found inside the file.">Contains</th>
                <th className="number" title="Number of historical price rows in the file.">Prices</th><th className="number" title="Number of rating-change rows in the file.">Ratings</th>
                <th className="number" title="Number of daily rating snapshots in the file.">Snapshots</th><th className="number" title="Number of benchmark price rows, usually S&amp;P 500 data.">Benchmark</th>
                <th className="number" title="The file size on disk.">Size</th><th title="Whether the file is new, imported, changed, or failed.">Status</th>
              </tr>
            </thead>
            <tbody>
              {files.length === 0 ? (
                <tr><td colSpan={8} className="muted data-empty">Nothing needs attention — every file in the folder is imported and unchanged.</td></tr>
              ) : files.map((file) => (
                <tr key={file.relPath} className={file.status === 'failed' ? 'research-thin-row' : undefined}>
                  <td className="data-path">
                    <strong>{file.relPath}</strong>
                    {file.error && <small className="negative">{file.error}</small>}
                  </td>
                  <td>{KIND_LABELS[file.kind]}</td>
                  <td className="number">{file.priceRows ? countLabel(file.priceRows) : '—'}</td>
                  <td className="number">{file.ratingRows ? countLabel(file.ratingRows) : '—'}</td>
                  <td className="number">{file.quantRows ? countLabel(file.quantRows) : '—'}</td>
                  <td className="number">{file.benchmarkRows ? countLabel(file.benchmarkRows) : '—'}</td>
                  <td className="number muted">{bytesLabel(file.bytes)}</td>
                  <td><span className={`verdict ${STATUS_CLASS[file.status]}`}>{STATUS_LABEL[file.status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <footer className="table-footer">
          <span>Every row in the database records which file it came from; the files themselves are the audit trail</span>
          <span>Database: .data/vantage.sqlite</span>
        </footer>
      </section>
    </>
  );
}
