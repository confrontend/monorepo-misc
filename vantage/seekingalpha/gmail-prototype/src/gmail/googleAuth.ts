// Thin wrapper around Google Identity Services (GIS) token client.
// Loaded via the <script src="https://accounts.google.com/gsi/client"> tag in index.html.
// This uses the browser-only OAuth2 token flow (no backend), appropriate for a local prototype.
// See SETUP.md for how to obtain a Client ID.

export interface TokenResponse {
  access_token: string;
  // Seconds until this access token expires (Google typically sends 3599).
  expires_in?: number;
  error?: string;
  error_description?: string;
  [key: string]: unknown;
}

export interface TokenClient {
  requestAccessToken: (overrideConfig?: Record<string, unknown>) => void;
}

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: TokenResponse) => void;
          }) => TokenClient;
        };
      };
    };
  }
}

// Read-only scope: this prototype only proves it can read email, never send or modify.
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

export function initTokenClient(
  clientId: string,
  callback: (response: TokenResponse) => void,
): TokenClient {
  if (!window.google?.accounts?.oauth2) {
    throw new Error(
      'Google Identity Services script has not loaded yet. Wait a moment and try again.',
    );
  }
  return window.google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: GMAIL_READONLY_SCOPE,
    callback,
  });
}
