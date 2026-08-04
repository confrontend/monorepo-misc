# Setup — Gmail automation prototype (backend)

This proves the piece the browser-only `gmail-prototype/` app couldn't: a
service that reads Gmail *without a human clicking anything*, using a stored
OAuth refresh token. Authorize once, then `/emails/latest` works forever with
no further interaction — the shape you'd want once this is deployed as a
service in the cloud.

## Why a separate app from `gmail-prototype/`

The React app uses Google Identity Services' browser-only token flow, which
never issues a refresh token and always needs a live popup. Refresh tokens can
only be obtained through the server-side "Authorization Code" flow, which
requires a client secret — something that must never be shipped to a browser.
Hence: a small backend.

## 1. Reuse or create a Google Cloud project

If you already created one for `gmail-prototype/`, reuse it. Otherwise:
https://console.cloud.google.com/projectcreate

## 2. Enable the Gmail API (if not already)

https://console.cloud.google.com/apis/library/gmail.googleapis.com → Enable

## 3. OAuth consent screen

https://console.cloud.google.com/apis/credentials/consent

- External user type, scope `https://www.googleapis.com/auth/gmail.readonly`,
  your Gmail as a test user — same as before.
- **Important for automation:** while this screen's publishing status is
  "Testing", Google revokes the refresh token after 7 days. When you're ready
  for this to run unattended long-term, move the status to **"In production"**
  (Setup → Publish app). That does not require full Google verification for a
  small personal app — you'll just fill in app name, support email, and (for
  production) privacy policy / terms of service URLs. Testing status is fine
  while you're still proving this out.

## 4. Create (or reuse and edit) the OAuth Client ID

This backend needs a **client secret**, which the browser-only app didn't use.
You can either create a new "Web application" OAuth client for this backend,
or edit the existing one:

1. https://console.cloud.google.com/apis/credentials
2. Under **Authorized redirect URIs**, add: `http://localhost:8000/auth/callback`
3. Copy both the **Client ID** and the **Client secret**.

## 5. Configure the app

```bash
cd gmail-backend
cp .env.example .env
```

Edit `.env`:

```
GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client secret>
OAUTH_REDIRECT_URI=http://localhost:8000/auth/callback
```

## 6. Install and run

```bash
pip install -r requirements.txt
uvicorn app:app --reload --port 8000
```

## 7. Authorize once (interactive — the only manual step, ever)

Open http://localhost:8000/auth/login in a browser, sign in with your test-user
Gmail account, approve the read-only scope. You'll land on `/auth/callback`,
which saves `token.json` (contains the refresh token) and returns:

```json
{"status": "authorized", "has_refresh_token": true, ...}
```

## 8. Prove the unattended part

```bash
curl http://localhost:8000/emails/latest
```

Run that again — tomorrow, next week, from a cron job, from a deployed
container — with no browser involved. `token.json`'s refresh token lets the
service silently mint new access tokens each time.

## 9. If something goes wrong: check /diagnostics

Every step of the flow logs a row to a local SQLite file, `diagnostics.db`
(created automatically). Check it anytime:

```bash
curl http://localhost:8000/diagnostics
```

It records events like `app_startup` (masked client ID prefix, whether
secrets are set, whether `token.json` already exists), `auth_login_initiated`
(exact redirect_uri, scopes, and full `auth_url` sent to Google),
`auth_callback_success`/`auth_callback_error`, `token_refreshed`, every
`http_request` with status code and timing, and any unhandled exception —
each with a timestamp and, for errors, a full traceback (`exc=...` param) so
you have a persistent trail instead of only whatever scrolled by in the
terminal. Filter with `?level=error` or raise `?limit=` for more history.

Console output is also verbose in dev: every request logs on the way in and
out, with a `DEBUG`-level line right before anything Google-related happens.
Set `LOG_LEVEL=INFO` (or `WARNING`) in `.env` once this is stable and the
verbosity isn't needed anymore.

**Remember to restart the server** (`npm run dev`, or however you're running
it) after pulling logging changes like these — `diagnostics.db` only fills in
once a server running the *current* code actually handles a request.

One real limitation: errors Google blocks *before* redirecting back to this
server (e.g. `origin_mismatch`, or the user closing the consent screen) happen
entirely in the browser and never reach this backend, so they won't show up
here regardless of log level. Those still only show up as Google's own error
page — the `app_startup` and `auth_login_initiated` events are the closest
this log can get, since they confirm exactly what redirect_uri/client this
server sent Google in the first place.

## Notes on deploying this for real later

- `token.json` currently sits on disk — fine for local proof-of-concept. In a
  real cloud deployment, move it into a secrets manager (e.g. a database row,
  Secret Manager, Vault) rather than a file on an ephemeral container.
- Only one Gmail account is authorized per `token.json`. Monitoring multiple
  accounts/aliases means one token per account.
- If the refresh token is ever revoked (password change, explicit revoke, or
  6 months of inactivity), `/emails/latest` will start failing and someone
  needs to re-run step 7.
