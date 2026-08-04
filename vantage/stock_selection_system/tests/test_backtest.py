from datetime import date

import pytest

from src.backtest import _ranking_rows, _total_return, run_backtest
from src.trading_calendar import default_calendar


class _FakeDanelfin:
    """Returns a fixed top-2 ranking for every snapshot date requested."""

    def get_ranking(self, snapshot_date, market=None):
        return {
            snapshot_date.isoformat(): {
                "GOOD": {"aiscore": 9},
                "BAD": {"aiscore": 8},
            }
        }


class _FakeEODHD:
    """Returns bars for every symbol except ones in `fail_for`, which raise
    like a real EODHDProviderError (e.g. a 404 for an unmapped ticker) --
    lets a test exercise per-ticker isolation without any real network call."""

    def __init__(self, fail_for: frozenset = frozenset()):
        self.fail_for = fail_for
        self.requested_symbols: list[str] = []

    def get_eod(self, symbol, from_date, to_date):
        self.requested_symbols.append(symbol)
        if symbol in self.fail_for:
            raise RuntimeError(f"EODHD returned HTTP 404 for /eod/{symbol}")
        return [
            {"date": "2024-01-02", "open": 100.0, "close": 100.0, "volume": 1000},
            {"date": "2024-02-01", "open": 110.0, "close": 110.0, "volume": 1000},
        ]

    def get_splits(self, symbol, from_date, to_date):
        return []

    def get_dividends(self, symbol, from_date, to_date):
        return []


def test_ranking_rows_flattens_historical_date_payload():
    rows = _ranking_rows({
        "2024-01-02": {
            "ATI": {"aiscore": 9, "fundamental": 8},
            "MSFT": {"aiscore": 8},
        },
        "total": 2,
    })
    assert [row["ticker"] for row in rows] == ["ATI", "MSFT"]
    assert rows[0]["date"] == "2024-01-02"


def test_total_return_applies_split_and_dividend_cash_flow():
    result, warnings = _total_return(
        {
            date(2024, 1, 2): {"open": 100.0},
            date(2024, 2, 2): {"open": 50.0},
        },
        [{"date": "2024-01-15", "split": "2:1"}],
        [{"date": "2024-01-20", "value": 1.0}],
        date(2024, 1, 2),
        date(2024, 2, 2),
    )
    # Two shares after the split, plus two dollars of dividends, ending at 102.
    assert result == 0.02
    assert warnings == []


def test_total_return_reports_missing_open():
    result, warnings = _total_return({}, [], [], date(2024, 1, 2), date(2024, 2, 2))
    assert result is None
    assert "missing raw open" in warnings[0]


def test_run_backtest_excludes_single_failing_ticker_instead_of_aborting(tmp_path):
    """A 404/error on one ticker's EODHD symbol (e.g. an unmapped dual-class
    ticker like AKO.A) must not abort the whole run -- it should be recorded
    as a warning and skipped, while every other selected ticker is still
    processed normally."""
    eodhd = _FakeEODHD(fail_for=frozenset({"BAD.US"}))
    result = run_backtest(
        date(2024, 1, 2),
        date(2024, 2, 1),
        top_n=10,
        cache_path=tmp_path / "backtest.db",
        danelfin=_FakeDanelfin(),
        eodhd=eodhd,
        calendar=default_calendar,
    )
    assert {"GOOD.US", "BAD.US"} <= set(eodhd.requested_symbols)
    assert any("BAD" in warning and "excluded" in warning for warning in result["warnings"])
    assert not any("GOOD" in warning and "excluded" in warning for warning in result["warnings"])


def test_run_backtest_continues_without_spy_benchmark(tmp_path):
    """Selected ticker prices still support an absolute-return backtest
    when the optional SPY benchmark is unavailable."""
    eodhd = _FakeEODHD(fail_for=frozenset({"SPY.US"}))
    result = run_backtest(
        date(2024, 1, 2),
        date(2024, 2, 1),
        top_n=10,
        cache_path=tmp_path / "backtest.db",
        danelfin=_FakeDanelfin(),
        eodhd=eodhd,
        calendar=default_calendar,
    )
    assert result["summary"]["portfolio_return"] is not None
    assert result["summary"]["spy_return"] is None
    assert result["summary"]["excess_return"] is None
    assert any("SPY benchmark was skipped" in warning for warning in result["warnings"])
