"""
Read-only + trigger HTTP API over the existing SQLite database, so the React
UI (ui/) has something to talk to. This is a thin layer: every endpoint just
calls into the already-tested src/ modules (episodes, required_inputs,
pipeline, reports) rather than reimplementing any decision logic here.

Run with:
    uvicorn api.main:app --reload --port 8000

...or, for both the API and the UI dev server together, from ui/:
    npm run dev:all

Database path defaults to stock_selection.db in THIS FILE's parent directory
(stock_selection_system/), not the process's current working directory --
deliberately independent of cwd so it lands in the same place regardless of
how/where this gets launched from. Override with the STOCK_SELECTION_DB
environment variable (a relative path there IS resolved against cwd).
Created/initialized on startup if it doesn't exist yet.
"""
from __future__ import annotations

import os
import logging
import json
import re
import sqlite3
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Optional

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from src.db import get_connection, init_db
from src.episodes import run_episode, run_episode_for_retry
from src.ingestion.live import ingest_candidates, ingest_price_and_earnings, mark_context_reviewed
from src.ingestion.eodhd import EODHDClient, EODHDConfigurationError, eodhd_authentication_failure, run_eodhd_test
from src.reports import render_report
from src.required_inputs import retry_insufficient_data
from src.trading_calendar import default_calendar

_DEFAULT_DB_PATH = str(Path(__file__).resolve().parent.parent / "stock_selection.db")
DB_PATH = os.environ.get("STOCK_SELECTION_DB", _DEFAULT_DB_PATH)
DIAGNOSTICS_DIR = Path(__file__).resolve().parent.parent / "diagnostics"
DIAGNOSTIC_DB_PATH = DIAGNOSTICS_DIR / "diagnostics.db"
logger = logging.getLogger(__name__)
_BACKTEST_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="backtest")
_BACKTEST_JOBS: dict[str, dict] = {}
_BACKTEST_JOBS_LOCK = threading.Lock()


class _SQLiteDiagnosticHandler(logging.Handler):
    """Write the existing Python log stream to a queryable SQLite database."""

    _standard_record_fields = set(logging.LogRecord(None, 0, "", 0, "", (), None).__dict__)

    def __init__(self, database_path: Path, retention_days: int = 30):
        super().__init__(level=logging.DEBUG)
        self.database_path = database_path
        self.retention_days = retention_days
        self._emit_count = 0
        self._initialize_database()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.database_path, timeout=5)
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    def _initialize_database(self) -> None:
        with self._connect() as conn:
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute(
                """CREATE TABLE IF NOT EXISTS diagnostic_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts TEXT NOT NULL,
                    level TEXT NOT NULL,
                    logger_name TEXT NOT NULL,
                    message TEXT NOT NULL,
                    module TEXT,
                    function TEXT,
                    line INTEGER,
                    extra_json TEXT NOT NULL DEFAULT '{}'
                )"""
            )
            conn.execute("CREATE INDEX IF NOT EXISTS idx_diagnostic_events_ts_level ON diagnostic_events (ts, level)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_diagnostic_events_level_ts ON diagnostic_events (level, ts)")
            self._purge(conn)

    def _purge(self, conn: sqlite3.Connection) -> None:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=self.retention_days)).isoformat()
        conn.execute("DELETE FROM diagnostic_events WHERE ts < ?", (cutoff,))

    def emit(self, record: logging.LogRecord) -> None:
        try:
            message = _redact_debug(record.getMessage())
            extras = {
                key: _redact_debug(value)
                for key, value in record.__dict__.items()
                if key not in self._standard_record_fields
            }
            timestamp = datetime.fromtimestamp(record.created, timezone.utc).isoformat()
            with self._connect() as conn:
                conn.execute(
                    """INSERT INTO diagnostic_events
                    (ts, level, logger_name, message, module, function, line, extra_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        timestamp,
                        record.levelname,
                        record.name,
                        str(message),
                        record.module,
                        record.funcName,
                        record.lineno,
                        json.dumps(extras, default=str, ensure_ascii=True),
                    ),
                )
                self._emit_count += 1
                if self._emit_count % 500 == 0:
                    self._purge(conn)
        except Exception:
            # Diagnostics must never break the application being diagnosed.
            self.handleError(record)


def _configure_diagnostic_file_logging() -> None:
    """Temporarily capture backend debug logs without exposing API secrets."""
    DIAGNOSTICS_DIR.mkdir(exist_ok=True)
    root_logger = logging.getLogger()
    if any(getattr(handler, "_stock_selection_diagnostics", False) for handler in root_logger.handlers):
        return
    handler = _SQLiteDiagnosticHandler(DIAGNOSTIC_DB_PATH)
    handler._stock_selection_diagnostics = True  # type: ignore[attr-defined]
    root_logger.addHandler(handler)
    root_logger.setLevel(logging.DEBUG)


_configure_diagnostic_file_logging()


@asynccontextmanager
async def _lifespan(app: FastAPI):
    init_db(DB_PATH)
    yield


app = FastAPI(title="Stock-Selection System API", lifespan=_lifespan)

app.add_middleware(
    CORSMiddleware,
    # Dev-only: the UI is a separate Vite dev server on a different port.
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _conn() -> sqlite3.Connection:
    if not os.path.exists(DB_PATH):
        init_db(DB_PATH)
    return get_connection(DB_PATH)


def _redact_debug(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "***REDACTED***" if str(key).lower() in {"api_key", "api_token", "apikey", "authorization"} else _redact_debug(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact_debug(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"(?i)(api_token|apikey|api_key|authorization)=([^&\s]+)", r"\1=***REDACTED***", value)
    return value


class FrontendDebugLogRequest(BaseModel):
    label: str
    payload: Any = None


@app.post("/api/debug-log")
def frontend_debug_log(req: FrontendDebugLogRequest) -> dict:
    """Temporary dev-only bridge for browser diagnostics into the backend log."""
    payload = _redact_debug(req.payload)
    logger.debug("FRONTEND %s payload=%s", req.label[:200], json.dumps(payload, default=str, ensure_ascii=True))
    return {"ok": True}


# ---------------------------------------------------------------------------
# Read endpoints
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "db_path": os.path.abspath(DB_PATH)}


@app.get("/api/tickers")
def list_tickers() -> list[str]:
    conn = _conn()
    rows = conn.execute(
        "SELECT DISTINCT ticker FROM candidates "
        "UNION SELECT DISTINCT ticker FROM reviews ORDER BY ticker"
    ).fetchall()
    return [r["ticker"] for r in rows]


@app.get("/api/candidates")
def list_candidates(
    ticker: Optional[str] = None,
    source: Optional[str] = None,
    limit: int = Query(200, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> list[dict]:
    """Returns the persisted eligibility list for Candidate Intake.

    This is deliberately read-only: candidate rows are eligibility metadata,
    not scoring evidence. Validation is started separately through the live
    ingestion action for a selected ticker.
    """
    conn = _conn()
    clauses, params = [], []
    if ticker:
        clauses.append("ticker = ?")
        params.append(ticker.upper())
    if source:
        clauses.append("source = ?")
        params.append(source)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT candidate_id, date, ticker, source, source_rank, ai_score, "
        f"technical_score, fundamental_score, expected_return, direction "
        f"FROM candidates {where} ORDER BY date DESC, candidate_id DESC LIMIT ? OFFSET ?",
        (*params, limit, offset),
    ).fetchall()
    return [dict(row) for row in rows]


@app.get("/api/stats")
def stats() -> dict:
    conn = _conn()
    total = conn.execute("SELECT COUNT(*) AS n FROM reviews").fetchone()["n"]
    by_decision_rows = conn.execute(
        "SELECT decision, COUNT(*) AS n FROM reviews GROUP BY decision"
    ).fetchall()
    unresolved = conn.execute(
        "SELECT COUNT(*) AS n FROM insufficient_data_cases WHERE resolved = FALSE"
    ).fetchone()["n"]
    tickers_tracked = conn.execute(
        "SELECT COUNT(DISTINCT ticker) AS n FROM reviews"
    ).fetchone()["n"]
    return {
        "total_episodes": total,
        "by_decision": {r["decision"] or "n/a": r["n"] for r in by_decision_rows},
        "unresolved_insufficient_data_cases": unresolved,
        "tickers_tracked": tickers_tracked,
    }


@app.get("/api/episodes")
def list_episodes(
    ticker: Optional[str] = None,
    decision: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[dict]:
    conn = _conn()
    clauses, params = [], []
    if ticker:
        clauses.append("ticker = ?")
        params.append(ticker)
    if decision:
        clauses.append("decision = ?")
        params.append(decision)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = conn.execute(
        f"SELECT episode_id, ticker, decision, confidence, episode_trigger, eligibility_date, "
        f"review_date, decision_timestamp_utc, earnings_score, market_score, context_score, "
        f"total_score, red_flag, earnings_within_5d, corrects_episode_id, resolved_from_audit_id "
        f"FROM reviews {where} ORDER BY decision_timestamp_utc DESC LIMIT ? OFFSET ?",
        (*params, limit, offset),
    ).fetchall()
    return [dict(r) for r in rows]


@app.get("/api/episodes/{episode_id}")
def get_episode(episode_id: str) -> dict:
    conn = _conn()
    review = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (episode_id,)).fetchone()
    if review is None:
        raise HTTPException(status_code=404, detail=f"No episode {episode_id!r}")
    entry = conn.execute(
        "SELECT * FROM episode_entries WHERE episode_id = ?", (episode_id,)
    ).fetchone()
    outcomes = conn.execute(
        "SELECT * FROM recommendation_outcomes WHERE episode_id = ? ORDER BY horizon_days",
        (episode_id,),
    ).fetchall()
    return {
        "review": dict(review),
        "entry": dict(entry) if entry else None,
        "outcomes": [dict(o) for o in outcomes],
        "report_text": render_report(conn, episode_id),
    }


@app.get("/api/insufficient-data-cases")
def list_insufficient_data_cases(
    resolved: Optional[bool] = None,
    ticker: Optional[str] = None,
) -> list[dict]:
    conn = _conn()
    clauses, params = [], []
    if resolved is not None:
        clauses.append("resolved = ?")
        params.append(1 if resolved else 0)
    if ticker:
        clauses.append("ticker = ?")
        params.append(ticker)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    cases = conn.execute(
        f"SELECT * FROM insufficient_data_cases {where} ORDER BY checked_at DESC", params
    ).fetchall()
    result = []
    for case in cases:
        fields = conn.execute(
            "SELECT missing_group, missing_field FROM insufficient_data_fields WHERE audit_id = ?",
            (case["audit_id"],),
        ).fetchall()
        result.append({**dict(case), "missing_fields": [dict(f) for f in fields]})
    return result


# ---------------------------------------------------------------------------
# Trigger endpoints
# ---------------------------------------------------------------------------

class RetryRequest(BaseModel):
    as_of_date: date


@app.post("/api/actions/retry-insufficient-data")
def retry_insufficient(req: RetryRequest) -> dict:
    """Re-checks every unresolved insufficient_data_cases row and resolves
    whichever now have all their originally-missing fields available."""
    conn = _conn()

    def _adapter(**kwargs):
        return run_episode_for_retry(conn=conn, calendar=default_calendar, **kwargs)

    resolved_ids = retry_insufficient_data(conn, _adapter, today=req.as_of_date, calendar=default_calendar)
    return {"resolved_episode_ids": resolved_ids, "count": len(resolved_ids)}


class EODHDTestRequest(BaseModel):
    ticker: str
    as_of_date: date


@app.post("/api/actions/test-eodhd")
def test_eodhd(req: EODHDTestRequest) -> dict:
    """Read-only EODHD diagnostic; never opens or modifies the application DB."""
    ticker = req.ticker.strip().upper()
    if not ticker:
        raise HTTPException(status_code=400, detail="ticker must not be empty")
    try:
        client = EODHDClient()
    except EODHDConfigurationError:
        return eodhd_authentication_failure(ticker, req.as_of_date)
    return run_eodhd_test(ticker, req.as_of_date, client=client)


class IngestLiveRequest(BaseModel):
    tickers: list[str]
    as_of_date: date
    include_candidates: bool = True


@app.post("/api/actions/ingest-live")
def ingest_live(req: IngestLiveRequest) -> dict:
    """Fetches real price data from EODHD and earnings/estimate/calendar data
    from Alpha Vantage for each ticker (and, if requested, eligibility candidates from
    Danelfin), upserts them, then runs the normal trigger-detection/scoring
    pipeline (episodes.run_episode) for each ticker against the freshly
    ingested data, so a live-ingested ticker actually shows up under
    Episodes or Insufficient-Data-Cases instead of just silently filling
    tables. Most freshly-ingested tickers will land in insufficient-data
    (missing the context group) until /api/actions/mark-context-reviewed is
    called for them -- that's the intended signal, not a bug. Best-effort
    per ticker -- one ticker's API error doesn't abort the batch; see
    src/ingestion/live.py for what each field means and which endpoints it's
    verified against.

    Does NOT itself fetch entry prices or track outcomes -- those need a
    real PriceDataSource that isn't wired up yet.

    Deliberately does NOT touch context_ingestion_coverage -- call
    /api/actions/mark-context-reviewed separately and explicitly once you've
    actually checked guidance/insider/material news for these tickers."""
    if not req.tickers:
        raise HTTPException(status_code=400, detail="tickers must be a non-empty list")

    logger.info("ingest-live start tickers=%s as_of=%s include_candidates=%s", req.tickers, req.as_of_date, req.include_candidates)

    conn = _conn()
    try:
        from src.ingestion.alpha_vantage import AlphaVantageClient
        av = AlphaVantageClient()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    try:
        price_client = EODHDClient()
    except EODHDConfigurationError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    price_results = []
    spy_series = None
    for ticker in req.tickers:
        try:
            if spy_series is None:
                # Fetch EODHD's benchmark history once and reuse it for every
                # ticker in this run. There is no Alpha Vantage price fallback:
                # its free daily history cannot provide the required MA200.
                spy_series = price_client.get_daily("SPY")
            price_results.append(
                ingest_price_and_earnings(conn, ticker, req.as_of_date, av, price_client=price_client, spy_series=spy_series)
            )
        except Exception as exc:
            logger.exception("ingest-live data fetch failed ticker=%s", ticker)
            price_results.append({"ticker": ticker, "wrote": {}, "warnings": [f"fetch failed entirely: {exc}"]})

    candidates_result = None
    if req.include_candidates:
        try:
            from src.ingestion.danelfin import DanelfinClient
            danelfin = DanelfinClient()
            candidates_result = ingest_candidates(conn, req.tickers, req.as_of_date, danelfin)
        except RuntimeError as exc:
            candidates_result = {"upserted": [], "warnings": [str(exc)]}

    episode_results: dict[str, list[str]] = {}
    for ticker in req.tickers:
        try:
            episode_results[ticker] = run_episode(conn, ticker, req.as_of_date)
        except Exception as exc:
            logger.exception("ingest-live episode pipeline failed ticker=%s", ticker)
            episode_results[ticker] = []
            price_result = next((r for r in price_results if r["ticker"] == ticker), None)
            if price_result is not None:
                price_result["warnings"].append(f"run_episode failed: {exc}")

    logger.info("ingest-live complete results=%s episodes=%s", price_results, episode_results)
    return {"price_and_earnings": price_results, "candidates": candidates_result, "episodes": episode_results}


class FetchCandidatesRequest(BaseModel):
    tickers: list[str]
    as_of_date: date


@app.post("/api/actions/fetch-candidates")
def fetch_candidates_endpoint(req: FetchCandidatesRequest) -> dict:
    """Dedicated, standalone, on-demand Danelfin eligibility-filter workflow
    (src/ingestion/candidate_selection.py:select_candidates()) -- distinct
    from /api/actions/ingest-live's bundled candidates step. Fetches and
    upserts `candidates` rows for `tickers` as of `as_of_date` and nothing
    else (no price/earnings fetch, no run_episode). Per spec Section 1,
    Danelfin is ELIGIBILITY-ONLY: nothing this writes is ever read by
    score_earnings/score_market/score_context/decide(). Runs once,
    synchronously, only for this request -- no scheduler/background job.
    Returns per-ticker success/skipped/failed accounting (see
    CandidateSelectionResult.to_dict()).

    If you already know a ticker and don't want to depend on Danelfin at
    all, use /api/actions/add-manual-candidate instead."""
    if not req.tickers:
        raise HTTPException(status_code=400, detail="tickers must be a non-empty list")

    conn = _conn()
    try:
        from src.ingestion.danelfin import DanelfinClient
        danelfin = DanelfinClient()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    from src.ingestion.candidate_selection import select_candidates
    result = select_candidates(conn, req.tickers, req.as_of_date, danelfin)
    return result.to_dict()


class AddManualCandidateRequest(BaseModel):
    tickers: list[str]
    as_of_date: date


@app.post("/api/actions/add-manual-candidate")
def add_manual_candidate_endpoint(req: AddManualCandidateRequest) -> dict:
    """Manual fallback for candidate eligibility (src/ingestion/
    candidate_selection.py:add_manual_candidates()) -- adds `tickers`
    straight into `candidates` with source='manual', no Danelfin call at
    all. Same table, same idempotent upsert, same downstream tracking
    pipeline (episodes.py's trigger detection doesn't treat 'manual' rows
    any differently from 'danelfin' ones) as /api/actions/fetch-candidates,
    for when you already know a ticker you want tracked and don't want to
    depend on Danelfin."""
    if not req.tickers:
        raise HTTPException(status_code=400, detail="tickers must be a non-empty list")

    conn = _conn()
    from src.ingestion.candidate_selection import add_manual_candidates
    result = add_manual_candidates(conn, req.tickers, req.as_of_date)
    return result.to_dict()


class FetchTradeIdeasRequest(BaseModel):
    as_of_date: date
    market: Optional[str] = None
    direction: Optional[str] = None
    asset_type: Optional[str] = None
    aiscore: Optional[float] = None
    fundamental: Optional[float] = None
    technical: Optional[float] = None
    sentiment: Optional[float] = None
    sector: Optional[str] = None
    industry: Optional[str] = None
    market_cap: Optional[str] = None
    limit: Optional[int] = None
    offset: Optional[int] = None


class FetchBestStocksRequest(BaseModel):
    as_of_date: date


@app.post("/api/actions/fetch-trade-ideas")
def fetch_trade_ideas_endpoint(req: FetchTradeIdeasRequest) -> dict:
    """THE primary, no-ticker-required candidate discovery workflow (src/
    ingestion/candidate_selection.py:fetch_trade_ideas_candidates()) --
    unlike /api/actions/fetch-candidates (which only evaluates tickers you
    already supply), this discovers candidates on its own from Danelfin
    Trade Ideas (GET /v3/trade-ideas, no ticker required). Every filter is
    optional; the direction is always forced to long because this workflow
    validates buy-side candidates. Runs once, synchronously, only for this request -- no
    scheduler/background job. Returns source/as_of_date/applied filters/
    total ideas returned/per-record success-skipped-failed accounting/a
    preview row per record/warnings (see TradeIdeasResult.to_dict()).

    Per spec Section 1, Danelfin is ELIGIBILITY-ONLY: nothing this writes is
    ever read by score_earnings/score_market/score_context/decide(). If you
    already know a ticker and don't want to depend on Danelfin at all, use
    /api/actions/add-manual-candidate instead; to evaluate specific
    already-known tickers against Danelfin's ranking (rather than
    discovering new ones), use /api/actions/fetch-candidates."""
    if req.direction is not None and req.direction.lower() != "long":
        raise HTTPException(status_code=400, detail="This application supports long Trade Ideas only; short ideas are not allowed.")

    conn = _conn()
    try:
        from src.ingestion.danelfin import DanelfinClient
        danelfin = DanelfinClient()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    from src.ingestion.candidate_selection import fetch_trade_ideas_candidates
    result = fetch_trade_ideas_candidates(
        conn, req.as_of_date, danelfin,
        market=req.market, direction=req.direction, asset_type=req.asset_type,
        aiscore=req.aiscore, fundamental=req.fundamental, technical=req.technical,
        sentiment=req.sentiment, sector=req.sector, industry=req.industry,
        market_cap=req.market_cap, limit=req.limit, offset=req.offset,
    )
    return result.to_dict()


@app.post("/api/actions/fetch-beststocks")
def fetch_beststocks_endpoint(req: FetchBestStocksRequest) -> dict:
    """Fetch and store Danelfin's official ranked Best Stocks snapshot."""
    conn = _conn()
    try:
        from src.ingestion.danelfin import DanelfinClient
        danelfin = DanelfinClient()
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    from src.ingestion.candidate_selection import fetch_best_stocks_candidates
    return fetch_best_stocks_candidates(conn, req.as_of_date, danelfin)


class BacktestRequest(BaseModel):
    start_date: date
    end_date: date
    top_n: int = 10


@app.post("/api/actions/run-backtest")
def run_backtest_endpoint(req: BacktestRequest) -> dict:
    """Start the cache-first historical backtest and return immediately."""
    with _BACKTEST_JOBS_LOCK:
        if any(job["status"] == "running" for job in _BACKTEST_JOBS.values()):
            raise HTTPException(status_code=409, detail="A backtest is already running")
        job_id = uuid.uuid4().hex
        _BACKTEST_JOBS[job_id] = {"job_id": job_id, "status": "running", "started_at": time.time(), "progress": {"phase": "queued", "message": "Queued"}}

    def execute() -> None:
        from src.backtest import run_backtest

        def update(progress: dict) -> None:
            with _BACKTEST_JOBS_LOCK:
                if job_id in _BACKTEST_JOBS:
                    _BACKTEST_JOBS[job_id]["progress"] = progress

        try:
            result = run_backtest(req.start_date, req.end_date, top_n=req.top_n, cache_path=os.environ.get("BACKTEST_DB_PATH"), progress=update)
            with _BACKTEST_JOBS_LOCK:
                _BACKTEST_JOBS[job_id].update({"status": "complete", "result": result, "finished_at": time.time()})
        except Exception as exc:
            logger.exception("Historical backtest failed")
            with _BACKTEST_JOBS_LOCK:
                _BACKTEST_JOBS[job_id].update({"status": "failed", "error": str(exc), "finished_at": time.time()})

    _BACKTEST_EXECUTOR.submit(execute)
    return {"job_id": job_id, "status": "running"}


@app.get("/api/actions/run-backtest/{job_id}")
def backtest_status_endpoint(job_id: str) -> dict:
    with _BACKTEST_JOBS_LOCK:
        job = _BACKTEST_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Backtest job not found")
        return dict(job)


class MarkContextReviewedRequest(BaseModel):
    tickers: list[str]
    as_of_date: date


@app.post("/api/actions/mark-context-reviewed")
def mark_context_reviewed_endpoint(req: MarkContextReviewedRequest) -> dict:
    """Explicit operator action: 'I checked guidance/insider/material news
    for these tickers through this date.' Never called automatically by
    ingest-live -- see the module docstring in src/ingestion/live.py for why
    auto-marking this would defeat the context-coverage-gap protection."""
    if not req.tickers:
        raise HTTPException(status_code=400, detail="tickers must be a non-empty list")
    conn = _conn()
    for ticker in req.tickers:
        mark_context_reviewed(conn, ticker, req.as_of_date)
    return {"marked": req.tickers, "as_of_date": req.as_of_date.isoformat()}
