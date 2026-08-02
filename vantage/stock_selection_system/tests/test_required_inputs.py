from datetime import date, timedelta

import pytest

from src.db import init_db
from src.ingestion.base import mark_context_coverage
from src.required_inputs import (
    check_required_inputs,
    record_insufficient_data_case,
    retry_insufficient_data,
)
from src.trading_calendar import TradingCalendar

_CAL = TradingCalendar()


@pytest.fixture()
def conn(tmp_path):
    return init_db(str(tmp_path / "t.db"))


def _seed_full_market_history(conn, ticker="ATI", as_of=date(2026, 2, 1), n_trading_days=210):
    # Seeded on REAL trading sessions (not one row per calendar day) so the
    # 200-trading-day check -- which now validates each date against the
    # shared calendar rather than trusting a raw row count -- is satisfied
    # with a real margin instead of silently counting weekend rows.
    sessions = _CAL.sessions_in_window(as_of - timedelta(days=450), as_of - timedelta(days=1))
    sessions = sessions[-n_trading_days:]
    for d in sessions:
        conn.execute(
            "INSERT INTO price_signals (date, ticker, close, volume, avg_volume_30d, ma_50, "
            "ma_200, return_3m, excess_return_3m, spy_return_3m, high_volume_breakdown) "
            "VALUES (?, ?, 100.0, 1000000, 900000, 98.0, 95.0, 0.05, 0.03, 0.02, 0)",
            (d.isoformat(), ticker),
        )
    conn.commit()


def _seed_context_coverage(conn, ticker="ATI", as_of=date(2026, 2, 1)):
    mark_context_coverage(conn, ticker, as_of)


def _seed_earnings(conn, ticker="ATI"):
    conn.execute(
        "INSERT INTO earnings_history (ticker, report_date, fiscal_period, actual_eps, "
        "estimated_eps) VALUES (?, '2026-01-15', 'Q4-2025', 1.10, 1.00)",
        (ticker,),
    )
    conn.execute(
        "INSERT INTO estimate_snapshots (date, ticker, fiscal_period, eps_estimate, source) "
        "VALUES ('2026-01-02', ?, 'Q1-2026', 1.02, 'test')",
        (ticker,),
    )
    conn.execute(
        "INSERT INTO estimate_snapshots (date, ticker, fiscal_period, eps_estimate, source) "
        "VALUES ('2026-01-31', ?, 'Q1-2026', 1.05, 'test')",
        (ticker,),
    )
    conn.commit()


def _seed_security_metadata(conn, ticker="ATI"):
    conn.execute(
        "INSERT INTO security_metadata (ticker, company_name, sector, industry, "
        "sector_benchmark_ticker) VALUES (?, 'Allegheny Technologies', 'Industrials', "
        "'Metals', 'XLI')",
        (ticker,),
    )
    conn.commit()


def _seed_earnings_calendar(conn, ticker="ATI", scheduled="2026-04-15"):
    conn.execute(
        "INSERT INTO earnings_calendar (ticker, scheduled_report_date, confirmed) "
        "VALUES (?, ?, 1)",
        (ticker, scheduled),
    )
    conn.commit()


def _seed_everything(conn, as_of=date(2026, 2, 1)):
    _seed_full_market_history(conn, as_of=as_of)
    _seed_earnings(conn)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    _seed_context_coverage(conn, as_of=as_of)


def test_all_present_is_ok(conn):
    _seed_everything(conn)
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is True
    assert result.missing == []
    assert result.resolved.eps_estimate_30d_ago == 1.02
    assert result.resolved.eps_estimate_now == 1.05


def test_missing_earnings_history_flagged(conn):
    _seed_full_market_history(conn)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    assert any(g == "earnings" for g, _ in result.missing)


def test_missing_30d_prior_estimate_outside_tolerance_flagged(conn):
    _seed_full_market_history(conn)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    conn.execute(
        "INSERT INTO earnings_history (ticker, report_date, fiscal_period, actual_eps, "
        "estimated_eps) VALUES ('ATI', '2026-01-15', 'Q4-2025', 1.10, 1.00)"
    )
    # Only a "now" snapshot; no snapshot in [as_of-35, as_of-30].
    conn.execute(
        "INSERT INTO estimate_snapshots (date, ticker, fiscal_period, eps_estimate, source) "
        "VALUES ('2026-01-31', 'ATI', 'Q1-2026', 1.05, 'test')"
    )
    conn.commit()
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    assert ("earnings", "eps_estimate_30d_ago") in result.missing


def test_30d_prior_estimate_in_tolerance_window_accepted(conn):
    _seed_full_market_history(conn)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    _seed_context_coverage(conn)
    conn.execute(
        "INSERT INTO earnings_history (ticker, report_date, fiscal_period, actual_eps, "
        "estimated_eps) VALUES ('ATI', '2026-01-15', 'Q4-2025', 1.10, 1.00)"
    )
    conn.execute(
        "INSERT INTO estimate_snapshots (date, ticker, fiscal_period, eps_estimate, source) "
        "VALUES ('2026-01-31', 'ATI', 'Q1-2026', 1.05, 'test')"
    )
    # as_of=2026-02-01; window is [2025-12-28, 2026-01-02]. Place a snapshot on 2025-12-29.
    conn.execute(
        "INSERT INTO estimate_snapshots (date, ticker, fiscal_period, eps_estimate, source) "
        "VALUES ('2025-12-29', 'ATI', 'Q1-2026', 0.98, 'test')"
    )
    conn.commit()
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is True
    assert result.resolved.eps_estimate_30d_ago == 0.98


def test_missing_market_history_flagged(conn):
    _seed_earnings(conn)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    assert any(g == "market" for g, _ in result.missing)


def test_missing_wait_check_flagged(conn):
    _seed_full_market_history(conn)
    _seed_earnings(conn)
    _seed_security_metadata(conn)
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    assert ("wait_check", "scheduled_report_date") in result.missing


def test_missing_security_metadata_flagged(conn):
    _seed_full_market_history(conn)
    _seed_earnings(conn)
    _seed_earnings_calendar(conn)
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    assert any(g == "context" for g, _ in result.missing)


def test_missing_context_coverage_flagged_even_with_zero_events(conn):
    # security_metadata is present but ingestion coverage was never marked --
    # zero guidance/insider/material rows must NOT be read as "confirmed no
    # news"; it must route to insufficient_data_cases instead.
    _seed_full_market_history(conn)
    _seed_earnings(conn)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    assert ("context", "ingestion_coverage") in result.missing


def test_context_coverage_before_as_of_date_still_flagged(conn):
    _seed_full_market_history(conn)
    _seed_earnings(conn)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    _seed_context_coverage(conn, as_of=date(2026, 1, 20))  # short of as_of_date
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    assert ("context", "ingestion_coverage") in result.missing


def test_high_volume_breakdown_missing_flagged(conn):
    _seed_full_market_history(conn)
    _seed_earnings(conn)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    _seed_context_coverage(conn)
    conn.execute(
        "UPDATE price_signals SET high_volume_breakdown = NULL WHERE ticker = 'ATI' "
        "AND date = (SELECT MAX(date) FROM price_signals WHERE ticker = 'ATI')"
    )
    conn.commit()
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    assert ("market", "high_volume_breakdown") in result.missing


def test_high_volume_breakdown_resolved_value_passed_through(conn):
    _seed_everything(conn)
    conn.execute(
        "UPDATE price_signals SET high_volume_breakdown = 1 WHERE ticker = 'ATI' "
        "AND date = (SELECT MAX(date) FROM price_signals WHERE ticker = 'ATI')"
    )
    conn.commit()
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is True
    assert result.resolved.high_volume_breakdown is True


def test_200_day_history_counts_only_real_trading_sessions(conn):
    # Insert 205 rows, but seed them on every CALENDAR day (including
    # weekends), not real trading sessions -- fewer than 200 of these are
    # actual trading days, so this must still be flagged as missing.
    _seed_earnings(conn)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    _seed_context_coverage(conn)
    as_of = date(2026, 2, 1)
    start = as_of - timedelta(days=205)
    for i in range(205):
        d = start + timedelta(days=i)
        conn.execute(
            "INSERT INTO price_signals (date, ticker, close, volume, avg_volume_30d, ma_50, "
            "ma_200, return_3m, excess_return_3m, spy_return_3m, high_volume_breakdown) "
            "VALUES (?, 'ATI', 100.0, 1000000, 900000, 98.0, 95.0, 0.05, 0.03, 0.02, 0)",
            (d.isoformat(),),
        )
    conn.commit()
    result = check_required_inputs(conn, "ATI", as_of)
    assert result.ok is False
    assert ("market", "price_history_200d") in result.missing


def test_multiple_missing_fields_one_case_not_one_per_field(conn):
    # Nothing seeded at all -> many missing fields across groups.
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    assert len(result.missing) > 1

    audit_id = record_insufficient_data_case(
        conn, "ATI", date(2026, 2, 1), "first_eligibility", date(2026, 2, 1), None, result.missing
    )
    cases = conn.execute("SELECT * FROM insufficient_data_cases").fetchall()
    assert len(cases) == 1  # one CASE per episode attempt
    fields = conn.execute(
        "SELECT * FROM insufficient_data_fields WHERE audit_id = ?", (audit_id,)
    ).fetchall()
    assert len(fields) == len(result.missing)  # one row per missing field


def test_repeated_ingestion_does_not_create_second_unresolved_case(conn):
    conn.execute(
        "INSERT INTO candidates (candidate_id, date, ticker, source) VALUES (42, "
        "'2026-02-01', 'ATI', 'danelfin')"
    )
    conn.commit()
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    audit_id_1 = record_insufficient_data_case(
        conn, "ATI", date(2026, 2, 1), "first_eligibility", date(2026, 2, 1), 42, result.missing
    )
    # Simulate a second ingestion run for the same ticker/trigger/eligibility_date/candidate.
    audit_id_2 = record_insufficient_data_case(
        conn, "ATI", date(2026, 2, 2), "first_eligibility", date(2026, 2, 1), 42, result.missing
    )
    assert audit_id_1 == audit_id_2
    cases = conn.execute("SELECT * FROM insufficient_data_cases WHERE resolved = FALSE").fetchall()
    assert len(cases) == 1


def test_retry_only_resolves_when_all_fields_available(conn):
    # Seed everything EXCEPT the wait-check earnings_calendar row.
    _seed_full_market_history(conn)
    _seed_earnings(conn)
    _seed_security_metadata(conn)
    _seed_context_coverage(conn)
    result = check_required_inputs(conn, "ATI", date(2026, 2, 1))
    assert result.ok is False
    record_insufficient_data_case(
        conn, "ATI", date(2026, 2, 1), "first_eligibility", date(2026, 2, 1), None, result.missing
    )

    calls = []

    def run_episode_fn(**kwargs):
        calls.append(kwargs)
        return "should-not-be-called"

    resolved_ids = retry_insufficient_data(conn, run_episode_fn, today=date(2026, 2, 1))
    assert resolved_ids == []
    assert calls == []  # still missing earnings_calendar -> must not resolve

    # Now supply the missing piece and retry again.
    _seed_earnings_calendar(conn)
    resolved_ids = retry_insufficient_data(conn, run_episode_fn, today=date(2026, 2, 1))
    assert len(resolved_ids) == 1
    assert calls[0]["episode_trigger"] == "first_eligibility"
    assert calls[0]["eligibility_date"] == date(2026, 2, 1)
    case = conn.execute("SELECT * FROM insufficient_data_cases").fetchone()
    assert case["resolved"] == 1
    assert case["resolved_episode_id"] == "should-not-be-called"


def test_retry_rejects_duplicate_resolution_without_crashing(conn):
    # Regression test: simulates the "crashed between the reviews INSERT and
    # the insufficient_data_cases UPDATE" scenario -- a reviews row already
    # references this audit_id, but the case is still marked unresolved (as
    # it would be if the process died right after the first commit). The
    # next retry run must not create a SECOND reviews row for the same case;
    # the UNIQUE index should reject it and retry_insufficient_data must
    # catch that and move on rather than crashing the whole batch.
    from src.episodes import run_episode_for_retry
    from src.trading_calendar import default_calendar

    _seed_everything(conn)
    audit_id = record_insufficient_data_case(
        conn, "ATI", date(2026, 2, 1), "first_eligibility", date(2026, 2, 1), None, [("wait_check", "scheduled_report_date")]
    )
    # Pre-existing reviews row for this audit_id, but case still shows unresolved.
    conn.execute(
        "INSERT INTO reviews (episode_id, decision_timestamp_utc, rule_version, review_date, "
        "ticker, episode_trigger, resolved_from_audit_id, earnings_score, market_score, "
        "context_score, total_score, red_flag, earnings_within_5d, decision, confidence) "
        "VALUES ('pre-existing-ep', '2026-02-01T10:00:00Z', 'v1', '2026-02-01', 'ATI', "
        "'first_eligibility', ?, 1, 1, 0, 2, 0, 0, 'Confirm', 'Confirm')",
        (audit_id,),
    )
    conn.commit()

    def _adapter(**kwargs):
        return run_episode_for_retry(conn=conn, calendar=default_calendar, **kwargs)

    resolved_ids = retry_insufficient_data(conn, _adapter, today=date(2026, 2, 1))
    assert resolved_ids == []  # rejected, not silently duplicated

    reviews_for_case = conn.execute(
        "SELECT * FROM reviews WHERE resolved_from_audit_id = ?", (audit_id,)
    ).fetchall()
    assert len(reviews_for_case) == 1
    assert reviews_for_case[0]["episode_id"] == "pre-existing-ep"
