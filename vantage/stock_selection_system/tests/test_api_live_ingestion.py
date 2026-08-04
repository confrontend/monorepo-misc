"""
Tests the /api/actions/ingest-live and /api/actions/mark-context-reviewed
FastAPI endpoints by calling the route functions directly (no HTTP layer,
no TestClient dependency) with AlphaVantageClient/EODHDClient/DanelfinClient
patched out -- this project has no live network access in CI/sandboxes, so
these tests verify the ENDPOINT'S wiring/contract (request validation,
per-ticker error handling, response shape), not real API behavior.
src/ingestion/live.py already has its own tests against fake clients for the
actual field-mapping logic; tests/test_alpha_vantage.py covers the
live-verified client behaviors (error redaction, the "Information" key, the
CSV-vs-JSON EARNINGS_CALENDAR error detection).
"""
from datetime import date
from unittest.mock import patch

import pytest

import api.main as api_main
from src.db import init_db

AS_OF = date(2026, 2, 2)


@pytest.fixture(autouse=True)
def _isolated_db(tmp_path, monkeypatch):
    db_path = str(tmp_path / "api_test.db")
    init_db(db_path)
    monkeypatch.setattr(api_main, "DB_PATH", db_path)
    yield db_path


class _FakeAV:
    def __init__(self, *a, **kw):
        pass

    def get_earnings(self, ticker):
        return {"quarterlyEarnings": []}

    def get_earnings_estimates(self, ticker):
        return {"estimates": []}

    def get_earnings_calendar(self, ticker, horizon="3month"):
        return []


class _FakeEODHD:
    def __init__(self, *a, **kw):
        pass

    def get_daily(self, ticker, outputsize="full"):
        return {}  # empty history -> ingest_price_and_earnings will just warn, not crash


class _FakeDanelfin:
    def __init__(self, *a, **kw):
        pass

    def get_candidates(self, tickers, as_of=None):
        return [{"ticker": t, "ai_score": 8.0} for t in tickers]


def test_ingest_live_rejects_empty_tickers():
    from fastapi import HTTPException

    req = api_main.IngestLiveRequest(tickers=[], as_of_date=AS_OF)
    with pytest.raises(HTTPException) as exc_info:
        api_main.ingest_live(req)
    assert exc_info.value.status_code == 400


@patch("src.ingestion.alpha_vantage.AlphaVantageClient", _FakeAV)
@patch("api.main.EODHDClient", _FakeEODHD)
@patch("src.ingestion.danelfin.DanelfinClient", _FakeDanelfin)
def test_ingest_live_happy_path_shape():
    req = api_main.IngestLiveRequest(tickers=["ATI", "MSFT"], as_of_date=AS_OF)
    result = api_main.ingest_live(req)

    assert len(result["price_and_earnings"]) == 2
    assert {r["ticker"] for r in result["price_and_earnings"]} == {"ATI", "MSFT"}
    assert result["candidates"]["upserted"] == ["ATI", "MSFT"]
    # With empty price/earnings/candidate data (this fake returns nothing),
    # run_episode has no trigger to fire on, so no episodes are created --
    # but the key must still be present and per-ticker.
    assert result["episodes"] == {"ATI": [], "MSFT": []}


@patch("src.ingestion.alpha_vantage.AlphaVantageClient", _FakeAV)
@patch("api.main.EODHDClient", _FakeEODHD)
def test_ingest_live_can_skip_candidates():
    req = api_main.IngestLiveRequest(tickers=["ATI"], as_of_date=AS_OF, include_candidates=False)
    result = api_main.ingest_live(req)
    assert result["candidates"] is None


def test_ingest_live_missing_alpha_vantage_key_returns_400(monkeypatch):
    monkeypatch.delenv("ALPHA_VANTAGE_API_KEY", raising=False)
    from fastapi import HTTPException

    req = api_main.IngestLiveRequest(tickers=["ATI"], as_of_date=AS_OF)
    with pytest.raises(HTTPException) as exc_info:
        api_main.ingest_live(req)
    assert exc_info.value.status_code == 400
    assert "ALPHA_VANTAGE_API_KEY" in exc_info.value.detail


def test_ingest_live_one_ticker_failing_does_not_abort_the_batch():
    class _FlakyEODHD(_FakeEODHD):
        def get_daily(self, ticker, outputsize="full"):
            if ticker == "SPY":
                return {}
            if ticker == "BAD":
                raise RuntimeError("simulated EODHD error for BAD")
            return {}

    with patch("src.ingestion.alpha_vantage.AlphaVantageClient", _FakeAV), \
         patch("api.main.EODHDClient", _FlakyEODHD):
        req = api_main.IngestLiveRequest(tickers=["BAD", "ATI"], as_of_date=AS_OF, include_candidates=False)
        result = api_main.ingest_live(req)

    tickers_seen = {r["ticker"] for r in result["price_and_earnings"]}
    assert tickers_seen == {"BAD", "ATI"}
    bad_result = next(r for r in result["price_and_earnings"] if r["ticker"] == "BAD")
    assert any("price history fetch failed" in w for w in bad_result["warnings"])


def test_mark_context_reviewed_endpoint_marks_each_ticker(_isolated_db):
    req = api_main.MarkContextReviewedRequest(tickers=["ATI", "MSFT"], as_of_date=AS_OF)
    result = api_main.mark_context_reviewed_endpoint(req)
    assert result["marked"] == ["ATI", "MSFT"]

    conn = api_main.get_connection(_isolated_db)
    for ticker in ("ATI", "MSFT"):
        row = conn.execute(
            "SELECT covered_through FROM context_ingestion_coverage WHERE ticker = ?", (ticker,)
        ).fetchone()
        assert row["covered_through"] == AS_OF.isoformat()


def test_mark_context_reviewed_rejects_empty_tickers():
    from fastapi import HTTPException

    req = api_main.MarkContextReviewedRequest(tickers=[], as_of_date=AS_OF)
    with pytest.raises(HTTPException) as exc_info:
        api_main.mark_context_reviewed_endpoint(req)
    assert exc_info.value.status_code == 400
