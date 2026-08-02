import csv
from datetime import date

import pytest

from src.db import init_db
from src.ingestion.base import (
    mark_context_coverage,
    upsert_candidate,
    upsert_earnings_history,
    upsert_estimate_snapshot,
    upsert_price_signal,
    upsert_security_metadata,
)
from src.ingestion.manual_events import (
    import_earnings_calendar_csv,
    import_guidance_events_csv,
    import_insider_purchases_csv,
    import_material_events_csv,
)


@pytest.fixture()
def conn(tmp_path):
    return init_db(str(tmp_path / "t.db"))


def test_upsert_candidate_is_idempotent(conn):
    id1 = upsert_candidate(conn, date(2026, 1, 1), "ATI", "danelfin", ai_score=8.0)
    id2 = upsert_candidate(conn, date(2026, 1, 1), "ATI", "danelfin", ai_score=9.0)
    assert id1 == id2
    rows = conn.execute("SELECT * FROM candidates").fetchall()
    assert len(rows) == 1
    assert rows[0]["ai_score"] == 9.0


def test_upsert_estimate_snapshot_is_idempotent(conn):
    upsert_estimate_snapshot(conn, date(2026, 1, 1), "ATI", "Q1-2026", 1.00)
    upsert_estimate_snapshot(conn, date(2026, 1, 1), "ATI", "Q1-2026", 1.05)
    rows = conn.execute("SELECT * FROM estimate_snapshots").fetchall()
    assert len(rows) == 1
    assert rows[0]["eps_estimate"] == 1.05


def test_upsert_earnings_history_computes_surprise(conn):
    upsert_earnings_history(conn, "ATI", date(2026, 1, 15), "Q4-2025", actual_eps=1.15, estimated_eps=1.05)
    row = conn.execute("SELECT * FROM earnings_history").fetchone()
    assert row["eps_surprise"] == pytest.approx(0.10)


def test_upsert_price_signal_computes_excess_return_and_breakdown(conn):
    upsert_price_signal(
        conn, date(2026, 1, 1), "ATI", close=95.0, volume=2_000_000, avg_volume_30d=1_000_000,
        ma_50=98.0, ma_200=100.0, return_3m=0.01, spy_return_3m=0.04,
    )
    row = conn.execute("SELECT * FROM price_signals").fetchone()
    assert row["excess_return_3m"] == pytest.approx(-0.03)
    assert row["high_volume_breakdown"] == 1  # close < ma_200 and volume >= 1.5x avg


def test_upsert_price_signal_idempotent_upsert(conn):
    upsert_price_signal(
        conn, date(2026, 1, 1), "ATI", close=95.0, volume=1_000_000, avg_volume_30d=1_000_000,
        ma_50=98.0, ma_200=100.0, return_3m=0.01, spy_return_3m=0.04,
    )
    upsert_price_signal(
        conn, date(2026, 1, 1), "ATI", close=99.0, volume=1_000_000, avg_volume_30d=1_000_000,
        ma_50=98.0, ma_200=100.0, return_3m=0.02, spy_return_3m=0.04,
    )
    rows = conn.execute("SELECT * FROM price_signals").fetchall()
    assert len(rows) == 1
    assert rows[0]["close"] == 99.0


def test_mark_context_coverage_creates_and_advances(conn):
    mark_context_coverage(conn, "ATI", date(2026, 1, 1))
    row = conn.execute("SELECT covered_through FROM context_ingestion_coverage WHERE ticker = 'ATI'").fetchone()
    assert row["covered_through"] == "2026-01-01"

    mark_context_coverage(conn, "ATI", date(2026, 1, 5))
    row = conn.execute("SELECT covered_through FROM context_ingestion_coverage WHERE ticker = 'ATI'").fetchone()
    assert row["covered_through"] == "2026-01-05"


def test_mark_context_coverage_never_regresses(conn):
    mark_context_coverage(conn, "ATI", date(2026, 1, 10))
    mark_context_coverage(conn, "ATI", date(2026, 1, 5))  # stale/older re-run
    row = conn.execute("SELECT covered_through FROM context_ingestion_coverage WHERE ticker = 'ATI'").fetchone()
    assert row["covered_through"] == "2026-01-10"


def test_upsert_security_metadata(conn):
    upsert_security_metadata(conn, "ATI", "Allegheny Technologies", "Industrials", "Metals", "XLI")
    upsert_security_metadata(conn, "ATI", "Allegheny Technologies Inc.", "Industrials", "Metals", "XLI")
    rows = conn.execute("SELECT * FROM security_metadata").fetchall()
    assert len(rows) == 1
    assert rows[0]["company_name"] == "Allegheny Technologies Inc."


# -- CSV imports ---------------------------------------------------------------------

def test_import_guidance_events_csv(conn, tmp_path):
    csv_path = tmp_path / "guidance.csv"
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["ticker", "event_date", "guidance_direction", "detail"])
        writer.writerow(["ATI", "2026-01-10", "raised", "Raised FY guidance"])
    n = import_guidance_events_csv(conn, csv_path)
    assert n == 1
    row = conn.execute("SELECT * FROM guidance_events").fetchone()
    assert row["guidance_direction"] == "raised"


def test_import_insider_purchases_csv(conn, tmp_path):
    csv_path = tmp_path / "insiders.csv"
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["ticker", "transaction_date", "insider_name", "insider_title", "purchase_value_usd"])
        writer.writerow(["ATI", "2026-01-10", "Jane CFO", "CFO", "60000"])
    n = import_insider_purchases_csv(conn, csv_path)
    assert n == 1
    row = conn.execute("SELECT * FROM insider_purchases").fetchone()
    assert row["purchase_value_usd"] == 60000.0
    assert row["transaction_type"] == "open-market"


def test_import_material_events_csv(conn, tmp_path):
    csv_path = tmp_path / "material.csv"
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["ticker", "event_date", "event_type", "polarity"])
        writer.writerow(["ATI", "2026-01-10", "CEO_departure", "negative"])
    n = import_material_events_csv(conn, csv_path)
    assert n == 1


def test_import_earnings_calendar_csv(conn, tmp_path):
    csv_path = tmp_path / "cal.csv"
    with open(csv_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["ticker", "scheduled_report_date", "confirmed"])
        writer.writerow(["ATI", "2026-04-15", "1"])
    n = import_earnings_calendar_csv(conn, csv_path)
    assert n == 1
    row = conn.execute("SELECT * FROM earnings_calendar").fetchone()
    assert row["confirmed"] == 1
