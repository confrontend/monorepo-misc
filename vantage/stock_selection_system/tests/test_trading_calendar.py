from datetime import date, datetime, timezone

import pytest

from src.trading_calendar import TradingCalendar


@pytest.fixture(scope="module")
def cal():
    return TradingCalendar()


# -- is_trading_day -----------------------------------------------------------

def test_is_trading_day_weekday(cal):
    assert cal.is_trading_day(date(2026, 1, 6)) is True  # Tuesday


def test_is_trading_day_weekend(cal):
    assert cal.is_trading_day(date(2026, 1, 3)) is False  # Saturday
    assert cal.is_trading_day(date(2026, 1, 4)) is False  # Sunday


def test_is_trading_day_holiday(cal):
    assert cal.is_trading_day(date(2026, 1, 1)) is False  # New Year's Day
    assert cal.is_trading_day(date(2026, 1, 19)) is False  # MLK Day
    assert cal.is_trading_day(date(2026, 11, 26)) is False  # Thanksgiving


def test_is_trading_day_exceptional_closure(cal):
    # Hurricane Sandy closed NYSE for two full days.
    assert cal.is_trading_day(date(2012, 10, 29)) is False
    assert cal.is_trading_day(date(2012, 10, 30)) is False
    assert cal.is_trading_day(date(2012, 10, 31)) is True


# -- next_market_open_after: pre-open branch -----------------------------------

def test_next_open_before_todays_open_on_trading_day(cal):
    # 2026-01-06 open is 14:30 UTC. Decision at 10:00 UTC same day -> use today.
    ts = datetime(2026, 1, 6, 10, 0, tzinfo=timezone.utc)
    entry_date, entry_open = cal.next_market_open_after(ts)
    assert entry_date == date(2026, 1, 6)
    assert entry_open.hour == 14 and entry_open.minute == 30


# -- next_market_open_after: post-open branch ----------------------------------

def test_next_open_after_todays_open_on_trading_day(cal):
    # Decision at 18:00 UTC (after 14:30 open) -> use the NEXT session (1/7).
    ts = datetime(2026, 1, 6, 18, 0, tzinfo=timezone.utc)
    entry_date, entry_open = cal.next_market_open_after(ts)
    assert entry_date == date(2026, 1, 7)


# -- next_market_open_after: weekend/holiday branch ----------------------------

def test_next_open_on_weekend_rolls_forward(cal):
    ts = datetime(2026, 1, 3, 12, 0, tzinfo=timezone.utc)  # Saturday
    entry_date, entry_open = cal.next_market_open_after(ts)
    assert entry_date == date(2026, 1, 5)  # Monday


def test_next_open_on_holiday_rolls_forward(cal):
    ts = datetime(2026, 1, 1, 12, 0, tzinfo=timezone.utc)  # New Year's Day
    entry_date, entry_open = cal.next_market_open_after(ts)
    assert entry_date == date(2026, 1, 2)


def test_next_open_naive_timestamp_treated_as_utc(cal):
    ts = datetime(2026, 1, 6, 10, 0)  # naive
    entry_date, _ = cal.next_market_open_after(ts)
    assert entry_date == date(2026, 1, 6)


# -- add_trading_days: day-zero convention -------------------------------------

def test_add_trading_days_day_zero_convention(cal):
    # 2026-01-06 (Tue) is day 0. The 1st trading day after it is 2026-01-07.
    assert cal.add_trading_days(date(2026, 1, 6), 1) == date(2026, 1, 7)


def test_add_trading_days_seven(cal):
    entry_date = date(2026, 1, 6)
    result = cal.add_trading_days(entry_date, 7)
    # Manually count 7 sessions strictly after 2026-01-06:
    # 1/7, 1/8, 1/9, 1/12, 1/13, 1/14, 1/15
    assert result == date(2026, 1, 15)


def test_add_trading_days_skips_holiday(cal):
    # From 2026-01-16 (Fri), day 1 should skip the 1/17-1/18 weekend AND the
    # 1/19 MLK holiday, landing on 1/20.
    assert cal.add_trading_days(date(2026, 1, 16), 1) == date(2026, 1, 20)


def test_add_trading_days_rejects_nonpositive_n(cal):
    with pytest.raises(ValueError):
        cal.add_trading_days(date(2026, 1, 6), 0)


# -- trading_days_between -------------------------------------------------------

def test_trading_days_between_basic(cal):
    assert cal.trading_days_between(date(2026, 1, 6), date(2026, 1, 15)) == 7


def test_trading_days_between_same_day_is_zero(cal):
    assert cal.trading_days_between(date(2026, 1, 6), date(2026, 1, 6)) == 0


def test_trading_days_between_end_before_start_is_zero(cal):
    assert cal.trading_days_between(date(2026, 1, 6), date(2026, 1, 1)) == 0


# -- session_close --------------------------------------------------------------

def test_session_close_returns_close_timestamp(cal):
    close = cal.session_close(date(2026, 1, 6))
    assert close.hour == 21 and close.minute == 0


def test_session_close_returns_none_for_non_trading_day(cal):
    assert cal.session_close(date(2026, 1, 3)) is None  # Saturday
    assert cal.session_close(date(2026, 1, 1)) is None  # New Year's Day


# -- sessions_in_window ----------------------------------------------------------

def test_sessions_in_window_excludes_weekend_and_holiday(cal):
    sessions = cal.sessions_in_window(date(2026, 1, 1), date(2026, 1, 6))
    assert date(2026, 1, 1) not in sessions  # holiday
    assert date(2026, 1, 3) not in sessions  # Saturday
    assert date(2026, 1, 4) not in sessions  # Sunday
    assert sessions == [date(2026, 1, 2), date(2026, 1, 5), date(2026, 1, 6)]
