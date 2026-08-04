"""
Minimal FastAPI service proving *unattended* Gmail access via an OAuth refresh token.

Flow:
1. One-time, interactive: open /auth/login in a browser, sign in, grant read-only
   Gmail access. Google redirects to /auth/callback, which exchanges the
   authorization code for credentials -- including a refresh token -- and saves
   them to token.json.
2. From then on: GET /emails/latest reads token.json, lets google-auth silently
   refresh the access token using the stored refresh token, and calls the Gmail
   API. No browser, no popup, no user interaction. This is the part meant to run
   as an unattended, deployed service calling another service (Google's).

Scope is read-only (gmail.readonly). This never sends, modifies, or deletes mail.

Caveat (see SETUP.md): while the Google OAuth consent screen is in "Testing"
publishing status, Google revokes the refresh token after 7 days. Move the
consent screen to "In production" for the refresh token to last indefinitely.
"""

import logging
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from google.auth.transport.requests import Request as GoogleAuthRequest
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

import diagnostics as diag

# Explicit path, not a bare load_dotenv(): python-dotenv's automatic search
# is relative to the process's current working directory, which is the
# project root (not gmail-backend/) when uvicorn is launched via
# `--app-dir gmail-backend` from the root `npm run dev` script. Without this,
# .env silently fails to load and every credential check reports missing.
load_dotenv(Path(__file__).parent / '.env')

# Dev-phase logging: verbose by default. Set LOG_LEVEL=INFO (or WARNING) in
# .env to quiet it down once this is no longer being actively debugged.
LOG_LEVEL = os.environ.get("LOG_LEVEL", "DEBUG").upper()
logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
)
logger = logging.getLogger("gmail_backend")

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
TOKEN_PATH = Path(__file__).parent / "token.json"


@asynccontextmanager
async def lifespan(app: FastAPI):
    client_id = os.environ.get("GOOGLE_CLIENT_ID", "")
    diag.log_event(
        "app_startup",
        {
            "log_level": LOG_LEVEL,
            "has_client_id": bool(client_id),
            "client_id_prefix": (client_id[:14] + "...") if client_id else None,
            "has_client_secret": bool(os.environ.get("GOOGLE_CLIENT_SECRET")),
            "redirect_uri": os.environ.get("OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback"),
            "token_exists": TOKEN_PATH.exists(),
        },
    )
    logger.info("Gmail backend starting up (authorized=%s, log_level=%s)", TOKEN_PATH.exists(), LOG_LEVEL)
    yield
    diag.log_event("app_shutdown", {})
    logger.info("Gmail backend shutting down")


app = FastAPI(title="Gmail automation prototype", lifespan=lifespan)


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    logger.debug("--> %s %s?%s", request.method, request.url.path, request.url.query)
    try:
        response = await call_next(request)
    except Exception as exc:
        diag.log_event(
            "http_unhandled_exception",
            {"method": request.method, "path": request.url.path},
            level="error",
            exc=exc,
        )
        logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
        raise
    duration_ms = round((time.perf_counter() - start) * 1000, 1)
    logger.info(
        "<-- %s %s %s (%sms)",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    # Skip persisting hits to /diagnostics itself so checking the log doesn't
    # spam the log.
    if request.url.path != "/diagnostics":
        diag.log_event(
            "http_request",
            {
                "method": request.method,
                "path": request.url.path,
                "query": str(request.url.query),
                "status_code": response.status_code,
                "duration_ms": duration_ms,
            },
            level="debug" if response.status_code < 400 else "warning",
        )
    return response


def _get_client_config() -> dict:
    client_id = os.environ.get("GOOGLE_CLIENT_ID")
    client_secret = os.environ.get("GOOGLE_CLIENT_SECRET")
    redirect_uri = os.environ.get("OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
    if not client_id or not client_secret:
        raise HTTPException(
            status_code=500,
            detail=(
                "Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. "
                "Copy .env.example to .env and fill them in -- see SETUP.md."
            ),
        )
    return {
        "web": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
            "redirect_uris": [redirect_uri],
        }
    }, redirect_uri


def _build_flow() -> Flow:
    client_config, redirect_uri = _get_client_config()
    return Flow.from_client_config(client_config, scopes=SCOPES, redirect_uri=redirect_uri)


def _load_credentials() -> Credentials:
    if not TOKEN_PATH.exists():
        raise HTTPException(
            status_code=400,
            detail="No stored credentials yet. Visit /auth/login once to authorize this app.",
        )
    creds = Credentials.from_authorized_user_file(str(TOKEN_PATH), SCOPES)
    logger.debug("Loaded token.json (expired=%s, has_refresh_token=%s)", creds.expired, bool(creds.refresh_token))
    if creds.expired and creds.refresh_token:
        # This is the unattended part: no browser, no prompt, just the stored
        # refresh token minting a fresh access token.
        logger.info("Access token expired -- refreshing via stored refresh token (no user interaction)")
        try:
            creds.refresh(GoogleAuthRequest())
        except Exception as exc:
            diag.log_event("token_refresh_error", {}, level="error", exc=exc)
            raise HTTPException(status_code=502, detail=f"Refresh token exchange failed: {exc}") from exc
        TOKEN_PATH.write_text(creds.to_json())
        diag.log_event(
            "token_refreshed",
            {"expiry": creds.expiry.isoformat() if creds.expiry else None},
        )
    return creds


@app.get("/")
def root():
    token_exists = TOKEN_PATH.exists()
    return {
        "status": "ok",
        "authorized": token_exists,
        "next_step": "GET /auth/login (one-time)" if not token_exists else "GET /emails/latest",
    }


@app.get("/auth/login")
def auth_login():
    try:
        flow = _build_flow()
        auth_url, _state = flow.authorization_url(
            access_type="offline",
            prompt="consent",
            include_granted_scopes="true",
        )
    except HTTPException as exc:
        diag.log_event("auth_login_error", {"detail": exc.detail}, level="error")
        raise
    except Exception as exc:
        diag.log_event("auth_login_error", {}, level="error", exc=exc)
        raise
    redirect_uri = os.environ.get("OAUTH_REDIRECT_URI", "http://localhost:8000/auth/callback")
    logger.info("Redirecting to Google for consent (redirect_uri=%s)", redirect_uri)
    logger.debug("Full auth_url: %s", auth_url)
    diag.log_event(
        "auth_login_initiated",
        {"redirect_uri": redirect_uri, "scopes": SCOPES, "auth_url": auth_url},
    )
    return RedirectResponse(auth_url)


@app.get("/auth/callback")
def auth_callback(code: Optional[str] = Query(None), error: Optional[str] = Query(None)):
    # Google redirects here either with `code` (success) or `error` (e.g. the
    # user clicked "Cancel", or -- as with origin_mismatch -- Google blocked
    # the request before it ever got this far, in which case neither param
    # arrives and the user never leaves Google's own error page.
    if error:
        logger.warning("Google returned an OAuth error to /auth/callback: %s", error)
        diag.log_event("auth_callback_denied", {"error": error}, level="warning")
        raise HTTPException(status_code=400, detail=f"Google returned an error: {error}")
    if not code:
        logger.error("/auth/callback hit with neither 'code' nor 'error' -- unexpected")
        diag.log_event("auth_callback_missing_code", {}, level="error")
        raise HTTPException(status_code=400, detail="No 'code' parameter received from Google.")

    logger.debug("Exchanging authorization code for tokens")
    try:
        flow = _build_flow()
        flow.fetch_token(code=code)
        creds = flow.credentials
        TOKEN_PATH.write_text(creds.to_json())
    except Exception as exc:
        logger.exception("Token exchange failed")
        diag.log_event("auth_callback_error", {}, level="error", exc=exc)
        raise HTTPException(status_code=400, detail=f"Token exchange failed: {exc}") from exc

    logger.info("Authorization successful (has_refresh_token=%s)", bool(creds.refresh_token))
    diag.log_event(
        "auth_callback_success",
        {
            "has_refresh_token": bool(creds.refresh_token),
            "scopes": creds.scopes,
            "expiry": creds.expiry.isoformat() if creds.expiry else None,
        },
    )
    return {
        "status": "authorized",
        "has_refresh_token": bool(creds.refresh_token),
        "next_step": "GET /emails/latest -- this now works with no further interaction.",
    }


@app.get("/emails/latest")
def latest_email():
    logger.debug("Fetching latest email")
    try:
        creds = _load_credentials()
        service = build("gmail", "v1", credentials=creds)

        list_resp = service.users().messages().list(userId="me", maxResults=1).execute()
        messages = list_resp.get("messages", [])
        if not messages:
            logger.warning("Gmail returned zero messages for this account")
            diag.log_event("emails_latest_empty", {}, level="warning")
            raise HTTPException(status_code=404, detail="No messages found in this Gmail account.")

        message_id = messages[0]["id"]
        logger.debug("Fetching message metadata for id=%s", message_id)
        message = (
            service.users()
            .messages()
            .get(
                userId="me",
                id=message_id,
                format="metadata",
                metadataHeaders=["From", "Subject", "Date"],
            )
            .execute()
        )
    except HTTPException as exc:
        diag.log_event(
            "emails_latest_error",
            {"status_code": exc.status_code, "detail": exc.detail},
            level="error",
        )
        raise
    except Exception as exc:
        logger.exception("Gmail API call failed in /emails/latest")
        diag.log_event("emails_latest_error", {}, level="error", exc=exc)
        raise HTTPException(status_code=502, detail=f"Gmail API call failed: {exc}") from exc

    headers = {h["name"]: h["value"] for h in message.get("payload", {}).get("headers", [])}
    logger.info("Successfully read message id=%s with no user interaction", message["id"])
    diag.log_event("emails_latest_success", {"message_id": message["id"]})
    return {
        "id": message["id"],
        "from": headers.get("From", "(unknown)"),
        "subject": headers.get("Subject", "(unknown)"),
        "date": headers.get("Date", "(unknown)"),
        "snippet": message.get("snippet", ""),
    }


@app.get("/diagnostics")
def diagnostics(limit: int = 50, level: Optional[str] = None):
    """Recent OAuth/Gmail flow events, most recent first. Backed by
    diagnostics.db (SQLite) so this history survives server restarts.
    Optional ?level=error to filter to just errors/warnings-and-up isn't
    implemented as a threshold -- pass the exact level (debug/info/warning/error)."""
    return {"events": diag.recent_events(limit=limit, level=level)}
