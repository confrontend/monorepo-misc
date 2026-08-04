# Setup — Gmail connection prototype

This is a minimal React + TypeScript app that proves it can authenticate with Gmail
(read-only) and read one email. There is no backend: it uses Google Identity Services
in the browser to get an OAuth access token, then calls the Gmail REST API directly.

You need to create a Google OAuth Client ID yourself — this requires your own Google
account and can't be done on your behalf. It takes about 5 minutes.

## 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com/projectcreate
2. Name it anything (e.g. "seekingalpha-gmail-prototype") and create it.

## 2. Enable the Gmail API

1. In the project, go to https://console.cloud.google.com/apis/library/gmail.googleapis.com
2. Click **Enable**.

## 3. Configure the OAuth consent screen

1. Go to https://console.cloud.google.com/apis/credentials/consent
2. Choose **External** user type (unless you have a Google Workspace org and want Internal).
3. Fill in the required app name, support email, and developer contact email.
4. Add the scope `https://www.googleapis.com/auth/gmail.readonly`.
5. Under **Test users**, add your own Gmail address. While the app is in "Testing"
   status, only test users you list can authorize it — that's fine for this prototype.

## 4. Create an OAuth Client ID

1. Go to https://console.cloud.google.com/apis/credentials
2. Click **Create Credentials → OAuth client ID**.
3. Application type: **Web application**.
4. Under **Authorized JavaScript origins**, add: `http://localhost:5173`
   (Vite's default dev server address. Adjust if you run it on a different port.)
5. Leave "Authorized redirect URIs" empty — this flow doesn't use redirects.
6. Click **Create** and copy the generated Client ID (ends in `.apps.googleusercontent.com`).

## 5. Configure the app

```bash
cp .env.example .env
```

Edit `.env` and paste your Client ID:

```
VITE_GOOGLE_CLIENT_ID=<your client id>.apps.googleusercontent.com
```

## 6. Run it

```bash
npm install
npm run dev
```

Open the printed local URL (typically http://localhost:5173).

## 7. Try it

1. Click **Connect to Gmail**.
2. A Google sign-in / consent popup appears. Sign in with the test-user account you
   added in step 3, and approve the read-only Gmail scope.
3. Click **Read one email**. The app fetches your most recent inbox message and
   displays its From, Subject, Date, and snippet.

## Notes

- Scope is read-only (`gmail.readonly`); the app never sends, modifies, or deletes mail.
- The access token lives only in browser memory (React state) — nothing is persisted
  or sent anywhere except directly to Google's APIs.
- This is a throwaway prototype to prove the connection works, per the project's
  README (Idea 2: Gmail-driven monitoring). It intentionally has no backend, no
  storage, and no parsing/estimation logic yet.
