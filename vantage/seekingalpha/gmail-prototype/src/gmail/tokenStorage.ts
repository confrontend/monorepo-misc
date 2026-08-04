// Caches the OAuth access token in sessionStorage so a page reload within the
// same tab doesn't force a reconnect. This does NOT make the connection
// persistent across browser restarts or beyond the token's own lifetime --
// the browser-only OAuth flow never issues a refresh token, so once the
// cached token's expiry passes, reconnecting is still required. For a
// connection that truly never needs reconnecting, use gmail-backend instead.

const STORAGE_KEY = 'gmail_prototype_token';

// Treat the token as expired slightly before Google actually expires it, so
// we don't attempt a Gmail API call with a token that dies mid-request.
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

interface StoredToken {
  accessToken: string;
  expiresAt: number;
}

export function saveToken(accessToken: string, expiresInSeconds: number): void {
  const record: StoredToken = {
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // sessionStorage can throw in private-browsing/locked-down contexts --
    // caching is a convenience, not a requirement, so fail silently.
  }
}

export function loadToken(): string | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as StoredToken;
    if (Date.now() > record.expiresAt - EXPIRY_SAFETY_MARGIN_MS) {
      sessionStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return record.accessToken;
  } catch {
    return null;
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore -- see saveToken.
  }
}
