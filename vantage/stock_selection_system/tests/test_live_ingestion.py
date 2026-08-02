from datetime import date, timedelta

import pytest

from src.db import init_db
from src.ingestion.live import ingest_candidates, ingest_price_and_earnings, mark_context_reviewed
from src.required_inputs import check_required_inputs

AS_OF = date(2026, 2, 2)


@pytest.fixture()
def conn(tmp_path):
    return init_db(str(tmp_path / "t.db"))


def _daily_series(as_of: date, n_days: int, base_price: float = 100.0):
    """A flat-ish synthetic daily series ending on/near as_of, going back
    n_days CALENDAR days (fine for these tests -- we only need `len(bars) >=
    threshold` and a computable mean, not real trading-calendar accuracy)."""
    series = {}
    for i in range(n_days):
        d = as_of - timedelta(days=i)
        series[d] = {"open": base_price, "high": base_price + 1, "low": base_price - 1,
                     "close": base_price + (i % 5), "volume": 1_000_000 + i * 1000}
    return series


class FakeAlphaVantage:
    def __init__(self, ticker_bars=210, spy_bars=210, has_reported_earnings=True,
                 has_upcoming_estimate=True, has_calendar_entry=True):
        self._ticker_bars = ticker_bars
        self._spy_bars = spy_bars
        self._has_reported_earnings = has_reported_earnings
        self._has_upcoming_estimate = has_upcoming_estimate
        self._has_calendar_entry = has_calendar_entry

    def get_daily(self, ticker, outputsize="full"):
        n = self._spy_bars if ticker == "SPY" else self._ticker_bars
        return _daily_series(AS_OF, n)

    def get_earnings(self, ticker):
        if not self._has_reported_earnings:
            return {"quarterlyEarnings": []}
        return {
            "quarterlyEarnings": [
                {
                    "fiscalDateEnding": "2025-12-31",
                    "reportedDate": "2026-01-15",
                    "reportedEPS": "1.10",
                    "estimatedEPS": "1.00",
                    "surprise": "0.10",
                },
                {
                    # Future-dated report should be ignored (not <= AS_OF).
                    "fiscalDateEnding": "2026-03-31",
                    "reportedDate": "2026-04-30",
                    "reportedEPS": "1.20",
                    "estimatedEPS": "1.05",
                    "surprise": "0.15",
                },
            ]
        }

    def get_earnings_estimates(self, ticker):
        if not self._has_upcoming_estimate:
            return {"estimates": []}
        return {
            "estimates": [
                {
                    "date": "2026-06-30",
                    "horizon": "fiscal quarter",
                    "eps_estimate_average": "1.30",
                    "eps_estimate_average_30_days_ago": "1.20",
                },
                {
                    # Past quarter, should be filtered out (not > AS_OF).
                    "date": "2025-12-31",
                    "horizon": "fiscal quarter",
                    "eps_estimate_average": "1.10",
                    "eps_estimate_average_30_days_ago": "1.05",
                },
            ]
        }

    def get_earnings_calendar(self, ticker, horizon="3month"):
        if not self._has_calendar_entry:
            return []
        return [{"symbol": ticker, "reportDate": "2026-04-30", "fiscalDateEnding": "2026-03-31", "estimate": "1.05"}]


class FakeDanelfin:
    def __init__(self, rows=None, raise_on_fetch=False):
        self._rows = rows
        self._raise = raise_on_fetch

    def get_candidates(self, tickers, as_of=None):
        if self._raise:
            raise RuntimeError("simulated network failure")
        if self._rows is not None:
            return self._rows
        return [
            {"ticker": t, "ai_score": 8.5, "technical_score": 7.0, "fundamental_score": 6.5, "rank": "top_decile"}
            for t in tickers
        ]


def test_ingest_price_and_earnings_writes_everything_with_full_data(conn):
    av = FakeAlphaVantage()
    result = ingest_price_and_earnings(conn, "ATI", AS_OF, av)

    assert result["wrote"] == {
        "price_signal": True, "earnings_history": True, "estimate_snapshots": True, "earnings_calendar": True,
    }
    assert result["warnings"] == []

    price_row = conn.execute("SELECT * FROM price_signals WHERE ticker = 'ATI'").fetchone()
    assert price_row is not None
    assert price_row["ma_50"] is not None
    assert price_row["ma_200"] is not None

    earnings_row = conn.execute("SELECT * FROM earnings_history WHERE ticker = 'ATI'").fetchone()
    assert earnings_row["actual_eps"] == pytest.approx(1.10)
    assert earnings_row["estimated_eps"] == pytest.approx(1.00)
    # The future-dated (not-yet-reported) quarter must NOT have been used.
    assert earnings_row["report_date"] == "2026-01-15"

    snapshots = conn.execute(
        "SELECT date, eps_estimate FROM estimate_snapshots WHERE ticker = 'ATI' ORDER BY date"
    ).fetchall()
    assert len(snapshots) == 2
    assert snapshots[0]["date"] == (AS_OF - timedelta(days=30)).isoformat()
    assert snapshots[0]["eps_estimate"] == pytest.approx(1.20)
    assert snapshots[1]["date"] == AS_OF.isoformat()
    assert snapshots[1]["eps_estimate"] == pytest.approx(1.30)

    cal_row = conn.execute("SELECT * FROM earnings_calendar WHERE ticker = 'ATI'").fetchone()
    assert cal_row["scheduled_report_date"] == "2026-04-30"

    # End-to-end: the earnings + wait-check inputs this wrote are enough to
    # resolve check_required_inputs' earnings/wait groups (market/context
    # still need security_metadata/context_ingestion_coverage, not covered
    # by this function -- see the "does NOT touch context" note in live.py).
    result2 = check_required_inputs(conn, "ATI", AS_OF)
    earnings_missing = [m for m in result2.missing if m[0] == "earnings"]
    wait_missing = [m for m in result2.missing if m[0] == "wait_check"]
    assert earnings_missing == []
    assert wait_missing == []


def test_ingest_price_and_earnings_reuses_provided_spy_series(conn):
    av = FakeAlphaVantage()
    calls = {"get_daily": 0}
    orig = av.get_daily

    def counting_get_daily(ticker, outputsize="full"):
        calls["get_daily"] += 1
        return orig(ticker, outputsize)

    av.get_daily = counting_get_daily
    spy_series = _daily_series(AS_OF, 210)

    ingest_price_and_earnings(conn, "ATI", AS_OF, av, spy_series=spy_series)

    # Only the ticker itself should have been fetched -- SPY was reused.
    assert calls["get_daily"] == 1


def test_ingest_price_and_earnings_uses_price_client_when_given_separately_from_av(conn):
    # Regression test for the Alpha-Vantage-free-tier price-history gap
    # (outputsize='full' on TIME_SERIES_DAILY confirmed premium-only): a
    # distinct `price_client` (e.g. StooqClient) must be used for price
    # history instead of `av`, and `av` must not be touched for it at all.
    av = FakeAlphaVantage()
    av.get_daily = lambda *a, **kw: (_ for _ in ()).throw(AssertionError("av.get_daily should not be called"))

    class _FakePriceClient:
        def get_daily(self, ticker, outputsize="full"):
            return _daily_series(AS_OF, 210)

    result = ingest_price_and_earnings(conn, "ATI", AS_OF, av, price_client=_FakePriceClient())
    assert result["wrote"]["price_signal"] is True


def test_ingest_price_and_earnings_warns_without_crashing_on_thin_history(conn):
    av = FakeAlphaVantage(ticker_bars=10, spy_bars=10, has_reported_earnings=False,
                           has_upcoming_estimate=False, has_calendar_entry=False)
    result = ingest_price_and_earnings(conn, "ATI", AS_OF, av)

    assert result["wrote"] == {
        "price_signal": False, "earnings_history": False, "estimate_snapshots": False, "earnings_calendar": False,
    }
    assert len(result["warnings"]) == 4
    assert conn.execute("SELECT COUNT(*) AS n FROM price_signals").fetchone()["n"] == 0


def test_ingest_price_and_earnings_calendar_dedups_on_repeated_runs(conn):
    av = FakeAlphaVantage()
    ingest_price_and_earnings(conn, "ATI", AS_OF, av)
    ingest_price_and_earnings(conn, "ATI", AS_OF, av)  # simulate a re-run
    rows = conn.execute("SELECT * FROM earnings_calendar WHERE ticker = 'ATI'").fetchall()
    assert len(rows) == 1


def test_ingest_candidates_upserts_each_ticker(conn):
    danelfin = FakeDanelfin()
    result = ingest_candidates(conn, ["ATI", "MSFT"], AS_OF, danelfin)
    assert result["upserted"] == ["ATI", "MSFT"]
    assert result["warnings"] == []
    rows = conn.execute("SELECT * FROM candidates ORDER BY ticker").fetchall()
    assert [r["ticker"] for r in rows] == ["ATI", "MSFT"]
    assert rows[0]["ai_score"] == pytest.approx(8.5)


def test_ingest_candidates_reports_batch_failure_without_raising(conn):
    danelfin = FakeDanelfin(raise_on_fetch=True)
    result = ingest_candidates(conn, ["ATI"], AS_OF, danelfin)
    assert result["upserted"] == []
    assert len(result["warnings"]) == 1
    assert "simulated network failure" in result["warnings"][0]


def test_ingest_candidates_skips_rows_with_no_ticker_but_keeps_going(conn):
    danelfin = FakeDanelfin(rows=[{"ai_score": 5.0}, {"ticker": "ATI", "ai_score": 7.0}])
    result = ingest_candidates(conn, ["ATI"], AS_OF, danelfin)
    assert result["upserted"] == ["ATI"]
    assert len(result["warnings"]) == 1


def test_mark_context_reviewed_sets_coverage(conn):
    mark_context_reviewed(conn, "ATI", AS_OF)
    row = conn.execute("SELECT covered_through FROM context_ingestion_coverage WHERE ticker = 'ATI'").fetchone()
    assert row["covered_through"] == AS_OF.isoformat()


def test_ingest_price_and_earnings_never_calls_mark_context_coverage(conn):
    # Regression test for the explicit-manual-step design decision: fetching
    # price/earnings data must NEVER mark context coverage as a side effect.
    av = FakeAlphaVantage()
    ingest_price_and_earnings(conn, "ATI", AS_OF, av)
    row = conn.execute("SELECT * FROM context_ingestion_coverage WHERE ticker = 'ATI'").fetchone()
    assert row is None
