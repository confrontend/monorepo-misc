"""
Single shared trading-calendar module.

Per stock_selection_frozen_spec.md Section 6: every trading-day-based rule in the
system (5-trading-day earnings window, 5-trading-day insider clustering window,
entry-price timing, 7/30/90/180 trading-day outcome horizons) must be computed
from this one module. Do not recompute trading-day math anywhere else.

Backed by `pandas_market_calendars` (a maintained exchange-calendar library) using
the NYSE calendar, which correctly accounts for weekends, U.S. market holidays,
and exceptional closures (e.g. 9/11 closures, hurricane closures, national days of
mourning) without hand-rolled holiday logic.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Optional

import pandas as pd
import pandas_market_calendars as mcal


def _to_date(d) -> date:
    if isinstance(d, datetime):
        return d.date()
    if isinstance(d, date):
        return d
    return pd.Timestamp(d).date()


def _to_utc_timestamp(ts) -> pd.Timestamp:
    """Coerce input to a tz-aware (UTC) pandas Timestamp. Naive datetimes are
    assumed to already be UTC, since the spec's `decision_timestamp_utc` is UTC
    by definition."""
    t = pd.Timestamp(ts)
    if t.tzinfo is None:
        t = t.tz_localize("UTC")
    else:
        t = t.tz_convert("UTC")
    return t


class TradingCalendar:
    """Shared trading-calendar service. One instance should be constructed and
    reused (e.g. as a module-level singleton or injected dependency) across
    score_earnings, score_context, the entry-price job, and the outcome-tracking
    job, rather than each recomputing trading-day math independently."""

    def __init__(self, exchange: str = "NYSE", cache_years_ahead: int = 2, cache_years_behind: int = 15):
        self._cal = mcal.get_calendar(exchange)
        self._cache_years_ahead = cache_years_ahead
        self._cache_years_behind = cache_years_behind
        self._schedule: Optional[pd.DataFrame] = None
        self._cache_start: Optional[date] = None
        self._cache_end: Optional[date] = None

    # -- internal schedule cache -------------------------------------------------

    def _ensure_cached(self, start: date, end: date) -> None:
        pad_start = start - timedelta(days=30)
        pad_end = end + timedelta(days=30)
        if (
            self._schedule is not None
            and self._cache_start is not None
            and self._cache_end is not None
            and self._cache_start <= pad_start
            and self._cache_end >= pad_end
        ):
            return
        new_start = min(pad_start, self._cache_start) if self._cache_start else pad_start
        new_end = max(pad_end, self._cache_end) if self._cache_end else pad_end
        self._schedule = self._cal.schedule(start_date=new_start, end_date=new_end)
        self._cache_start = new_start
        self._cache_end = new_end

    def _schedule_window(self, start: date, end: date) -> pd.DataFrame:
        self._ensure_cached(start, end)
        idx = self._schedule.index
        mask = (idx.date >= start) & (idx.date <= end)
        return self._schedule.loc[mask]

    # -- public API ----------------------------------------------------------

    def is_trading_day(self, d) -> bool:
        d = _to_date(d)
        window = self._schedule_window(d, d)
        return len(window) > 0

    def next_market_open_after(self, timestamp_utc) -> tuple[date, datetime]:
        """
        Returns (entry_date, market_open_timestamp) for the applicable entry session.

        Frozen rules (spec Section 6 / implementation prompt):
        - If timestamp_utc is before that calendar day's market open, and that day
          is a trading day, use THAT day's open.
        - If timestamp_utc is at or after that day's market open, use the NEXT
          trading session's open.
        - If the applicable day is a weekend/holiday, roll forward to the next
          available trading session's open.
        """
        ts = _to_utc_timestamp(timestamp_utc)
        today = ts.date()
        # Look far enough ahead to always find at least two sessions
        # (handles multi-day holiday runs).
        window = self._schedule_window(today, today + timedelta(days=21))
        if window.empty:
            raise ValueError(f"No trading sessions found in window starting {today}; extend calendar range.")

        first_session_date = window.index[0].date()
        first_open = window.iloc[0]["market_open"].to_pydatetime()

        if first_session_date == today:
            # Today is itself a trading day.
            if ts < window.iloc[0]["market_open"]:
                return today, first_open
            # At/after today's open -> use the NEXT trading session.
            if len(window) < 2:
                raise ValueError("Not enough cached sessions to find the next session; extend calendar range.")
            next_date = window.index[1].date()
            next_open = window.iloc[1]["market_open"].to_pydatetime()
            return next_date, next_open

        # today is a weekend/holiday (or otherwise not a session) -> roll forward
        # to the next available trading session.
        return first_session_date, first_open

    def session_close(self, d) -> Optional[datetime]:
        """Returns the market-close timestamp (UTC) for trading day `d`, or
        None if `d` is not a trading day. Used by the outcome-tracking job to
        confirm a session has actually closed before treating a same-day exit
        as resolved -- a date-only comparison can't tell "today, before the
        close" from "today, after the close.\""""
        d = _to_date(d)
        window = self._schedule_window(d, d)
        if window.empty:
            return None
        return window.iloc[0]["market_close"].to_pydatetime()

    def add_trading_days(self, d, n: int) -> date:
        """Returns the date of the n-th trading session strictly after `date`.
        `date` itself is day 0 and is never counted toward n --
        add_trading_days(entry_date, 7) returns the 7th trading session after
        entry_date, not entry_date plus 6 more sessions."""
        if n <= 0:
            raise ValueError("n must be a positive integer")
        d = _to_date(d)
        # Trading sessions occur at most every calendar day; n trading days is
        # comfortably within n*2 + 30 calendar days even across long holiday runs.
        window = self._schedule_window(d, d + timedelta(days=n * 2 + 30))
        after = window[window.index.date > d]
        if len(after) < n:
            # extend further just in case (e.g. very large n)
            window = self._schedule_window(d, d + timedelta(days=n * 3 + 60))
            after = window[window.index.date > d]
        if len(after) < n:
            raise ValueError(f"Not enough trading sessions found after {d} to satisfy n={n}.")
        return after.index[n - 1].date()

    def trading_days_between(self, start_date, end_date) -> int:
        """Number of trading sessions strictly after start_date, up to and
        including end_date. 0 if end_date <= start_date (same day or earlier)."""
        start_date = _to_date(start_date)
        end_date = _to_date(end_date)
        if end_date <= start_date:
            return 0
        window = self._schedule_window(start_date, end_date)
        after = window[(window.index.date > start_date) & (window.index.date <= end_date)]
        return len(after)

    def sessions_in_window(self, start_date, end_date) -> list[date]:
        """All trading-session dates in [start_date, end_date], inclusive."""
        start_date = _to_date(start_date)
        end_date = _to_date(end_date)
        if end_date < start_date:
            return []
        window = self._schedule_window(start_date, end_date)
        return [ts.date() for ts in window.index]


# Module-level singleton for convenience; callers may also construct their own.
default_calendar = TradingCalendar()
