"""
Live ingestion orchestration: pulls daily prices from EODHD and earnings,
forward EPS estimates, and the earnings calendar from AlphaVantageClient, and
DanelfinClient (eligibility-filter candidates), and writes into the schema
via the idempotent upsert_* helpers in base.py / manual_events.py.

Deliberately does NOT touch context_ingestion_coverage or guidance_events /
insider_purchases / material_events -- those stay manual/CSV per the spec
(Section 1), and there is no automated source for them here. Marking
"context checked for this ticker/date" is a separate, EXPLICIT operator
action (mark_context_reviewed() below, exposed as its own API
endpoint/button) -- it must never be inferred from a price/earnings fetch
succeeding, or the P1 "context coverage gap treated as no-news" fix would
be silently defeated for every live-ingested ticker.

Every function here is best-effort per ticker: one ticker's API error or
missing field does not abort the rest of a multi-ticker run. Callers get a
per-ticker result/warning list back to surface to an operator (see
api/main.py's /api/actions/ingest-live).
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from typing import Optional

from .alpha_vantage import AlphaVantageClient
from .base import (
    mark_context_coverage,
    upsert_candidate,
    upsert_earnings_history,
    upsert_estimate_snapshot,
    upsert_price_signal,
)
from .danelfin import DanelfinClient
from .manual_events import add_earnings_calendar_entry

SPY_TICKER = "SPY"
TRADING_DAYS_3M = 63  # ~3 trading months; matches return_3m's intent elsewhere in the codebase
MIN_BARS_FOR_PRICE_SIGNAL = 200  # required for ma_200 and the Market score
logger = logging.getLogger(__name__)


def _sma(closes: list[float], n: int) -> Optional[float]:
    if len(closes) < n:
        return None
    return sum(closes[-n:]) / n


def _return_over(closes: list[float], n: int) -> Optional[float]:
    if len(closes) <= n:
        return None
    return (closes[-1] / closes[-1 - n]) - 1


def _bars_as_of(series: dict[date, dict], as_of_date: date) -> list[tuple[date, dict]]:
    """Ascending (date, bar) pairs on or before as_of_date."""
    return sorted((d, bar) for d, bar in series.items() if d <= as_of_date)


def ingest_price_and_earnings(
    conn,
    ticker: str,
    as_of_date: date,
    av: AlphaVantageClient,
    price_client=None,
    spy_series: Optional[dict[date, dict]] = None,
) -> dict:
    """Fetches daily price history (ticker + SPY) from `price_client`, and
    EARNINGS/EARNINGS_ESTIMATES/EARNINGS_CALENDAR from Alpha Vantage (`av`),
    and upserts price_signals, earnings_history, estimate_snapshots, and
    earnings_calendar. Returns a summary dict:
    {ticker, wrote: {...bools...}, warnings: [...]}.

    `price_client` should be an EODHDClient in production. Any object with a
    `get_daily(ticker) -> {date: {open,high,low,close,volume}}` method works,
    which keeps this orchestration layer straightforward to unit test.

    `spy_series` lets a multi-ticker caller fetch SPY's price history ONCE
    per run and reuse it, instead of once per ticker -- matters for the free
    tier's tight rate limit."""
    if price_client is None:
        raise ValueError("price_client is required; use EODHDClient for daily price history")
    result = {
        "ticker": ticker,
        "wrote": {"price_signal": False, "earnings_history": False, "estimate_snapshots": False, "earnings_calendar": False},
        "warnings": [],
    }
    logger.info("live validation start ticker=%s as_of=%s", ticker, as_of_date)

    # --- price_signals -----------------------------------------------------
    try:
        logger.debug("fetching price history ticker=%s source=%s", ticker, type(price_client).__name__)
        ticker_series = price_client.get_daily(ticker, outputsize="full")
        if spy_series is None:
            logger.debug("fetching benchmark price history ticker=%s", SPY_TICKER)
            spy_series = price_client.get_daily(SPY_TICKER, outputsize="full")
    except Exception as exc:
        # Price failure must not prevent earnings/estimate/calendar ingestion.
        # The result will explicitly report missing price signals, while the
        # other evidence groups can still be collected and diagnosed.
        warning = f"price history fetch failed: {exc} -- price_signals not written"
        result["warnings"].append(warning)
        logger.exception("ticker=%s price history fetch failed; continuing with earnings data", ticker)
        ticker_series = {}
        spy_series = {}

    ticker_bars = _bars_as_of(ticker_series, as_of_date)
    spy_bars = _bars_as_of(spy_series, as_of_date)
    logger.info("price history ticker=%s bars=%d spy_bars=%d as_of=%s", ticker, len(ticker_bars), len(spy_bars), as_of_date)

    if len(ticker_bars) < MIN_BARS_FOR_PRICE_SIGNAL or len(spy_bars) < MIN_BARS_FOR_PRICE_SIGNAL:
        warning = (
            f"fewer than {MIN_BARS_FOR_PRICE_SIGNAL} trading days of price history available as of {as_of_date} "
            "-- price_signals not written"
        )
        result["warnings"].append(warning)
        logger.warning("ticker=%s price validation warning: %s", ticker, warning)
    else:
        closes = [bar["close"] for _, bar in ticker_bars]
        volumes = [bar["volume"] for _, bar in ticker_bars]
        spy_closes = [bar["close"] for _, bar in spy_bars]
        last_date, last_bar = ticker_bars[-1]

        ma_50 = _sma(closes, 50)
        ma_200 = _sma(closes, 200)
        avg_volume_30d = _sma(volumes, 30)
        return_3m = _return_over(closes, TRADING_DAYS_3M)
        spy_return_3m = _return_over(spy_closes, TRADING_DAYS_3M)

        if None in (ma_50, ma_200, avg_volume_30d, return_3m, spy_return_3m):
            warning = (
                "not enough price history yet for a full 50/200-day moving average or 3-month return "
                f"({len(ticker_bars)} sessions available) -- price_signals not written"
            )
            result["warnings"].append(warning)
            logger.warning("ticker=%s price validation warning: %s", ticker, warning)
        else:
            upsert_price_signal(
                conn, last_date, ticker,
                close=last_bar["close"], volume=last_bar["volume"], avg_volume_30d=avg_volume_30d,
                ma_50=ma_50, ma_200=ma_200, return_3m=return_3m, spy_return_3m=spy_return_3m,
            )
            result["wrote"]["price_signal"] = True

    # --- earnings_history ---------------------------------------------------
    try:
        earnings = av.get_earnings(ticker)
        reported = [
            q for q in earnings.get("quarterlyEarnings", [])
            if q.get("reportedEPS") not in (None, "None") and q.get("estimatedEPS") not in (None, "None")
            and datetime.strptime(q["reportedDate"], "%Y-%m-%d").date() <= as_of_date
        ]
        if reported:
            latest = max(reported, key=lambda q: q["reportedDate"])
            upsert_earnings_history(
                conn, ticker, latest["reportedDate"], latest["fiscalDateEnding"],
                actual_eps=float(latest["reportedEPS"]), estimated_eps=float(latest["estimatedEPS"]),
            )
            result["wrote"]["earnings_history"] = True
            logger.info("ticker=%s earnings_history written report_date=%s", ticker, latest["reportedDate"])
        else:
            warning = "no reported earnings on or before as_of_date"
            result["warnings"].append(warning)
            logger.warning("ticker=%s earnings warning: %s", ticker, warning)
    except Exception as exc:
        warning = f"EARNINGS fetch/parse failed: {exc}"
        result["warnings"].append(warning)
        logger.exception("ticker=%s earnings fetch failed", ticker)

    # --- estimate_snapshots (current + 30-days-ago, from ONE call) ---------
    # EARNINGS_ESTIMATES already computes the 30-day-ago comparison
    # server-side, so a single call gives both points needed by
    # required_inputs._check_earnings_inputs' tolerance-window lookup --
    # unlike the original design (accumulate one daily snapshot per day for
    # 30 days), this works on the very first live ingestion run.
    try:
        estimates_payload = av.get_earnings_estimates(ticker)
        upcoming = [
            e for e in estimates_payload.get("estimates", [])
            if e.get("horizon") == "fiscal quarter"
            and datetime.strptime(e["date"], "%Y-%m-%d").date() > as_of_date
        ]
        if upcoming:
            nearest = min(upcoming, key=lambda e: e["date"])
            fiscal_period = nearest["date"]
            eps_now = nearest.get("eps_estimate_average")
            eps_30d = nearest.get("eps_estimate_average_30_days_ago")
            wrote_now = wrote_30d = False
            if eps_now not in (None, "None"):
                upsert_estimate_snapshot(conn, as_of_date, ticker, fiscal_period, float(eps_now), source="alpha_vantage")
                wrote_now = True
            if eps_30d not in (None, "None"):
                upsert_estimate_snapshot(
                    conn, as_of_date - timedelta(days=30), ticker, fiscal_period, float(eps_30d), source="alpha_vantage",
                )
                wrote_30d = True
            if wrote_now and wrote_30d:
                result["wrote"]["estimate_snapshots"] = True
                logger.info("ticker=%s estimate snapshots written fiscal_period=%s", ticker, fiscal_period)
            else:
                warning = (
                    "EARNINGS_ESTIMATES was missing eps_estimate_average and/or _30_days_ago for the upcoming quarter"
                )
                result["warnings"].append(warning)
                logger.warning("ticker=%s estimates warning: %s", ticker, warning)
        else:
            warning = "no upcoming (unreported) quarterly estimate found in EARNINGS_ESTIMATES"
            result["warnings"].append(warning)
            logger.warning("ticker=%s estimates warning: %s", ticker, warning)
    except Exception as exc:
        warning = f"EARNINGS_ESTIMATES fetch/parse failed: {exc}"
        result["warnings"].append(warning)
        logger.exception("ticker=%s estimates fetch failed", ticker)

    # --- earnings_calendar (Wait-rule input) --------------------------------
    try:
        calendar_rows = av.get_earnings_calendar(ticker)
        upcoming_calendar = []
        for row in calendar_rows:
            report_date = row.get("reportDate") if isinstance(row, dict) else None
            if not report_date:
                continue
            try:
                parsed_report_date = datetime.strptime(report_date, "%Y-%m-%d").date()
            except (TypeError, ValueError):
                logger.warning("ticker=%s ignoring malformed earnings-calendar row reportDate=%r", ticker, report_date)
                continue
            if parsed_report_date >= as_of_date:
                upcoming_calendar.append(row)
        if upcoming_calendar:
            nearest = min(upcoming_calendar, key=lambda row: row["reportDate"])
            scheduled = nearest["reportDate"]
            # Dedup: earnings_calendar has no UNIQUE constraint (matches the
            # existing manual-CSV-import behavior in manual_events.py) --
            # guard against piling up duplicate rows on repeated live-ingest
            # runs for the same ticker/date ourselves.
            existing = conn.execute(
                "SELECT 1 FROM earnings_calendar WHERE ticker = ? AND scheduled_report_date = ?",
                (ticker, scheduled),
            ).fetchone()
            if existing is None:
                add_earnings_calendar_entry(conn, ticker, scheduled, confirmed=True, source="alpha_vantage")
            result["wrote"]["earnings_calendar"] = True
            logger.info("ticker=%s earnings calendar written report_date=%s", ticker, scheduled)
        else:
            warning = "no upcoming report date found in EARNINGS_CALENDAR"
            result["warnings"].append(warning)
            logger.warning("ticker=%s calendar warning: %s", ticker, warning)
    except Exception as exc:
        warning = f"EARNINGS_CALENDAR fetch/parse failed: {exc}"
        result["warnings"].append(warning)
        logger.exception("ticker=%s calendar fetch failed", ticker)

    logger.info("live validation complete ticker=%s wrote=%s warnings=%d", ticker, result["wrote"], len(result["warnings"]))
    return result


def ingest_candidates(conn, tickers: list[str], as_of_date: date, danelfin: DanelfinClient) -> dict:
    """Fetches Danelfin's eligibility-filter ranking for `tickers` and
    upserts each into `candidates`. Danelfin scores are NEVER treated as
    evidence (Section 1) -- this only decides eligibility. Best-effort per
    ticker: the real Danelfin response shape is unverified (see
    danelfin.py's docstring), so field extraction is defensive and a
    per-ticker failure is reported rather than raised."""
    result = {"upserted": [], "warnings": []}
    try:
        rows = danelfin.get_candidates(tickers, as_of=as_of_date)
    except Exception as exc:
        result["warnings"].append(f"Danelfin fetch failed for the whole batch: {exc}")
        return result

    for row in rows:
        ticker = row.get("ticker") if isinstance(row, dict) else None
        if not ticker:
            result["warnings"].append(f"a Danelfin row had no recognizable ticker: {row!r}")
            continue
        try:
            upsert_candidate(
                conn, as_of_date, ticker, source="danelfin",
                source_rank=row.get("rank") or row.get("source_rank"),
                ai_score=row.get("ai_score"),
                technical_score=row.get("technical_score"),
                fundamental_score=row.get("fundamental_score"),
                expected_return=row.get("expected_return"),
            )
            result["upserted"].append(ticker)
        except Exception as exc:
            result["warnings"].append(f"{ticker}: failed to upsert candidate ({exc}) -- raw row: {row!r}")

    return result


def mark_context_reviewed(conn, ticker: str, as_of_date: date) -> None:
    """Explicit, operator-invoked action asserting 'I checked
    guidance/insider/material news for this ticker through this date' --
    deliberately NOT called automatically by ingest_price_and_earnings() or
    ingest_candidates(), since there is no automated source for Context data
    (Section 1: guidance/insider/material events are manual/CSV entry
    points). Auto-marking coverage here would silently treat 'we never
    checked' as 'we checked and found nothing,' defeating the whole point of
    context_ingestion_coverage (see schema.sql and the P1 fix log in
    README.md)."""
    mark_context_coverage(conn, ticker, as_of_date)
