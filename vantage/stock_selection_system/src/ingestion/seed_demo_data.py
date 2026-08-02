"""
Synthetic ATI demo dataset.

The implementation prompt requires running the full pipeline end-to-end on
ticker ATI before adding other watchlist stocks, but this prototype has no
live Danelfin/Alpha Vantage API keys available in this environment (see
ingestion/alpha_vantage.py and ingestion/danelfin.py -- both are ready to use
once a real key is supplied). This module generates a deterministic, seeded
synthetic dataset -- a plausible ATI-like uptrend, a beat-and-raise earnings
scenario, and one guidance-raise Context event -- so the ENTIRE pipeline
(scoring -> decision -> immutable review -> entry pricing -> outcome
tracking -> report) can be exercised end-to-end without network access.

It also populates an InMemoryPriceSource with OPEN and CLOSE prices spanning
well past `as_of_date` (through the full 180-trading-day outcome horizon), so
the entry-price and outcome-tracking jobs have data to work with immediately
in the demo, without waiting on real calendar time to pass.
"""
from __future__ import annotations

import random
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Optional

from ..price_source import InMemoryPriceSource
from ..trading_calendar import TradingCalendar
from .base import (
    mark_context_coverage,
    upsert_candidate,
    upsert_earnings_history,
    upsert_estimate_snapshot,
    upsert_price_signal,
    upsert_security_metadata,
)
from .manual_events import add_earnings_calendar_entry, add_guidance_event

TICKER = "ATI"
SPY = "SPY"
SECTOR_TICKER = "XLI"

HISTORICAL_LOOKBACK_TRADING_DAYS = 260  # >= the 200 required + buffer
FUTURE_HORIZON_TRADING_DAYS = 190  # comfortably past the 180-day outcome horizon
PRE_BUFFER_CALENDAR_DAYS = 900  # ensures >=200 sessions of MA/return lookback exist


def _gbm_path(rng: random.Random, n: int, start_price: float, daily_drift: float, daily_vol: float) -> list[float]:
    prices = [start_price]
    for _ in range(n - 1):
        shock = rng.gauss(0, 1)
        next_price = prices[-1] * (1 + daily_drift + daily_vol * shock)
        prices.append(max(next_price, 0.01))
    return prices


@dataclass
class DemoSeedResult:
    candidate_id: int
    as_of_date: date
    sector_ticker: str = SECTOR_TICKER


def seed_demo_data(
    conn,
    price_source: InMemoryPriceSource,
    calendar: TradingCalendar,
    as_of_date: date,
    seed: int = 42,
) -> DemoSeedResult:
    if not calendar.is_trading_day(as_of_date):
        raise ValueError(f"as_of_date {as_of_date} must be a trading day.")

    rng = random.Random(seed)

    window_start = as_of_date - timedelta(days=PRE_BUFFER_CALENDAR_DAYS)
    window_end = as_of_date + timedelta(days=FUTURE_HORIZON_TRADING_DAYS * 2)  # generous calendar padding
    all_sessions = calendar.sessions_in_window(window_start, window_end)
    as_of_idx = all_sessions.index(as_of_date)
    if as_of_idx < 260:
        raise ValueError("Not enough historical sessions generated; widen PRE_BUFFER_CALENDAR_DAYS.")
    if len(all_sessions) - as_of_idx < FUTURE_HORIZON_TRADING_DAYS + 5:
        raise ValueError("Not enough future sessions generated; widen the future window.")

    n = len(all_sessions)
    ati_prices = _gbm_path(rng, n, start_price=45.0, daily_drift=0.0012, daily_vol=0.018)  # steady uptrend
    spy_prices = _gbm_path(rng, n, start_price=560.0, daily_drift=0.0004, daily_vol=0.008)  # modest market drift
    xli_prices = _gbm_path(rng, n, start_price=140.0, daily_drift=0.0006, daily_vol=0.010)

    volumes = [max(200_000, int(rng.gauss(1_000_000, 150_000))) for _ in range(n)]

    # -- price_source: opens/closes for the whole span, all three tickers ------------
    for i, d in enumerate(all_sessions):
        for ticker, path in ((TICKER, ati_prices), (SPY, spy_prices), (SECTOR_TICKER, xli_prices)):
            close = path[i]
            prev_close = path[i - 1] if i > 0 else close
            open_price = prev_close * (1 + rng.gauss(0, 0.002))
            price_source.set_open(ticker, d, round(open_price, 4))
            price_source.set_close(ticker, d, round(close, 4))

    # -- price_signals: last HISTORICAL_LOOKBACK_TRADING_DAYS sessions up to as_of ---
    hist_start_idx = as_of_idx - HISTORICAL_LOOKBACK_TRADING_DAYS + 1
    for i in range(hist_start_idx, as_of_idx + 1):
        d = all_sessions[i]
        close = ati_prices[i]
        ma_50 = sum(ati_prices[i - 49 : i + 1]) / 50
        ma_200 = sum(ati_prices[i - 199 : i + 1]) / 200
        ret_3m = close / ati_prices[i - 63] - 1
        spy_ret_3m = spy_prices[i] / spy_prices[i - 63] - 1
        avg_volume_30d = sum(volumes[i - 29 : i + 1]) / 30
        upsert_price_signal(
            conn, d, TICKER,
            close=round(close, 4), volume=volumes[i], avg_volume_30d=round(avg_volume_30d, 2),
            ma_50=round(ma_50, 4), ma_200=round(ma_200, 4), return_3m=round(ret_3m, 6),
            spy_return_3m=round(spy_ret_3m, 6),
        )

    # -- earnings: a beat-and-raise scenario --------------------------------------------
    report_idx = as_of_idx - 20  # ~20 trading days before as_of
    report_date = all_sessions[report_idx]
    upsert_earnings_history(
        conn, TICKER, report_date, fiscal_period="Q4-2025",
        actual_eps=1.15, estimated_eps=1.05,
    )

    # Daily next-quarter EPS estimate snapshots, monotonically rising, so the
    # 30-day-prior tolerance-window lookup always finds a same-fiscal-period
    # snapshot and the revision reads as "rose."
    for i in range(hist_start_idx, as_of_idx + 1):
        d = all_sessions[i]
        eps_estimate = round(0.90 + (i - hist_start_idx) * 0.0015, 4)
        upsert_estimate_snapshot(conn, d, TICKER, fiscal_period="Q1-2026", eps_estimate=eps_estimate, source="demo")

    # -- security metadata -----------------------------------------------------------
    upsert_security_metadata(
        conn, TICKER, company_name="Allegheny Technologies Incorporated",
        sector="Industrials", industry="Metals & Mining", sector_benchmark_ticker=SECTOR_TICKER,
    )

    # -- context: one guidance-raise event since the last earnings release -----------
    guidance_idx = as_of_idx - 10
    add_guidance_event(
        conn, TICKER, all_sessions[guidance_idx], "raised",
        detail="Raised FY guidance on strong aerospace demand.", source="demo",
    )

    # Confirm guidance/insider/material-event ingestion coverage through
    # as_of_date -- without this, check_required_inputs() cannot tell "we
    # checked and only found the one guidance raise above" from "we never
    # checked this ticker at all," and per the missing-data policy the latter
    # must route to insufficient_data_cases, not silently score as if clear.
    mark_context_coverage(conn, TICKER, as_of_date)

    # -- earnings calendar: next report safely more than 5 trading days out ----------
    next_report_idx = as_of_idx + 15
    add_earnings_calendar_entry(conn, TICKER, all_sessions[next_report_idx], confirmed=False, source="demo")

    # -- candidates: eligibility marker (Danelfin-style, not scored) -----------------
    candidate_date = all_sessions[as_of_idx - 25]
    candidate_id = upsert_candidate(
        conn, candidate_date, TICKER, source="danelfin", source_rank="top_decile",
        ai_score=8.7, technical_score=7.9, fundamental_score=8.1, expected_return=0.12,
    )

    return DemoSeedResult(candidate_id=candidate_id, as_of_date=as_of_date)
