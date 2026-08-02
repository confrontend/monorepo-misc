from datetime import date, timedelta

import pytest

from src.db import init_db
from src.episodes import (
    detect_episode_trigger,
    force_rescore,
    record_correction,
    run_episode,
    run_episode_for_retry,
)
from src.ingestion.base import mark_context_coverage
from src.required_inputs import check_required_inputs, record_insufficient_data_case, retry_insufficient_data
from src.trading_calendar import TradingCalendar

_CAL = TradingCalendar()


@pytest.fixture()
def conn(tmp_path):
    return init_db(str(tmp_path / "t.db"))


@pytest.fixture(scope="module")
def cal():
    return TradingCalendar()


def _seed_full_market_history(conn, ticker="ATI", as_of=date(2026, 2, 1), n_trading_days=210, excess_return=0.03, price=110, ma_50=105, ma_200=100):
    # Seeded on REAL trading sessions so the calendar-validated 200-trading-
    # day check (required_inputs._check_market_inputs) is satisfied with margin.
    sessions = _CAL.sessions_in_window(as_of - timedelta(days=450), as_of - timedelta(days=1))
    sessions = sessions[-n_trading_days:]
    for d in sessions:
        conn.execute(
            "INSERT INTO price_signals (date, ticker, close, volume, avg_volume_30d, ma_50, "
            "ma_200, return_3m, excess_return_3m, spy_return_3m, high_volume_breakdown) "
            "VALUES (?, ?, ?, 1000000, 900000, ?, ?, 0.05, ?, 0.02, 0)",
            (d.isoformat(), ticker, price, ma_50, ma_200, excess_return),
        )
    conn.commit()


def _seed_context_coverage(conn, ticker="ATI", as_of=date(2099, 1, 1)):
    # Defaults to a far-future date: most tests in this file seed at one
    # as_of and then run_episode()/detect_episode_trigger()/force_rescore()
    # at a LATER as_of (simulating time passing), and episode-trigger
    # detection isn't what's under test here -- context ingestion coverage
    # itself is covered by tests/test_required_inputs.py.
    mark_context_coverage(conn, ticker, as_of)


def _seed_earnings(conn, ticker="ATI", as_of=date(2026, 2, 1), beat=True):
    """Seeds a single earnings_history row well before `as_of`, plus a DAILY
    series of estimate_snapshots spanning [as_of-205, as_of-1] for a single
    fiscal_period with a slowly, monotonically increasing eps_estimate. This
    guarantees that check_required_inputs' 30-day-prior tolerance-window
    lookup succeeds (and shows a "rose" revision) for any as_of used later in
    a test, e.g. a force_rescore() call several days after the original
    as_of, without having to hand-place snapshots for every date used."""
    actual, estimated = (1.10, 1.00) if beat else (0.90, 1.00)
    report_date = as_of - timedelta(days=20)
    conn.execute(
        "INSERT INTO earnings_history (ticker, report_date, fiscal_period, actual_eps, estimated_eps) "
        "VALUES (?, ?, 'Q4-2025', ?, ?)",
        (ticker, report_date.isoformat(), actual, estimated),
    )
    start = as_of - timedelta(days=205)
    end = as_of - timedelta(days=1)
    n_days = (end - start).days + 1
    for i in range(n_days):
        d = start + timedelta(days=i)
        eps_estimate = round(0.80 + i * 0.001, 4)  # monotonically increasing
        conn.execute(
            "INSERT INTO estimate_snapshots (date, ticker, fiscal_period, eps_estimate, source) "
            "VALUES (?, ?, 'Q1-2026', ?, 'test')",
            (d.isoformat(), ticker, eps_estimate),
        )
    conn.commit()


def _seed_security_metadata(conn, ticker="ATI"):
    conn.execute(
        "INSERT INTO security_metadata (ticker, company_name, sector, industry, sector_benchmark_ticker) "
        "VALUES (?, 'Allegheny Technologies', 'Industrials', 'Metals', 'XLI')",
        (ticker,),
    )
    conn.commit()


def _seed_earnings_calendar(conn, ticker="ATI", scheduled="2026-04-15"):
    conn.execute(
        "INSERT INTO earnings_calendar (ticker, scheduled_report_date, confirmed) VALUES (?, ?, 1)",
        (ticker, scheduled),
    )
    conn.commit()


def _seed_candidate(conn, ticker="ATI", d="2026-02-01"):
    cur = conn.execute(
        "INSERT INTO candidates (date, ticker, source) VALUES (?, ?, 'danelfin')", (d, ticker)
    )
    conn.commit()
    return cur.lastrowid


def _seed_all_required(conn, as_of=date(2026, 2, 1), beat=True, **kwargs):
    _seed_full_market_history(conn, as_of=as_of, **kwargs)
    _seed_earnings(conn, as_of=as_of, beat=beat)
    _seed_security_metadata(conn)
    _seed_earnings_calendar(conn)
    _seed_context_coverage(conn)


# -- detect_episode_trigger --------------------------------------------------------

def test_first_eligibility_trigger_when_no_prior_episode(conn):
    candidate_id = _seed_candidate(conn, d="2026-01-20")
    trigger = detect_episode_trigger(conn, "ATI", date(2026, 2, 1))
    assert trigger.episode_trigger == "first_eligibility"
    assert trigger.eligibility_date == date(2026, 1, 20)
    assert trigger.source_candidate_id == candidate_id


def test_no_trigger_when_not_a_candidate_and_no_history(conn):
    assert detect_episode_trigger(conn, "ATI", date(2026, 2, 1)) is None


def test_earnings_release_trigger_after_existing_episode(conn):
    _seed_candidate(conn, d="2026-01-01")
    _seed_all_required(conn, as_of=date(2026, 1, 5))
    ep1 = run_episode(conn, "ATI", date(2026, 1, 5))
    assert len(ep1) == 1

    conn.execute(
        "INSERT INTO earnings_history (ticker, report_date, fiscal_period, actual_eps, estimated_eps) "
        "VALUES ('ATI', '2026-01-20', 'Q1-2026', 1.20, 1.10)"
    )
    conn.commit()
    trigger = detect_episode_trigger(conn, "ATI", date(2026, 2, 1))
    assert trigger.episode_trigger == "earnings_release"
    assert trigger.eligibility_date == date(2026, 1, 20)


def test_guidance_change_trigger_ignores_maintained(conn):
    _seed_candidate(conn, d="2026-01-01")
    _seed_all_required(conn, as_of=date(2026, 1, 5))
    run_episode(conn, "ATI", date(2026, 1, 5))

    conn.execute(
        "INSERT INTO guidance_events (ticker, event_date, guidance_direction) VALUES "
        "('ATI', '2026-01-10', 'maintained')"
    )
    conn.commit()
    assert detect_episode_trigger(conn, "ATI", date(2026, 2, 1)) is None

    conn.execute(
        "INSERT INTO guidance_events (ticker, event_date, guidance_direction) VALUES "
        "('ATI', '2026-01-12', 'raised')"
    )
    conn.commit()
    trigger = detect_episode_trigger(conn, "ATI", date(2026, 2, 1))
    assert trigger.episode_trigger == "guidance_change"
    assert trigger.eligibility_date == date(2026, 1, 12)


@pytest.mark.parametrize(
    "event_type,expected_trigger",
    [
        ("M&A", "ma_announced"),
        ("CEO_departure", "ceo_cfo_departure"),
        ("CFO_departure", "ceo_cfo_departure"),
        ("investigation", "investigation_start"),
        ("contract_win", "contract_win_loss"),
        ("contract_loss", "contract_win_loss"),
    ],
)
def test_material_event_triggers(conn, event_type, expected_trigger):
    _seed_candidate(conn, d="2026-01-01")
    _seed_all_required(conn, as_of=date(2026, 1, 5))
    run_episode(conn, "ATI", date(2026, 1, 5))

    conn.execute(
        "INSERT INTO material_events (ticker, event_date, event_type, polarity) VALUES "
        "('ATI', '2026-01-15', ?, 'negative')",
        (event_type,),
    )
    conn.commit()
    trigger = detect_episode_trigger(conn, "ATI", date(2026, 2, 1))
    assert trigger.episode_trigger == expected_trigger


def test_routine_recheck_of_unchanged_stock_creates_no_trigger(conn):
    _seed_candidate(conn, d="2026-01-01")
    _seed_all_required(conn, as_of=date(2026, 1, 5))
    run_episode(conn, "ATI", date(2026, 1, 5))
    assert detect_episode_trigger(conn, "ATI", date(2026, 1, 10)) is None


# -- run_episode: insufficient data path --------------------------------------------

def test_run_episode_writes_insufficient_data_case_not_review(conn):
    _seed_candidate(conn, d="2026-01-01")  # only a candidate row; nothing else seeded
    episode_ids = run_episode(conn, "ATI", date(2026, 2, 1))
    assert episode_ids == []
    reviews = conn.execute("SELECT * FROM reviews").fetchall()
    assert len(reviews) == 0
    cases = conn.execute("SELECT * FROM insufficient_data_cases").fetchall()
    assert len(cases) == 1
    assert cases[0]["episode_trigger"] == "first_eligibility"


# -- run_episode: happy path ---------------------------------------------------------

def test_run_episode_writes_confirm_review(conn):
    # Candidate date is deliberately AFTER the earnings_history row seeded by
    # _seed_all_required (report_date = as_of - 20d = 2026-01-12), so this
    # test exercises exactly one episode/trigger. The multi-trigger case
    # (candidate before a later earnings release) is covered by
    # test_run_episode_processes_all_pending_triggers_in_one_call below.
    _seed_candidate(conn, d="2026-01-15")
    _seed_all_required(conn, as_of=date(2026, 2, 1))
    episode_ids = run_episode(conn, "ATI", date(2026, 2, 1))
    assert len(episode_ids) == 1
    episode_id = episode_ids[0]
    row = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (episode_id,)).fetchone()
    assert row["decision"] == "Confirm"
    assert row["earnings_score"] == 1
    assert row["market_score"] == 1
    assert row["rule_version"] == "v1"


def test_run_episode_wait_when_earnings_within_5_trading_days(conn):
    _seed_candidate(conn, d="2026-01-15")  # after the seeded earnings_history row; see above
    _seed_all_required(conn, as_of=date(2026, 2, 1))
    conn.execute("DELETE FROM earnings_calendar")
    conn.execute(
        "INSERT INTO earnings_calendar (ticker, scheduled_report_date, confirmed) VALUES "
        "('ATI', '2026-02-04', 1)"
    )
    conn.commit()
    episode_ids = run_episode(conn, "ATI", date(2026, 2, 1))
    assert len(episode_ids) == 1
    row = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (episode_ids[0],)).fetchone()
    assert row["decision"] == "Wait"


def test_run_episode_processes_all_pending_triggers_in_one_call(conn):
    # Regression test: two Section 10 trigger events land in the same
    # processing gap (a candidate eligibility PLUS a later earnings release,
    # both dated before as_of_date and after the previous cursor). A single
    # run_episode() call must produce an episode for EACH of them, in
    # chronological order -- not just the earliest, which would silently
    # strand the second trigger forever (its event_date would fall before
    # the new cursor on the next call).
    _seed_candidate(conn, d="2026-01-01")
    _seed_all_required(conn, as_of=date(2026, 2, 1))  # earnings report_date = 2026-01-12

    episode_ids = run_episode(conn, "ATI", date(2026, 2, 1))
    assert len(episode_ids) == 2

    rows = [
        conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (eid,)).fetchone()
        for eid in episode_ids
    ]
    assert rows[0]["episode_trigger"] == "first_eligibility"
    assert rows[0]["eligibility_date"] == "2026-01-01"
    assert rows[1]["episode_trigger"] == "earnings_release"
    assert rows[1]["eligibility_date"] == "2026-01-12"

    # No more pending triggers -- a second call must return nothing new.
    assert run_episode(conn, "ATI", date(2026, 2, 1)) == []


def test_same_day_distinct_trigger_events_each_get_their_own_episode(conn):
    # Regression test for the P1 finding: an earnings release AND a guidance
    # change dated on the IDENTICAL calendar day must each produce their own
    # episode. A date-only cursor (MAX(eligibility_date)) would consume the
    # first event and advance the cursor to that same date, then permanently
    # exclude the second (event_date > cursor_date is false for a same-day
    # event) -- detection must instead be keyed on event ROW identity via
    # consumed_triggers, not just a date threshold.
    _seed_candidate(conn, d="2026-01-01")
    _seed_all_required(conn, as_of=date(2026, 2, 1))  # earnings report_date = 2026-01-12

    # A guidance change on the EXACT same date as the seeded earnings release.
    conn.execute(
        "INSERT INTO guidance_events (ticker, event_date, guidance_direction, detail) "
        "VALUES ('ATI', '2026-01-12', 'raised', 'Raised FY guidance same day as earnings')"
    )
    conn.commit()

    episode_ids = run_episode(conn, "ATI", date(2026, 2, 1))
    # first_eligibility (2026-01-01), then BOTH same-day events (2026-01-12).
    assert len(episode_ids) == 3

    rows = [
        conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (eid,)).fetchone()
        for eid in episode_ids
    ]
    assert rows[0]["episode_trigger"] == "first_eligibility"
    assert rows[0]["eligibility_date"] == "2026-01-01"

    same_day = {rows[1]["episode_trigger"], rows[2]["episode_trigger"]}
    assert same_day == {"earnings_release", "guidance_change"}
    assert rows[1]["eligibility_date"] == "2026-01-12"
    assert rows[2]["eligibility_date"] == "2026-01-12"

    # Each event row is recorded exactly once in consumed_triggers -- neither
    # was silently dropped nor double-consumed.
    consumed = conn.execute(
        "SELECT source_table FROM consumed_triggers WHERE ticker = 'ATI' ORDER BY source_table"
    ).fetchall()
    assert [r["source_table"] for r in consumed] == ["candidates", "earnings_history", "guidance_events"]

    # No more pending triggers.
    assert run_episode(conn, "ATI", date(2026, 2, 1)) == []


# -- run_episode_for_retry: preserves original trigger --------------------------------

def test_retry_uses_preserved_trigger_and_eligibility_date(conn):
    candidate_id = _seed_candidate(conn, d="2026-01-01")
    # First attempt: insufficient data.
    episode_ids = run_episode(conn, "ATI", date(2026, 2, 1))
    assert episode_ids == []
    case = conn.execute("SELECT * FROM insufficient_data_cases").fetchone()
    assert case["resolved"] == 0

    # Now supply everything and retry using the preserved trigger.
    _seed_all_required(conn, as_of=date(2026, 2, 1))
    new_episode_id = run_episode_for_retry(
        conn=conn,
        ticker="ATI",
        as_of_date=date(2026, 2, 1),
        episode_trigger=case["episode_trigger"],
        eligibility_date=date.fromisoformat(case["eligibility_date"]),
        resolved_from_audit_id=case["audit_id"],
    )
    assert new_episode_id is not None
    row = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (new_episode_id,)).fetchone()
    assert row["episode_trigger"] == "first_eligibility"
    assert row["resolved_from_audit_id"] == case["audit_id"]


def test_retry_via_insufficient_data_records_consumption_and_stays_settled(conn):
    # End-to-end regression: an earnings-release trigger that initially can't
    # be scored (insufficient data) must, once retried and resolved, record
    # its OWN consumed_triggers row -- not just the candidate's -- so a later
    # detect_episode_trigger() call never re-surfaces that earnings event as
    # a "new" pending trigger, and never confuses it with a same-day sibling.
    _seed_candidate(conn, d="2026-01-01")
    _seed_full_market_history(conn, as_of=date(2026, 2, 1))
    _seed_earnings(conn, as_of=date(2026, 2, 1))  # report_date = 2026-01-12
    _seed_security_metadata(conn)
    _seed_context_coverage(conn)
    # Deliberately omit _seed_earnings_calendar so the wait-check input is
    # missing and BOTH pending triggers (first_eligibility, earnings_release)
    # fall back to insufficient_data_cases.

    episode_ids = run_episode(conn, "ATI", date(2026, 2, 1))
    assert episode_ids == []
    cases = conn.execute("SELECT * FROM insufficient_data_cases WHERE resolved = FALSE").fetchall()
    assert len(cases) == 1  # only the earliest pending trigger gets a case per run_episode() call
    assert cases[0]["episode_trigger"] == "first_eligibility"
    assert cases[0]["trigger_source_table"] == "candidates"

    # Supply the missing wait-check input and resolve via the real retry path.
    _seed_earnings_calendar(conn)

    def _adapter(**kwargs):
        return run_episode_for_retry(conn=conn, **kwargs)

    resolved_ids = retry_insufficient_data(conn, _adapter, today=date(2026, 2, 1))
    assert len(resolved_ids) == 1

    consumed = conn.execute(
        "SELECT source_table FROM consumed_triggers WHERE ticker = 'ATI'"
    ).fetchall()
    assert [r["source_table"] for r in consumed] == ["candidates"]

    # The earnings_release trigger was never scored above (run_episode() stops
    # at the first unscorable trigger per call), so it's still genuinely
    # pending -- and now scorable, since earnings_calendar exists.
    remaining = run_episode(conn, "ATI", date(2026, 2, 1))
    assert len(remaining) == 1
    row = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (remaining[0],)).fetchone()
    assert row["episode_trigger"] == "earnings_release"

    # And now nothing is pending at all.
    assert run_episode(conn, "ATI", date(2026, 2, 1)) == []


# -- force_rescore: only creates episode when label actually changes ------------------

def test_force_rescore_no_change_returns_none(conn):
    _seed_candidate(conn, d="2026-01-01")
    _seed_all_required(conn, as_of=date(2026, 2, 1))
    run_episode(conn, "ATI", date(2026, 2, 1))
    assert force_rescore(conn, "ATI", date(2026, 2, 1)) is None


def test_force_rescore_creates_episode_when_label_changes(conn):
    _seed_candidate(conn, d="2026-01-01")
    _seed_all_required(conn, as_of=date(2026, 2, 1))
    run_episode(conn, "ATI", date(2026, 2, 1))  # Confirm

    # Flip market conditions to force a Reject via red flag.
    conn.execute(
        "INSERT INTO material_events (ticker, event_date, event_type, polarity) VALUES "
        "('ATI', '2026-02-10', 'accounting_issue', 'negative')"
    )
    conn.commit()
    new_id = force_rescore(conn, "ATI", date(2026, 2, 15))
    assert new_id is not None
    row = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (new_id,)).fetchone()
    assert row["decision"] == "Reject"
    assert row["episode_trigger"] == "decision_label_change"


def test_force_rescore_with_no_prior_episode_returns_none(conn):
    _seed_candidate(conn, d="2026-01-01")
    _seed_all_required(conn, as_of=date(2026, 2, 1))
    assert force_rescore(conn, "ATI", date(2026, 2, 1)) is None


# -- record_correction ----------------------------------------------------------------

def test_record_correction_references_original_episode(conn):
    _seed_candidate(conn, d="2026-01-15")  # after the seeded earnings_history row; see above
    _seed_all_required(conn, as_of=date(2026, 2, 1))
    original_ids = run_episode(conn, "ATI", date(2026, 2, 1))
    assert len(original_ids) == 1
    original_id = original_ids[0]
    correction_id = record_correction(conn, "ATI", date(2026, 2, 2), original_id)
    assert correction_id is not None
    assert correction_id != original_id
    row = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (correction_id,)).fetchone()
    assert row["corrects_episode_id"] == original_id
    # Original is untouched (immutability).
    original = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (original_id,)).fetchone()
    assert original["corrects_episode_id"] is None
