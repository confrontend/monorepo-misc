"""
On-demand candidate-selection workflows: fetch Danelfin data and store it in
`candidates` via the existing idempotent upsert helper. Three ways in:

  - fetch_trade_ideas_candidates() -- the PRIMARY, no-ticker-required path.
    Discovers candidates automatically from Danelfin Trade Ideas
    (DanelfinClient.get_trade_ideas(), GET /v3/trade-ideas). Users should
    not need to already know which tickers to look at; this is what makes
    that true. Triggered via CLI (`python cli.py fetch-trade-ideas`), API
    (POST /api/actions/fetch-trade-ideas), or the UI's "Fetch Danelfin
    Trade Ideas" action.
  - select_candidates() -- evaluates a watchlist of ALREADY-KNOWN tickers
    against Danelfin's per-ticker ranking (GET /ranking?ticker=...). Useful
    when you want Danelfin's read on specific tickers, but does not
    discover anything on its own.
  - add_manual_candidates() -- fallback for a ticker you already know about
    and want tracked without depending on Danelfin at all.

Distinct from src/ingestion/live.py's bundled ingest_candidates() (which is
one step of the combined "fetch live data" action) -- all three functions
here are standalone, triggered directly, with per-record
success/skipped/failed accounting for auditability. episodes.py's trigger
detection treats every source identically for eligibility purposes (it only
checks that A candidates row exists as of a date, not which source or
function wrote it), so a Trade-Ideas-discovered, watchlist-evaluated, or
manually-added ticker all enter the exact same downstream tracking pipeline.

Per spec Section 1: Danelfin is an ELIGIBILITY FILTER ONLY. Nothing here (or
anywhere downstream that reads the `candidates` table) may feed a Danelfin
score into score_earnings/score_market/score_context/decide() -- those
remain governed entirely by src/scoring.py, which this module never touches.
This workflow only decides which (ticker, date) pairs become eligibility
candidates; episodes.py's detect_episode_trigger() is what later turns a new
candidates row into a "first_eligibility" trigger.

No scheduler/background job lives here or is started by anything in this
module -- everything runs exactly once, synchronously, only when called,
and returns.
"""
from __future__ import annotations

import json
import logging
import sqlite3
from dataclasses import dataclass, field
from datetime import date
from typing import Any, Optional

from .base import upsert_candidate

logger = logging.getLogger(__name__)
from .danelfin import DanelfinClient

TRADE_IDEAS_SOURCE = "danelfin_trade_ideas"


@dataclass
class CandidateSelectionResult:
    as_of_date: date
    requested: list[str]
    successful: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)

    @property
    def successful_count(self) -> int:
        return len(self.successful)

    @property
    def skipped_count(self) -> int:
        return len(self.skipped)

    @property
    def failed_count(self) -> int:
        return len(self.failed)

    def to_dict(self) -> dict:
        return {
            "as_of_date": self.as_of_date.isoformat(),
            "requested": self.requested,
            "successful": self.successful,
            "skipped": self.skipped,
            "failed": self.failed,
            "successful_count": self.successful_count,
            "skipped_count": self.skipped_count,
            "failed_count": self.failed_count,
        }


@dataclass
class ManualCandidateResult:
    as_of_date: date
    requested: list[str]
    added: list[str] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)

    @property
    def added_count(self) -> int:
        return len(self.added)

    @property
    def failed_count(self) -> int:
        return len(self.failed)

    def to_dict(self) -> dict:
        return {
            "as_of_date": self.as_of_date.isoformat(),
            "requested": self.requested,
            "added": self.added,
            "failed": self.failed,
            "added_count": self.added_count,
            "failed_count": self.failed_count,
        }


@dataclass
class TradeIdeaRecord:
    """One normalized row of a Trade Ideas fetch, for the UI's preview
    table -- included for EVERY record returned by Danelfin (not just the
    ones that made it into `candidates`), so the preview reflects the raw
    fetch and each row's `status` shows what happened to it."""
    index: int
    status: str  # "successful" | "skipped" | "failed"
    ticker: Optional[str] = None
    reason: Optional[str] = None
    source_rank: Optional[str] = None
    ai_score: Optional[float] = None
    technical_score: Optional[float] = None
    fundamental_score: Optional[float] = None
    expected_return: Optional[float] = None
    direction: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "status": self.status,
            "ticker": self.ticker,
            "reason": self.reason,
            "source_rank": self.source_rank,
            "ai_score": self.ai_score,
            "technical_score": self.technical_score,
            "fundamental_score": self.fundamental_score,
            "expected_return": self.expected_return,
            "direction": self.direction,
        }


@dataclass
class TradeIdeasResult:
    as_of_date: date
    source: str = TRADE_IDEAS_SOURCE
    filters: dict = field(default_factory=dict)
    total_ideas: int = 0
    successful: list[str] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)   # [{index, reason}]
    failed: list[dict] = field(default_factory=list)    # [{index, ticker, reason}]
    ideas: list[dict] = field(default_factory=list)      # preview rows (TradeIdeaRecord.to_dict()), one per record
    warnings: list[str] = field(default_factory=list)    # batch-level issues (e.g. the fetch itself failed)

    @property
    def successful_count(self) -> int:
        return len(self.successful)

    @property
    def skipped_count(self) -> int:
        return len(self.skipped)

    @property
    def failed_count(self) -> int:
        return len(self.failed)

    def to_dict(self) -> dict:
        return {
            "source": self.source,
            "as_of_date": self.as_of_date.isoformat(),
            "filters": self.filters,
            "total_ideas": self.total_ideas,
            "successful": self.successful,
            "skipped": self.skipped,
            "failed": self.failed,
            "ideas": self.ideas,
            "warnings": self.warnings,
            "successful_count": self.successful_count,
            "skipped_count": self.skipped_count,
            "failed_count": self.failed_count,
        }


def _safe_float(value) -> Optional[float]:
    """Coerces an optional numeric field defensively -- a malformed/odd
    value in ONE optional field (ai_score, technical_score,
    fundamental_score, expected_return) must not fail the whole ticker, per
    the "if available" wording in the spec for these fields. Missing/
    unparseable just becomes None, same as "not available"."""
    if value is None or value == "None" or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _extract_ticker(raw: dict) -> Optional[str]:
    """Trade Ideas records' exact key naming is unverified (see danelfin.py)
    -- try a few plausible variants rather than committing to one."""
    for key in ("ticker", "symbol", "Symbol", "Ticker"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().upper()
    return None


def _safe_raw_json(raw: Any) -> Optional[str]:
    """Best-effort JSON serialization of a raw source record for
    raw_source_data -- must never itself raise (a record containing
    something non-JSON-serializable shouldn't block storing the normalized
    fields), so falls back to str() on failure."""
    try:
        return json.dumps(raw)
    except (TypeError, ValueError):
        try:
            return str(raw)
        except Exception:
            return None


def select_candidates(
    conn: sqlite3.Connection,
    tickers: list[str],
    as_of_date: date,
    danelfin: DanelfinClient,
) -> CandidateSelectionResult:
    """Fetches and stores Danelfin eligibility-filter data for `tickers` as
    of `as_of_date`. Runs synchronously, once, only when called -- no
    scheduling/background execution.

    For each ticker, independently:
      1. Calls danelfin.get_candidate(ticker, as_of=as_of_date) -- one
         isolated HTTP request per ticker, so one ticker's network/HTTP
         failure can't lose results already fetched for others.
      2. A raised exception (network error, non-2xx status, bad JSON) is
         recorded as a FAILURE for that ticker (result.failed[ticker] =
         <error message>) -- never silently dropped -- and processing
         continues with the next ticker.
      3. An empty/None response (Danelfin has no ranking for this ticker
         today -- a legitimate, non-error outcome) is recorded as SKIPPED,
         not written to `candidates`, and processing continues.
      4. A non-empty, non-dict response (unexpected shape) is recorded as a
         FAILURE with the raw response included in the error message.
      5. Otherwise the row is normalized -- `ticker` is required (defaults
         to the requested ticker if the response is missing it, matching
         DanelfinClient's own force-injection); `source_rank`, `ai_score`,
         `technical_score`, `fundamental_score`, `expected_return` are each
         read defensively and left None if absent/unparseable ("if
         available" per spec) -- and upserted via upsert_candidate() with
         source='danelfin'. A failure during the upsert itself (e.g. a
         database error) is also recorded as a FAILURE for that ticker, not
         raised, so it doesn't abort the rest of the batch.
      6. Success is recorded (result.successful) only once the row has
         actually been written.

    Idempotent: upsert_candidate() relies on candidates' UNIQUE(date,
    ticker, source) constraint (ON CONFLICT ... DO UPDATE) -- re-running
    this exact request (same tickers/as_of_date) updates the existing rows
    in place rather than creating duplicates or raising a constraint error.

    Danelfin data is eligibility-only: nothing written here is ever read by
    score_earnings/score_market/score_context/decide() (src/scoring.py) --
    see the module docstring."""
    requested = list(tickers)
    result = CandidateSelectionResult(as_of_date=as_of_date, requested=requested)

    for ticker in requested:
        try:
            row = danelfin.get_candidate(ticker, as_of=as_of_date)
        except Exception as exc:
            result.failed[ticker] = f"Danelfin request failed: {exc}"
            continue

        if row is None or (isinstance(row, dict) and not row):
            result.skipped.append(ticker)
            continue

        if not isinstance(row, dict):
            result.failed[ticker] = (
                f"unexpected response shape (expected an object, got {type(row).__name__}): {row!r}"
            )
            continue

        row_ticker = row.get("ticker") or ticker
        if not row_ticker:
            result.failed[ticker] = f"response had no recognizable ticker field: {row!r}"
            continue

        source_rank = row.get("rank") or row.get("source_rank")
        ai_score = _safe_float(row.get("ai_score"))
        technical_score = _safe_float(row.get("technical_score"))
        fundamental_score = _safe_float(row.get("fundamental_score"))
        expected_return = _safe_float(row.get("expected_return"))

        try:
            upsert_candidate(
                conn, as_of_date, ticker, source="danelfin",
                source_rank=source_rank, ai_score=ai_score,
                technical_score=technical_score, fundamental_score=fundamental_score,
                expected_return=expected_return,
            )
        except Exception as exc:
            result.failed[ticker] = f"failed to store candidate: {exc}"
            continue

        result.successful.append(ticker)

    return result


def add_manual_candidates(
    conn: sqlite3.Connection,
    tickers: list[str],
    as_of_date: date,
) -> ManualCandidateResult:
    """Manual fallback (no Danelfin call at all): lets an operator who
    already knows a ticker they want tracked add it straight into
    `candidates` with source='manual'. Uses the same idempotent
    upsert_candidate() helper and the same UNIQUE(date, ticker, source)
    constraint as the Danelfin path in select_candidates() above --
    re-adding the same ticker/date is a safe no-op/update, not a duplicate
    or an error.

    Per-ticker isolation, same as select_candidates(): a blank/invalid
    ticker or a database error for one ticker is recorded in
    result.failed[ticker] and does not stop the rest of the batch from
    being added. There are no scores to validate here (a manual entry has
    no Danelfin data by definition) -- source_rank/ai_score/technical_score/
    fundamental_score/expected_return are simply left NULL."""
    requested = list(tickers)
    result = ManualCandidateResult(as_of_date=as_of_date, requested=requested)

    for raw_ticker in requested:
        ticker = (raw_ticker or "").strip().upper()
        if not ticker:
            result.failed[raw_ticker or "<blank>"] = "ticker must be a non-empty string"
            continue
        try:
            upsert_candidate(conn, as_of_date, ticker, source="manual")
        except Exception as exc:
            result.failed[ticker] = f"failed to store candidate: {exc}"
            continue
        result.added.append(ticker)

    return result


def fetch_trade_ideas_candidates(
    conn: sqlite3.Connection,
    as_of_date: date,
    danelfin: DanelfinClient,
    market: Optional[str] = None,
    direction: Optional[str] = None,
    asset_type: Optional[str] = None,
    aiscore: Optional[float] = None,
    fundamental: Optional[float] = None,
    technical: Optional[float] = None,
    sentiment: Optional[float] = None,
    sector: Optional[str] = None,
    industry: Optional[str] = None,
    market_cap: Optional[str] = None,
    limit: Optional[int] = None,
    offset: Optional[int] = None,
) -> TradeIdeasResult:
    """THE primary, long-only candidate discovery workflow. It always calls
    Danelfin with direction='long', regardless of the caller's optional
    direction argument, then normalizes and upserts every returned long record into
    `candidates` with source='danelfin_trade_ideas', and reports exactly
    what happened to each one.

    Unlike select_candidates() (which isolates failures PER TICKER because
    it makes one HTTP call per ticker), the Trade Ideas fetch itself is ONE
    call (internally paginated by the client) -- so a failure fetching Trade
    Ideas at all (network error, auth failure, missing API key upstream,
    unrecognized response shape) is recorded as a batch-level entry in
    result.warnings and the function returns early with zero
    successful/skipped/failed records, rather than raising. If the fetch
    partially succeeds -- pagination fetched one or more pages, then a LATER
    page failed (LIVE-CONFIRMED: Danelfin can 429 a back-to-back pagination
    request) -- danelfin.get_trade_ideas() returns the pages fetched so far
    instead of raising; that's recorded here as a result.warnings entry
    ("...fetch was truncated: ...") and every record from the successfully
    fetched pages is still processed normally below, not discarded. Once the
    fetch returns (fully or partially), each individual RECORD in it is then
    classified independently:

      - Not a dict at all (malformed record) -> FAILED, with the raw value
        included in the reason.
      - A dict with no recognizable ticker field (see _extract_ticker) ->
        SKIPPED -- structurally fine, just nothing to store a candidate
        against.
      - A dict with a usable ticker -> normalized (source_rank, ai_score,
        technical_score, fundamental_score, expected_return, direction all
        read defensively and left None if absent/unparseable -- LIVE-CONFIRMED:
        a real Danelfin Trade Ideas record has `aiscore`/`fundamental`/
        `technical` fields (handled via a fallback chain), but NO `rank`,
        `expected_return`, or `direction` field at all, so those three
        columns are NULL for every Trade-Ideas-sourced row today; the full
        raw record -- including the many fields not normalized into their
        own column, e.g. sector/industry, win_rate_1y, avg_alpha_1y, aum --
        is preserved as JSON in raw_source_data) and upserted. A
        database error during the upsert itself is caught and recorded as
        FAILED for that record rather than raised, so it doesn't abort the
        rest of the batch -- SUCCESSFUL only once the row is actually
        written.

    Every record (successful, skipped, or failed) gets one entry in
    result.ideas -- a flat, order-preserving preview list meant for the
    UI's preview table, so the operator can see exactly what came back and
    what happened to each row, not just the ones that made it into
    `candidates`.

    Idempotent, same as the other functions here: upsert_candidate() relies
    on candidates' UNIQUE(date, ticker, source) constraint -- re-running the
    same fetch (e.g. the same day, similar filters returning overlapping
    tickers) updates existing rows in place. If the SAME ticker appears
    more than once within a single Trade Ideas response (e.g. under
    different directions), later records win for that (date, ticker,
    source) -- still exactly one row, never a duplicate or an error.

    Once written, a new candidates row is picked up by
    episodes.py:detect_episode_trigger() exactly like any other source's --
    Danelfin Trade Ideas data is eligibility-only and is never read by
    score_earnings/score_market/score_context/decide()."""
    # This application validates stocks for bullish/long decisions. Never
    # allow the mixed-direction or short Trade Ideas feed into that workflow.
    direction = "long"
    filters = {
        "market": market, "direction": direction, "asset_type": asset_type,
        "aiscore": aiscore, "fundamental": fundamental, "technical": technical,
        "sentiment": sentiment, "sector": sector, "industry": industry, "market_cap": market_cap,
    }
    filters = {k: v for k, v in filters.items() if v is not None}
    if limit is not None:
        filters["limit"] = limit
    if offset is not None:
        filters["offset"] = offset

    result = TradeIdeasResult(as_of_date=as_of_date, source=TRADE_IDEAS_SOURCE, filters=filters)

    call_kwargs = dict(filters)
    try:
        raw_ideas = danelfin.get_trade_ideas(**call_kwargs)
    except Exception as exc:
        result.warnings.append(f"Danelfin Trade Ideas fetch failed: {exc}")
        return result

    # get_trade_ideas() may return a partial result if pagination stopped
    # early after at least one page fetched successfully (e.g. Danelfin
    # rate-limiting a later page) -- surface that as a warning rather than
    # silently ignoring it, but still process whatever WAS fetched below
    # instead of discarding it (that's the whole point: don't lose results
    # already in hand just because a later page failed).
    partial_error = getattr(raw_ideas, "partial_error", None)
    if partial_error:
        result.warnings.append(f"Danelfin Trade Ideas fetch was truncated: {partial_error}")

    result.total_ideas = len(raw_ideas)
    logger.info("Danelfin Trade Ideas returned records=%d", result.total_ideas)

    for i, raw in enumerate(raw_ideas):
        if not isinstance(raw, dict):
            reason = f"unexpected record shape (expected an object, got {type(raw).__name__}): {raw!r}"
            result.failed.append({"index": i, "ticker": None, "reason": reason})
            result.ideas.append(TradeIdeaRecord(index=i, status="failed", reason=reason).to_dict())
            continue

        ticker = _extract_ticker(raw)
        if not ticker:
            reason = f"no recognizable ticker field: {raw!r}"
            result.skipped.append({"index": i, "reason": reason})
            result.ideas.append(TradeIdeaRecord(index=i, status="skipped", reason=reason).to_dict())
            continue

        source_rank = raw.get("rank") or raw.get("source_rank")
        ai_score = _safe_float(raw.get("ai_score") if raw.get("ai_score") is not None else raw.get("aiscore"))
        technical_score = _safe_float(
            raw.get("technical_score") if raw.get("technical_score") is not None else raw.get("technical")
        )
        fundamental_score = _safe_float(
            raw.get("fundamental_score") if raw.get("fundamental_score") is not None else raw.get("fundamental")
        )
        expected_return = _safe_float(raw.get("expected_return"))
        raw_direction = raw.get("direction")
        if raw_direction is not None and str(raw_direction).strip().lower() != "long":
            reason = f"short/non-long Trade Idea rejected by long-only workflow: {raw_direction!r}"
            result.skipped.append({"index": i, "ticker": ticker, "reason": reason})
            result.ideas.append(TradeIdeaRecord(index=i, status="skipped", ticker=ticker, reason=reason, direction=str(raw_direction)).to_dict())
            continue
        # Danelfin's live Trade Ideas payload does not echo direction. The
        # value is still known because the request above is hard-filtered.
        idea_direction = "long"
        raw_json = _safe_raw_json(raw)

        logger.debug(
            "Danelfin Trade Ideas normalization index=%d ticker=%s raw_keys=%s "
            "rank_present=%s direction_present=%s normalized_rank=%r normalized_direction=%r "
            "ai_score=%r technical_score=%r fundamental_score=%r",
            i,
            ticker,
            sorted(str(key) for key in raw.keys()),
            any(key in raw for key in ("rank", "source_rank")),
            "direction" in raw,
            source_rank,
            idea_direction,
            ai_score,
            technical_score,
            fundamental_score,
        )

        try:
            upsert_candidate(
                conn, as_of_date, ticker, source=TRADE_IDEAS_SOURCE,
                source_rank=source_rank, ai_score=ai_score,
                technical_score=technical_score, fundamental_score=fundamental_score,
                expected_return=expected_return, direction=idea_direction, raw_source_data=raw_json,
            )
        except Exception as exc:
            reason = f"failed to store candidate: {exc}"
            result.failed.append({"index": i, "ticker": ticker, "reason": reason})
            result.ideas.append(TradeIdeaRecord(index=i, status="failed", ticker=ticker, reason=reason).to_dict())
            continue

        result.successful.append(ticker)
        result.ideas.append(TradeIdeaRecord(
            index=i, status="successful", ticker=ticker, source_rank=source_rank,
            ai_score=ai_score, technical_score=technical_score, fundamental_score=fundamental_score,
            expected_return=expected_return, direction=idea_direction,
        ).to_dict())

    return result


def fetch_best_stocks_candidates(
    conn: sqlite3.Connection,
    as_of_date: date,
    danelfin: DanelfinClient,
) -> dict:
    """Fetch and store the official Danelfin Best Stocks ranked snapshot."""
    result = {"source": "danelfin_beststocks", "as_of_date": as_of_date.isoformat(), "successful": [], "failed": {}, "stocks": [], "warnings": []}
    try:
        rows = danelfin.get_best_stocks()
    except Exception as exc:
        result["warnings"].append(f"Danelfin Best Stocks fetch failed: {exc}")
        return result

    logger.info("Danelfin Best Stocks returned records=%d", len(rows))
    for index, raw in enumerate(rows):
        ticker = str(raw.get("ticker") or "").strip().upper() if isinstance(raw, dict) else ""
        if not ticker:
            result["failed"][str(index)] = "record had no ticker"
            continue
        rank = raw.get("rank")
        normalized = {
            "ticker": ticker,
            "rank": rank,
            "ai_score": _safe_float(raw.get("aiscore")),
            "technical_score": _safe_float(raw.get("technical")),
            "fundamental_score": _safe_float(raw.get("fundamental")),
            "sentiment_score": _safe_float(raw.get("sentiment")),
            "low_risk_score": _safe_float(raw.get("low_risk")),
            "perf_ytd": _safe_float(raw.get("perf_ytd")),
            "source_date": raw.get("date"),
        }
        logger.debug(
            "Danelfin Best Stocks normalization index=%d ticker=%s raw_keys=%s rank=%r ai_score=%r",
            index, ticker, sorted(str(key) for key in raw.keys()), rank, normalized["ai_score"],
        )
        try:
            upsert_candidate(
                conn, as_of_date, ticker, source="danelfin_beststocks",
                source_rank=str(rank) if rank is not None else None,
                ai_score=normalized["ai_score"],
                technical_score=normalized["technical_score"],
                fundamental_score=normalized["fundamental_score"],
                raw_source_data=_safe_raw_json(raw),
            )
            result["successful"].append(ticker)
            result["stocks"].append(normalized)
        except Exception as exc:
            result["failed"][ticker] = f"failed to store candidate: {exc}"
    return result
