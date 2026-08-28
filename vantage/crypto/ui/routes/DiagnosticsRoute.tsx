import { formatTime } from '../httpClient.js';
import { useLogs } from '../hooks/useLogs.js';

export function DiagnosticsRoute({ setMessage }: { setMessage: (message: string) => void }) {
  const { logs, loadingLogs, loadLogs } = useLogs(setMessage);

  return (
    <section id="diagnostics" className="menu-section panel diagnostics-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">DIAGNOSTICS</p>
          <h2>Recent request activity</h2>
        </div>
        <button className="secondary" disabled={loadingLogs} onClick={() => void loadLogs()}>
          {loadingLogs ? 'Loading…' : 'Load recent activity'}
        </button>
      </div>
      <p>
        Every non-GET request, every error, and any connection dropped before a response was sent is
        recorded here for troubleshooting.
      </p>
      {logs === null ? (
        <p className="muted">Not loaded yet.</p>
      ) : logs.length === 0 ? (
        <p className="muted">No diagnostic events recorded yet.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Request</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => (
                <tr key={log.id}>
                  <td>
                    <small>{formatTime(log.createdAt)}</small>
                  </td>
                  <td>
                    <strong className={`log-${log.level}`}>{log.event}</strong>
                    {log.message ? <small>{log.message}</small> : null}
                  </td>
                  <td>
                    <small>
                      {log.method ?? '—'} {log.path ?? ''}
                    </small>
                  </td>
                  <td>
                    <small>
                      {log.status ?? '—'}
                      {log.durationMs !== null ? ` · ${log.durationMs}ms` : ''}
                      {log.requestBytes ? ` · ${(log.requestBytes / 1024).toFixed(1)}KB` : ''}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
