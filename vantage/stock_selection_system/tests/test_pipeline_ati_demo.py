"""
Acceptance test for the implementation prompt's required first test case:
"run the full pipeline end-to-end on ticker ATI first before adding other
watchlist stocks."
"""
from datetime import date

import pytest

from src.db import init_db
from src.pipeline import run_ati_demo


@pytest.fixture()
def conn(tmp_path):
    return init_db(str(tmp_path / "ati_demo.db"))


def test_ati_demo_produces_a_decision(conn):
    result = run_ati_demo(conn, date(2026, 2, 2))
    assert result["episode_id"] is not None
    assert result["episode_id"] != ""


def test_ati_demo_review_row_is_well_formed(conn):
    result = run_ati_demo(conn, date(2026, 2, 2))
    row = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (result["episode_id"],)).fetchone()
    assert row["ticker"] == "ATI"
    assert row["decision"] in ("Confirm", "Mixed", "Reject", "Wait")
    assert row["rule_version"] == "v1"
    assert row["episode_trigger"] == "first_eligibility"
    # entry_date/entry price must never live on the reviews row (Section 7).
    assert "entry_date" not in row.keys()


def test_ati_demo_entry_recorded_same_or_next_session(conn):
    result = run_ati_demo(conn, date(2026, 2, 2))
    entry = conn.execute(
        "SELECT * FROM episode_entries WHERE episode_id = ?", (result["episode_id"],)
    ).fetchone()
    assert entry is not None
    assert entry["entry_date"] in ("2026-02-02", "2026-02-03")
    assert entry["sector_benchmark_ticker"] == "XLI"
    assert entry["stock_entry_open"] > 0


def test_ati_demo_all_four_outcome_horizons_resolve(conn):
    result = run_ati_demo(conn, date(2026, 2, 2))
    horizons = {
        r["horizon_days"]
        for r in conn.execute(
            "SELECT horizon_days FROM recommendation_outcomes WHERE episode_id = ?",
            (result["episode_id"],),
        )
    }
    assert horizons == {7, 30, 90, 180}


def test_ati_demo_outcome_returns_are_open_to_close(conn):
    result = run_ati_demo(conn, date(2026, 2, 2))
    entry = conn.execute(
        "SELECT * FROM episode_entries WHERE episode_id = ?", (result["episode_id"],)
    ).fetchone()
    outcome_7d = conn.execute(
        "SELECT * FROM recommendation_outcomes WHERE episode_id = ? AND horizon_days = 7",
        (result["episode_id"],),
    ).fetchone()
    expected_return = outcome_7d["stock_exit_close"] / entry["stock_entry_open"] - 1
    assert outcome_7d["stock_return"] == pytest.approx(expected_return)


def test_ati_demo_report_is_human_readable(conn):
    result = run_ati_demo(conn, date(2026, 2, 2))
    report = result["report"]
    assert "ATI" in report
    assert "Decision:" in report
    assert "Earnings score:" in report
    assert "Market score:" in report
    assert "Context score:" in report
    assert "Entry:" in report
    assert "Outcomes:" in report


def test_ati_demo_reviews_row_is_immutable(conn):
    import sqlite3

    result = run_ati_demo(conn, date(2026, 2, 2))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "UPDATE reviews SET decision = 'Reject' WHERE episode_id = ?", (result["episode_id"],)
        )


def test_ati_demo_is_deterministic_given_same_seed(tmp_path):
    conn_a = init_db(str(tmp_path / "a.db"))
    conn_b = init_db(str(tmp_path / "b.db"))
    result_a = run_ati_demo(conn_a, date(2026, 2, 2), seed=7)
    result_b = run_ati_demo(conn_b, date(2026, 2, 2), seed=7)
    row_a = conn_a.execute("SELECT * FROM reviews WHERE episode_id = ?", (result_a["episode_id"],)).fetchone()
    row_b = conn_b.execute("SELECT * FROM reviews WHERE episode_id = ?", (result_b["episode_id"],)).fetchone()
    assert row_a["decision"] == row_b["decision"]
    assert row_a["earnings_score"] == row_b["earnings_score"]
    assert row_a["market_score"] == row_b["market_score"]
    assert row_a["context_score"] == row_b["context_score"]
