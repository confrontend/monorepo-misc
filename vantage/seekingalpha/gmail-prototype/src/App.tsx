import { useCallback, useEffect, useState } from 'react';
import { initTokenClient } from './gmail/googleAuth';
import { GmailAuthError, listSeekingAlphaEmails, type GmailMessageSummary } from './gmail/gmailApi';
import { clearToken, loadToken, saveToken } from './gmail/tokenStorage';
import EmailList from './components/EmailList';
import EmailDetail from './components/EmailDetail';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const DEFAULT_PAGE_SIZE = 10;

type Status = 'idle' | 'connecting' | 'connected' | 'error';

interface CachedPage {
  items: GmailMessageSummary[];
  nextPageToken?: string;
}

function App() {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [pages, setPages] = useState<CachedPage[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);

  // Shared by the list fetch and the detail-panel body fetch: the
  // cached/short-lived token is dead, so clear it and drop back to a
  // disconnected state instead of silently failing on every request.
  const handleAuthExpired = useCallback(() => {
    clearToken();
    setAccessToken(null);
    setStatus('idle');
    setPages([]);
    setPageIndex(0);
    setSelectedId(null);
    setListError('Your Gmail session expired. Click "Connect to Gmail" to reconnect.');
  }, []);

  // Gmail paginates with an opaque pageToken, not a page number. Pages
  // already fetched are cached here so "Previous" is instant and never
  // re-fetches; only advancing past the cached edge hits the network.
  const loadPage = useCallback(
    async (token: string, index: number, pageToken: string | undefined, size: number) => {
      setListLoading(true);
      setListError(null);
      try {
        const page = await listSeekingAlphaEmails(token, { pageToken, pageSize: size });
        setPages((prev) => {
          const next = [...prev];
          next[index] = page;
          return next;
        });
        setPageIndex(index);
        setSelectedId(page.items[0]?.id ?? null);
      } catch (err) {
        if (err instanceof GmailAuthError) {
          handleAuthExpired();
        } else {
          setListError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setListLoading(false);
      }
    },
    [handleAuthExpired],
  );

  const handleConnect = useCallback(() => {
    if (!CLIENT_ID) {
      setStatus('error');
      setError('Missing VITE_GOOGLE_CLIENT_ID. See SETUP.md for how to create one.');
      return;
    }
    setStatus('connecting');
    setError(null);
    try {
      const client = initTokenClient(CLIENT_ID, (tokenResponse) => {
        if (tokenResponse.error) {
          setStatus('error');
          setError(`OAuth error: ${tokenResponse.error}${tokenResponse.error_description ? ` — ${tokenResponse.error_description}` : ''}`);
          return;
        }
        saveToken(tokenResponse.access_token, tokenResponse.expires_in ?? 3600);
        setAccessToken(tokenResponse.access_token);
        setStatus('connected');
      });
      client.requestAccessToken();
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    clearToken();
    setAccessToken(null);
    setStatus('idle');
    setPages([]);
    setPageIndex(0);
    setSelectedId(null);
    setListError(null);
  }, []);

  // On mount, restore a still-valid token from sessionStorage so a page
  // reload in the same tab doesn't force a reconnect. This only survives
  // until the token's own expiry (~1 hour) -- see tokenStorage.ts.
  useEffect(() => {
    const cached = loadToken();
    if (cached) {
      setAccessToken(cached);
      setStatus('connected');
    }
  }, []);

  // Auto-load the first page as soon as we're connected.
  useEffect(() => {
    if (status === 'connected' && accessToken && pages.length === 0) {
      loadPage(accessToken, 0, undefined, pageSize);
    }
  }, [status, accessToken, pages.length, pageSize, loadPage]);

  const handlePageSizeChange = useCallback(
    (size: number) => {
      setPageSize(size);
      setPages([]);
      setPageIndex(0);
      if (accessToken) {
        loadPage(accessToken, 0, undefined, size);
      }
    },
    [accessToken, loadPage],
  );

  const handleNext = useCallback(() => {
    if (!accessToken) return;
    if (pageIndex + 1 < pages.length) {
      setPageIndex(pageIndex + 1);
      setSelectedId(pages[pageIndex + 1].items[0]?.id ?? null);
      return;
    }
    const nextToken = pages[pageIndex]?.nextPageToken;
    if (nextToken) {
      loadPage(accessToken, pageIndex + 1, nextToken, pageSize);
    }
  }, [accessToken, pages, pageIndex, pageSize, loadPage]);

  const handlePrevious = useCallback(() => {
    if (pageIndex === 0) return;
    setPageIndex(pageIndex - 1);
    setSelectedId(pages[pageIndex - 1].items[0]?.id ?? null);
  }, [pageIndex, pages]);

  const currentItems = pages[pageIndex]?.items ?? [];
  const selectedEmail = currentItems.find((item) => item.id === selectedId) ?? null;
  const hasNextPage = pageIndex + 1 < pages.length || Boolean(pages[pageIndex]?.nextPageToken);
  const hasPreviousPage = pageIndex > 0;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 960, margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Gmail connection prototype</h1>
      <p style={{ color: '#666', fontSize: 14, marginTop: 0 }}>
        Reads seekingalpha.com messages (read-only, paginated). No backend — this calls the Gmail
        API directly from the browser using an OAuth access token.
      </p>

      <div style={{ marginBottom: '1rem', display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={handleConnect} disabled={status === 'connecting' || status === 'connected'}>
          {status === 'connected' ? 'Connected' : status === 'connecting' ? 'Connecting…' : 'Connect to Gmail'}
        </button>
        {status === 'connected' && (
          <button onClick={handleDisconnect} style={{ color: '#666' }}>
            Disconnect
          </button>
        )}
      </div>

      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {status === 'connected' && (
        <div style={{ display: 'flex', border: '1px solid #ccc', borderRadius: 8, overflow: 'hidden', minHeight: 420 }}>
          <EmailList
            items={currentItems}
            selectedId={selectedId}
            onSelect={setSelectedId}
            pageSize={pageSize}
            onPageSizeChange={handlePageSizeChange}
            pageNumber={pageIndex + 1}
            hasNextPage={hasNextPage}
            hasPreviousPage={hasPreviousPage}
            onNext={handleNext}
            onPrevious={handlePrevious}
            loading={listLoading}
          />

          <button
            onClick={() => setPanelCollapsed((collapsed) => !collapsed)}
            aria-label={panelCollapsed ? 'Expand detail panel' : 'Collapse detail panel'}
            style={{
              width: 22,
              flexShrink: 0,
              border: 'none',
              borderLeft: '1px solid #ccc',
              borderRight: panelCollapsed ? 'none' : '1px solid #ccc',
              background: '#f7f7f7',
              cursor: 'pointer',
            }}
          >
            {panelCollapsed ? '‹' : '›'}
          </button>

          {!panelCollapsed && (
            <div style={{ width: 320, flexShrink: 0, background: '#fafafa', overflowY: 'auto' }}>
              <EmailDetail email={selectedEmail} accessToken={accessToken} onAuthError={handleAuthExpired} />
            </div>
          )}
        </div>
      )}

      {listError && <p style={{ color: 'crimson', marginTop: '1rem' }}>{listError}</p>}
    </main>
  );
}

export default App;
