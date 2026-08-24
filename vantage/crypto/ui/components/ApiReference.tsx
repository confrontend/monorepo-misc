import { useEffect, useMemo, useState } from 'react';

type ApiDoc = {
  method: 'GET' | 'POST';
  path: string;
  summary: string;
  explanation: string;
  parameters?: string[];
  exampleResponse: unknown;
};
type ApiResponse = { generatedAt: string; source: string; count: number; endpoints: ApiDoc[] };

export function ApiReference({ api }: { api: <T>(path: string) => Promise<T> }) {
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api<ApiResponse>('/api/docs')
      .then((value) => {
        if (active) setResponse(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api]);

  const endpoints = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (response?.endpoints ?? []).filter(
      (entry) =>
        !needle ||
        `${entry.method} ${entry.path} ${entry.summary} ${entry.explanation}`
          .toLowerCase()
          .includes(needle),
    );
  }, [query, response]);
  const download = () => {
    if (!response) return;
    const blob = new Blob([JSON.stringify(response, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'crypto-api-reference.json';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="menu-section panel api-reference-panel">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">DEVELOPER REFERENCE</p>
          <h2>API Reference</h2>
        </div>
        <button type="button" className="secondary" disabled={!response} onClick={download}>
          Export JSON
        </button>
      </div>
      <p className="muted">
        Live documentation for the local API. These endpoints read saved SQLite evidence unless the
        explanation says otherwise. Examples show the response shape, not live wallet data.
      </p>
      <div className="api-reference-toolbar">
        <input
          aria-label="Search APIs"
          placeholder="Search path or explanation…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span>
          {endpoints.length} of {response?.count ?? '—'} endpoints
        </span>
      </div>
      {loading && (
        <p className="copytrade-analysis-status running">
          <span className="loading-spinner" /> Loading API catalog…
        </p>
      )}
      {error && <p className="error-text">Could not load API catalog: {error}</p>}
      {!loading && !error && (
        <div className="api-reference-list">
          {endpoints.map((entry) => (
            <details className="api-reference-entry" key={`${entry.method}-${entry.path}`}>
              <summary>
                <span className={`api-method ${entry.method.toLowerCase()}`}>{entry.method}</span>
                <code>{entry.path}</code>
                <strong>{entry.summary}</strong>
              </summary>
              <div className="api-reference-body">
                <p>{entry.explanation}</p>
                {entry.parameters?.length ? (
                  <p>
                    <strong>Parameters:</strong> {entry.parameters.join(', ')}
                  </p>
                ) : null}
                <pre>{JSON.stringify(entry.exampleResponse, null, 2)}</pre>
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}
