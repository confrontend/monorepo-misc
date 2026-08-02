"""
Idempotent upsert helpers for the tables that are populated by automated
ingestion (`candidates`, `estimate_snapshots`, `earnings_history`,
`price_signals`, `security_metadata`). Each relies on the table's UNIQUE
constraint and SQLite's `ON CONFLICT ... DO UPDATE` so that re-running
ingestion for a day that was already ingested is a safe no-op/update rather
than an error or a duplicate row.
"""
from __future__ import annotations

import sqlite3
from datetime import date
from typing import Optional


def _d(v) -> str:
    return v.isoformat() if isinstance(v, date) else str(v)


def upsert_candidate(
    conn: sqlite3.Connection,
    on_date,
    ticker: str,
    source: str,
    source_rank: Optional[str] = None,
    ai_score: Optional[float] = None,
    technical_score: Optional[float] = None,
    fundamental_score: Optional[float] = None,
    expected_return: Optional[float] = None,
) -> int:
    conn.execute(
        "INSERT INTO candidates (date, ticker, source, source_rank, ai_score, technical_score, "
        "fundamental_score, expected_return) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(date, ticker, source) DO UPDATE SET "
        "source_rank=excluded.source_rank, ai_score=excluded.ai_score, "
        "technical_score=excluded.technical_score, fundamental_score=excluded.fundamental_score, "
        "expected_return=excluded.expected_return",
        (_d(on_date), ticker, source, source_rank, ai_score, technical_score, fundamental_score, expected_return),
    )
    conn.commit()
    row = conn.execute(
        "SELECT candidate_id FROM candidates WHERE date = ? AND ticker = ? AND source = ?",
        (_d(on_date), ticker, source),
    ).fetchone()
    return row["candidate_id"]


def upsert_estimate_snapshot(
    conn: sqlite3.Connection,
    on_date,
    ticker: str,
    fiscal_period: str,
    eps_estimate: float,
    revenue_estimate: Optional[float] = None,
    analyst_count: Optional[int] = None,
    source: str = "manual",
) -> None:
    conn.execute(
        "INSERT INTO estimate_snapshots (date, ticker, fiscal_period, eps_estimate, "
        "revenue_estimate, analyst_count, source) VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(date, ticker, fiscal_period, source) DO UPDATE SET "
        "eps_estimate=excluded.eps_estimate, revenue_estimate=excluded.revenue_estimate, "
        "analyst_count=excluded.analyst_count",
        (_d(on_date), ticker, fiscal_period, eps_estimate, revenue_estimate, analyst_count, source),
    )
    conn.commit()


def upsert_earnings_history(
    conn: sqlite3.Connection,
    ticker: str,
    report_date,
    fiscal_period: str,
    actual_eps: float,
    estimated_eps: float,
    actual_revenue: Optional[float] = None,
    estimated_revenue: Optional[float] = None,
) -> None:
    eps_surprise = actual_eps - estimated_eps
    conn.execute(
        "INSERT INTO earnings_history (ticker, report_date, fiscal_period, actual_eps, "
        "estimated_eps, eps_surprise, actual_revenue, estimated_revenue) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(ticker, report_date, fiscal_period) DO UPDATE SET "
        "actual_eps=excluded.actual_eps, estimated_eps=excluded.estimated_eps, "
        "eps_surprise=excluded.eps_surprise, actual_revenue=excluded.actual_revenue, "
        "estimated_revenue=excluded.estimated_revenue",
        (ticker, _d(report_date), fiscal_period, actual_eps, estimated_eps, eps_surprise, actual_revenue, estimated_revenue),
    )
    conn.commit()


def upsert_price_signal(
    conn: sqlite3.Connection,
    on_date,
    ticker: str,
    close: float,
    volume: float,
    avg_volume_30d: float,
    ma_50: float,
    ma_200: float,
    return_3m: float,
    spy_return_3m: float,
    return_6m: Optional[float] = None,
    return_12m: Optional[float] = None,
    spy_relative_return: Optional[float] = None,
) -> None:
    """Computes and stores excess_return_3m and high_volume_breakdown directly
    (per the implementation prompt: these must not be computed ad hoc inside
    score_market())."""
    excess_return_3m = return_3m - spy_return_3m
    high_volume_breakdown = 1 if (close < ma_200 and volume >= 1.5 * avg_volume_30d) else 0
    conn.execute(
        "INSERT INTO price_signals (date, ticker, close, volume, avg_volume_30d, ma_50, ma_200, "
        "return_3m, return_6m, return_12m, spy_return_3m, excess_return_3m, high_volume_breakdown, "
        "spy_relative_return) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(date, ticker) DO UPDATE SET "
        "close=excluded.close, volume=excluded.volume, avg_volume_30d=excluded.avg_volume_30d, "
        "ma_50=excluded.ma_50, ma_200=excluded.ma_200, return_3m=excluded.return_3m, "
        "return_6m=excluded.return_6m, return_12m=excluded.return_12m, "
        "spy_return_3m=excluded.spy_return_3m, excess_return_3m=excluded.excess_return_3m, "
        "high_volume_breakdown=excluded.high_volume_breakdown, "
        "spy_relative_return=excluded.spy_relative_return",
        (
            _d(on_date), ticker, close, volume, avg_volume_30d, ma_50, ma_200, return_3m,
            return_6m, return_12m, spy_return_3m, excess_return_3m, high_volume_breakdown,
            spy_relative_return,
        ),
    )
    conn.commit()


def upsert_security_metadata(
    conn: sqlite3.Connection,
    ticker: str,
    company_name: str,
    sector: str,
    industry: str,
    sector_benchmark_ticker: str,
) -> None:
    conn.execute(
        "INSERT INTO security_metadata (ticker, company_name, sector, industry, "
        "sector_benchmark_ticker) VALUES (?, ?, ?, ?, ?) "
        "ON CONFLICT(ticker) DO UPDATE SET company_name=excluded.company_name, "
        "sector=excluded.sector, industry=excluded.industry, "
        "sector_benchmark_ticker=excluded.sector_benchmark_ticker",
        (ticker, company_name, sector, industry, sector_benchmark_ticker),
    )
    conn.commit()


def mark_context_coverage(conn: sqlite3.Connection, ticker: str, covered_through) -> None:
    """Records that guidance_events/insider_purchases/material_events ingestion
    has been confirmed complete for `ticker` through `covered_through` --
    call this after EVERY ingestion check for that window, even when it finds
    zero new events, so check_required_inputs() can tell "checked, nothing
    happened" from "never checked." `covered_through` only ever moves
    forward (a stale/older re-run can't regress a ticker's coverage date)."""
    conn.execute(
        "INSERT INTO context_ingestion_coverage (ticker, covered_through) VALUES (?, ?) "
        "ON CONFLICT(ticker) DO UPDATE SET covered_through=excluded.covered_through, "
        "checked_at=CURRENT_TIMESTAMP WHERE excluded.covered_through > context_ingestion_coverage.covered_through",
        (ticker, _d(covered_through)),
    )
    conn.commit()
