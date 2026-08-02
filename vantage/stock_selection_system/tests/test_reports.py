import pytest

from src.db import init_db
from src.reports import render_report


@pytest.fixture()
def conn(tmp_path):
    return init_db(str(tmp_path / "t.db"))


def _seed_review(conn):
    conn.execute(
        "INSERT INTO reviews (episode_id, decision_timestamp_utc, rule_version, review_date, "
        "ticker, episode_trigger, earnings_score, earnings_fact, market_score, market_fact, "
        "context_score, context_fact, total_score, red_flag, earnings_within_5d, decision, "
        "confidence, explanation) VALUES ('ep-1', '2026-01-06T10:00:00Z', 'v1', '2026-01-06', "
        "'ATI', 'earnings_release', 0, 'mixed revisions', 1, 'price above both MAs', 1, "
        "'raised FY guidance', 2, 0, 0, 'Confirm', 'Confirm', 'Earnings=0, Market=+1, Context=+1 -> Confirm.')"
    )
    conn.commit()


def test_render_report_without_entry(conn):
    _seed_review(conn)
    text = render_report(conn, "ep-1")
    assert "ATI  (episode_id: ep-1)" in text
    assert "Decision: CONFIRM" in text
    assert "Earnings score: +0 (mixed revisions)" in text
    assert "Market score: +1 (price above both MAs)" in text
    assert "Entry: pending" in text


def test_render_report_with_entry_and_outcomes(conn):
    _seed_review(conn)
    conn.execute(
        "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, spy_entry_open, "
        "sector_entry_open, sector_benchmark_ticker) VALUES ('ep-1', '2026-01-07', 50.0, 500.0, 120.0, 'XLI')"
    )
    conn.execute(
        "INSERT INTO recommendation_outcomes (episode_id, measurement_date, horizon_days, "
        "exit_date, stock_exit_close, spy_exit_close, sector_exit_close, stock_return, "
        "spy_return, sector_return, recommendation_result) VALUES ('ep-1', '2026-01-16', 7, "
        "'2026-01-16', 55.0, 510.0, 121.2, 0.10, 0.02, 0.01, 'Stock outperformed')"
    )
    conn.commit()
    text = render_report(conn, "ep-1")
    assert "Entry: 2026-01-07" in text
    assert "stock_open=$50.00" in text
    assert "+7d (2026-01-16)" in text
    assert "stock +10.00%" in text


def test_render_report_missing_episode_raises(conn):
    with pytest.raises(ValueError):
        render_report(conn, "nonexistent")
