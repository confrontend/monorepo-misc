import { Fragment, useState } from 'react';
import { formatTime } from '../App.js';
import { useArchives } from '../hooks/useArchives.js';

export function ArchivesRoute({ setMessage }: { setMessage: (message: string) => void }) {
  const { archives, loadingArchives, loadArchives } = useArchives(setMessage);
  const [expandedArchive, setExpandedArchive] = useState<string | null>(null);

  return (
    <section id="evidence" className="menu-section panel archives-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">GMGN ARCHIVE EVIDENCE</p>
          <h2>Capture archives on disk</h2>
        </div>
        <button
          className="secondary"
          disabled={loadingArchives}
          onClick={() => void loadArchives()}
        >
          {loadingArchives ? 'Loading…' : 'Load archives'}
        </button>
      </div>
      <p>
        Every one-off capture is archived locally as a ZIP. This re-verifies each file's SHA-256 and
        structure from disk and shows only the safe manifest — never the API key or raw captured
        events.
      </p>
      {archives === null ? (
        <p className="muted">Not loaded yet.</p>
      ) : archives.length === 0 ? (
        <p className="muted">No GMGN capture archives found.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Captured</th>
                <th>Events</th>
                <th>Size</th>
                <th>SHA-256</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {archives.map((archive) => (
                <Fragment key={archive.fileName}>
                  <tr
                    className="archive-row"
                    onClick={() =>
                      setExpandedArchive((current) =>
                        current === archive.fileName ? null : archive.fileName,
                      )
                    }
                  >
                    <td>
                      <strong>{formatTime(archive.manifest?.capturedAt ?? null)}</strong>
                      <small>{archive.fileName}</small>
                    </td>
                    <td>
                      {archive.manifest?.eventCount ?? '—'}
                      <small>
                        {archive.manifest
                          ? `${archive.manifest.stored ?? 0} stored · ${archive.manifest.repeated ?? 0} repeated · ${archive.manifest.validationErrors ?? 0} issues`
                          : ''}
                      </small>
                    </td>
                    <td>{(archive.archiveBytes / 1024).toFixed(1)} KB</td>
                    <td>
                      <small>{archive.archiveSha256.slice(0, 16)}…</small>
                    </td>
                    <td>
                      {archive.verified ? (
                        <span className="archived">Verified</span>
                      ) : (
                        <span className="log-error">Failed</span>
                      )}
                    </td>
                  </tr>
                  {expandedArchive === archive.fileName && (
                    <tr className="archive-detail-row">
                      <td colSpan={5}>
                        <div className="archive-detail">
                          <div>
                            <span>Full SHA-256</span>
                            <strong>{archive.archiveSha256}</strong>
                          </div>
                          <div>
                            <span>Filename hash matches content</span>
                            <strong className={archive.hashVerified ? 'log-info' : 'log-error'}>
                              {archive.hashVerified ? 'Yes' : 'No'}
                            </strong>
                          </div>
                          <div>
                            <span>ZIP structure valid</span>
                            <strong
                              className={archive.structureVerified ? 'log-info' : 'log-error'}
                            >
                              {archive.structureVerified ? 'Yes' : 'No'}
                            </strong>
                          </div>
                          <div>
                            <span>Manifest event count matches archived response</span>
                            <strong
                              className={
                                archive.eventCountVerified === false ? 'log-error' : 'log-info'
                              }
                            >
                              {archive.eventCountVerified === null
                                ? 'Not checked'
                                : archive.eventCountVerified
                                  ? 'Yes'
                                  : 'No'}
                            </strong>
                          </div>
                          <div>
                            <span>Entries</span>
                            <strong>{archive.entryNames.join(', ') || '—'}</strong>
                          </div>
                          <div>
                            <span>Modified</span>
                            <strong>{formatTime(archive.modifiedAt)}</strong>
                          </div>
                          {archive.verificationError && (
                            <div>
                              <span>Verification error</span>
                              <strong className="log-error">{archive.verificationError}</strong>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
