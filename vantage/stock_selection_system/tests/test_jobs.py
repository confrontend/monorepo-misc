from datetime import date, datetime, timedelta, timezone

import pytest

from src.db import init_db
from src.jobs.entry_price_job import run_entry_price_job
from src.jobs.outcome_tracking_job import run_outcome_tracking_job
from src.price_source import InMemoryPriceSource
from src.trading_calendar import TradingCalendar


@pytest.fixture()
def conn(tmp_path):
    return init_db(str(tmp_path / "t.db"))


@pytest.fixture(scope="module")
def cal():
    return TradingCalendar()


def _seed_review(conn, episode_id="ep-1", ticker="ATI", decision_ts="2026-01-06T10:00:00+00:00"):
    conn.execute(
        "INSERT INTO reviews (episode_id, decision_timestamp_utc, rule_version, review_date, "
        "ticker, episode_trigger, earnings_score, market_score, context_score, total_score, "
        "red_flag, earnings_within_5d, decision, confidence) VALUES (?, ?, 'v1', '2026-01-06', "
        "?, 'first_eligibility', 1, 1, 0, 2, 0, 0, 'Confirm', 'Confirm')",
        (episode_id, decision_ts, ticker),
    )
    conn.commit()


def _seed_security_metadata(conn, ticker="ATI", benchmark="XLI"):
    conn.execute(
        "INSERT INTO security_metadata (ticker, sector_benchmark_ticker) VALUES (?, ?)",
        (ticker, benchmark),
    )
    conn.commit()


# -- entry_price_job ---------------------------------------------------------------

def test_entry_job_skips_when_session_not_yet_open(conn, cal):
    # Decision at 10:00 UTC on 2026-01-06 (before 14:30 open) -> entry session
    # is 2026-01-06 itself. "now" is still before that open.
    _seed_review(conn, decision_ts="2026-01-06T10:00:00+00:00")
    _seed_security_metadata(conn)
    price_source = InMemoryPriceSource()
    now = datetime(2026, 1, 6, 12, 0, tzinfo=timezone.utc)
    written = run_entry_price_job(conn, price_source, calendar=cal, now=now)
    assert written == []
    assert conn.execute("SELECT COUNT(*) FROM episode_entries").fetchone()[0] == 0


def test_entry_job_waits_for_price_data(conn, cal):
    _seed_review(conn, decision_ts="2026-01-06T10:00:00+00:00")
    _seed_security_metadata(conn)
    price_source = InMemoryPriceSource()  # no prices set
    now = datetime(2026, 1, 6, 18, 0, tzinfo=timezone.utc)  # after open
    written = run_entry_price_job(conn, price_source, calendar=cal, now=now)
    assert written == []


def test_entry_job_writes_entry_once_open_and_data_available(conn, cal):
    _seed_review(conn, decision_ts="2026-01-06T10:00:00+00:00")
    _seed_security_metadata(conn)
    price_source = InMemoryPriceSource()
    price_source.set_open("ATI", date(2026, 1, 6), 50.0)
    price_source.set_open("SPY", date(2026, 1, 6), 500.0)
    price_source.set_open("XLI", date(2026, 1, 6), 120.0)
    now = datetime(2026, 1, 6, 18, 0, tzinfo=timezone.utc)
    written = run_entry_price_job(conn, price_source, calendar=cal, now=now)
    assert written == ["ep-1"]
    row = conn.execute("SELECT * FROM episode_entries WHERE episode_id = 'ep-1'").fetchone()
    assert row["entry_date"] == "2026-01-06"
    assert row["stock_entry_open"] == 50.0
    assert row["sector_benchmark_ticker"] == "XLI"


def test_entry_job_pre_open_decision_uses_same_day(conn, cal):
    _seed_review(conn, decision_ts="2026-01-06T10:00:00+00:00")
    _seed_security_metadata(conn)
    price_source = InMemoryPriceSource()
    price_source.set_open("ATI", date(2026, 1, 6), 50.0)
    price_source.set_open("SPY", date(2026, 1, 6), 500.0)
    price_source.set_open("XLI", date(2026, 1, 6), 120.0)
    now = datetime(2026, 1, 6, 15, 0, tzinfo=timezone.utc)  # after 14:30 open
    written = run_entry_price_job(conn, price_source, calendar=cal, now=now)
    assert written == ["ep-1"]
    row = conn.execute("SELECT entry_date FROM episode_entries WHERE episode_id = 'ep-1'").fetchone()
    assert row["entry_date"] == "2026-01-06"


def test_entry_job_post_open_decision_uses_next_session(conn, cal):
    _seed_review(conn, decision_ts="2026-01-06T18:00:00+00:00")  # after today's open
    _seed_security_metadata(conn)
    price_source = InMemoryPriceSource()
    price_source.set_open("ATI", date(2026, 1, 7), 51.0)
    price_source.set_open("SPY", date(2026, 1, 7), 501.0)
    price_source.set_open("XLI", date(2026, 1, 7), 121.0)
    now = datetime(2026, 1, 7, 18, 0, tzinfo=timezone.utc)
    written = run_entry_price_job(conn, price_source, calendar=cal, now=now)
    assert written == ["ep-1"]
    row = conn.execute("SELECT entry_date FROM episode_entries WHERE episode_id = 'ep-1'").fetchone()
    assert row["entry_date"] == "2026-01-07"


def test_entry_job_does_not_rewrite_existing_entry(conn, cal):
    _seed_review(conn, decision_ts="2026-01-06T10:00:00+00:00")
    _seed_security_metadata(conn)
    price_source = InMemoryPriceSource()
    price_source.set_open("ATI", date(2026, 1, 6), 50.0)
    price_source.set_open("SPY", date(2026, 1, 6), 500.0)
    price_source.set_open("XLI", date(2026, 1, 6), 120.0)
    now = datetime(2026, 1, 6, 18, 0, tzinfo=timezone.utc)
    run_entry_price_job(conn, price_source, calendar=cal, now=now)
    # Change the price source; a second run must not touch the existing row
    # (episode_entries is append-only and the trigger would reject an UPDATE).
    price_source.set_open("ATI", date(2026, 1, 6), 999.0)
    written_again = run_entry_price_job(conn, price_source, calendar=cal, now=now)
    assert written_again == []
    row = conn.execute("SELECT stock_entry_open FROM episode_entries WHERE episode_id = 'ep-1'").fetchone()
    assert row["stock_entry_open"] == 50.0


# -- outcome_tracking_job -----------------------------------------------------------

def _seed_entry(conn, episode_id="ep-1", entry_date="2026-01-06", stock_open=50.0, spy_open=500.0, sector_open=120.0, sector_ticker="XLI"):
    conn.execute(
        "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, spy_entry_open, "
        "sector_entry_open, sector_benchmark_ticker) VALUES (?, ?, ?, ?, ?, ?)",
        (episode_id, entry_date, stock_open, spy_open, sector_open, sector_ticker),
    )
    conn.commit()


def _after_close(cal, d):
    return cal.session_close(d) + timedelta(hours=1)


def test_outcome_job_skips_horizon_not_yet_elapsed(conn, cal):
    _seed_review(conn)
    _seed_entry(conn)
    price_source = InMemoryPriceSource()
    written = run_outcome_tracking_job(conn, price_source, calendar=cal, now=_after_close(cal, date(2026, 1, 7)))
    assert written == []


def test_outcome_job_writes_7_day_horizon_open_to_close(conn, cal):
    _seed_review(conn)
    _seed_entry(conn, stock_open=50.0, spy_open=500.0, sector_open=120.0)
    price_source = InMemoryPriceSource()
    exit_date = cal.add_trading_days(date(2026, 1, 6), 7)  # 2026-01-15
    price_source.set_close("ATI", exit_date, 55.0)
    price_source.set_close("SPY", exit_date, 510.0)
    price_source.set_close("XLI", exit_date, 121.2)

    written = run_outcome_tracking_job(conn, price_source, calendar=cal, now=_after_close(cal, exit_date))
    assert written == [("ep-1", 7)]
    row = conn.execute(
        "SELECT * FROM recommendation_outcomes WHERE episode_id = 'ep-1' AND horizon_days = 7"
    ).fetchone()
    assert row["exit_date"] == exit_date.isoformat()
    assert row["stock_return"] == pytest.approx(55.0 / 50.0 - 1)
    assert row["spy_return"] == pytest.approx(510.0 / 500.0 - 1)
    assert row["sector_return"] == pytest.approx(121.2 / 120.0 - 1)


def test_outcome_job_waits_for_price_data(conn, cal):
    _seed_review(conn)
    _seed_entry(conn)
    price_source = InMemoryPriceSource()
    exit_date = cal.add_trading_days(date(2026, 1, 6), 7)
    written = run_outcome_tracking_job(conn, price_source, calendar=cal, now=_after_close(cal, exit_date))
    assert written == []


def test_outcome_job_does_not_record_before_session_closes(conn, cal):
    # Regression test: exit_date's calendar date has arrived, but the
    # session hasn't closed yet -- a date-only check would wrongly treat
    # this as resolved and record a "closing price" that isn't final.
    _seed_review(conn)
    _seed_entry(conn)
    price_source = InMemoryPriceSource()
    exit_date = cal.add_trading_days(date(2026, 1, 6), 7)
    price_source.set_close("ATI", exit_date, 55.0)
    price_source.set_close("SPY", exit_date, 510.0)
    price_source.set_close("XLI", exit_date, 121.2)

    before_close = cal.session_close(exit_date) - timedelta(hours=1)
    written = run_outcome_tracking_job(conn, price_source, calendar=cal, now=before_close)
    assert written == []
    rows = conn.execute("SELECT * FROM recommendation_outcomes").fetchall()
    assert len(rows) == 0

    written = run_outcome_tracking_job(conn, price_source, calendar=cal, now=_after_close(cal, exit_date))
    assert written == [("ep-1", 7)]


def test_outcome_job_does_not_duplicate_existing_horizon_row(conn, cal):
    _seed_review(conn)
    _seed_entry(conn)
    price_source = InMemoryPriceSource()
    exit_date = cal.add_trading_days(date(2026, 1, 6), 7)
    price_source.set_close("ATI", exit_date, 55.0)
    price_source.set_close("SPY", exit_date, 510.0)
    price_source.set_close("XLI", exit_date, 121.2)
    now = _after_close(cal, exit_date)
    run_outcome_tracking_job(conn, price_source, calendar=cal, now=now)
    written_again = run_outcome_tracking_job(conn, price_source, calendar=cal, now=now)
    assert written_again == []
    rows = conn.execute(
        "SELECT * FROM recommendation_outcomes WHERE episode_id = 'ep-1' AND horizon_days = 7"
    ).fetchall()
    assert len(rows) == 1


def test_outcome_job_multiple_horizons_independently(conn, cal):
    _seed_review(conn)
    _seed_entry(conn)
    price_source = InMemoryPriceSource()
    exit_7 = cal.add_trading_days(date(2026, 1, 6), 7)
    exit_30 = cal.add_trading_days(date(2026, 1, 6), 30)
    price_source.set_close("ATI", exit_7, 55.0)
    price_source.set_close("SPY", exit_7, 510.0)
    price_source.set_close("XLI", exit_7, 121.2)

    # Only 7-day horizon has elapsed so far.
    written = run_outcome_tracking_job(conn, price_source, calendar=cal, now=_after_close(cal, exit_7))
    assert written == [("ep-1", 7)]

    # Now the 30-day horizon elapses too.
    price_source.set_close("ATI", exit_30, 60.0)
    price_source.set_close("SPY", exit_30, 520.0)
    price_source.set_close("XLI", exit_30, 123.0)
    written = run_outcome_tracking_job(conn, price_source, calendar=cal, now=_after_close(cal, exit_30))
    assert written == [("ep-1", 30)]

    horizons = {
        r["horizon_days"]
        for r in conn.execute("SELECT horizon_days FROM recommendation_outcomes WHERE episode_id = 'ep-1'")
    }
    assert horizons == {7, 30}
