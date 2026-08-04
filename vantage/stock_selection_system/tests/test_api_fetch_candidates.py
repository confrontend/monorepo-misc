"""
Tests the dedicated /api/actions/fetch-candidates endpoint (distinct from
/api/actions/ingest-live's bundled candidates step) by calling the route
function directly, with DanelfinClient patched out -- same pattern as
tests/test_api_live_ingestion.py. src/ingestion/candidate_selection.py
already has its own thorough tests against a fake Danelfin client; this file
just verifies the endpoint's wiring/contract.
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


class _FakeDanelfin:
    def __init__(self, *a, **kw):
        pass

    def get_candidate(self, ticker, as_of=None):
        return {"ticker": ticker, "ai_score": 8.0, "rank": "top_decile"}


def test_fetch_candidates_rejects_empty_tickers():
    from fastapi import HTTPException

    req = api_main.FetchCandidatesRequest(tickers=[], as_of_date=AS_OF)
    with pytest.raises(HTTPException) as exc_info:
        api_main.fetch_candidates_endpoint(req)
    assert exc_info.value.status_code == 400


@patch("src.ingestion.danelfin.DanelfinClient", _FakeDanelfin)
def test_fetch_candidates_happy_path_shape(_isolated_db):
    req = api_main.FetchCandidatesRequest(tickers=["ATI", "MSFT"], as_of_date=AS_OF)
    result = api_main.fetch_candidates_endpoint(req)

    assert result["requested"] == ["ATI", "MSFT"]
    assert result["successful"] == ["ATI", "MSFT"]
    assert result["skipped"] == []
    assert result["failed"] == {}
    assert result["successful_count"] == 2

    conn = api_main.get_connection(_isolated_db)
    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["source"] == "danelfin"
    assert row["ai_score"] == pytest.approx(8.0)


def test_fetch_candidates_missing_danelfin_key_returns_400(monkeypatch):
    monkeypatch.delenv("DANELFIN_API_KEY", raising=False)
    from fastapi import HTTPException

    req = api_main.FetchCandidatesRequest(tickers=["ATI"], as_of_date=AS_OF)
    with pytest.raises(HTTPException) as exc_info:
        api_main.fetch_candidates_endpoint(req)
    assert exc_info.value.status_code == 400
    assert "DANELFIN_API_KEY" in exc_info.value.detail


def test_fetch_candidates_one_ticker_failing_does_not_abort_the_batch(_isolated_db):
    class _FlakyDanelfin(_FakeDanelfin):
        def get_candidate(self, ticker, as_of=None):
            if ticker == "BAD":
                raise RuntimeError("simulated Danelfin failure for BAD")
            return {"ticker": ticker, "ai_score": 8.0}

    with patch("src.ingestion.danelfin.DanelfinClient", _FlakyDanelfin):
        req = api_main.FetchCandidatesRequest(tickers=["BAD", "ATI"], as_of_date=AS_OF)
        result = api_main.fetch_candidates_endpoint(req)

    assert result["successful"] == ["ATI"]
    assert "BAD" in result["failed"]
    assert "simulated Danelfin failure for BAD" in result["failed"]["BAD"]


def test_fetch_candidates_does_not_touch_price_earnings_or_episodes(_isolated_db):
    # Contract check: this endpoint is candidates-only, unlike
    # /api/actions/ingest-live -- it must not write price_signals/
    # earnings_history or run episode-trigger detection.
    with patch("src.ingestion.danelfin.DanelfinClient", _FakeDanelfin):
        req = api_main.FetchCandidatesRequest(tickers=["ATI"], as_of_date=AS_OF)
        api_main.fetch_candidates_endpoint(req)

    conn = api_main.get_connection(_isolated_db)
    assert conn.execute("SELECT COUNT(*) AS n FROM price_signals").fetchone()["n"] == 0
    assert conn.execute("SELECT COUNT(*) AS n FROM earnings_history").fetchone()["n"] == 0
    assert conn.execute("SELECT COUNT(*) AS n FROM reviews").fetchone()["n"] == 0


def test_add_manual_candidate_rejects_empty_tickers():
    from fastapi import HTTPException

    req = api_main.AddManualCandidateRequest(tickers=[], as_of_date=AS_OF)
    with pytest.raises(HTTPException) as exc_info:
        api_main.add_manual_candidate_endpoint(req)
    assert exc_info.value.status_code == 400


def test_add_manual_candidate_happy_path(_isolated_db):
    req = api_main.AddManualCandidateRequest(tickers=["ATI", "MSFT"], as_of_date=AS_OF)
    result = api_main.add_manual_candidate_endpoint(req)

    assert result["added"] == ["ATI", "MSFT"]
    assert result["failed"] == {}
    assert result["added_count"] == 2

    conn = api_main.get_connection(_isolated_db)
    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["source"] == "manual"
    assert row["ai_score"] is None


def test_add_manual_candidate_does_not_call_danelfin_at_all(_isolated_db):
    # Regression test for the whole point of the manual fallback: it must
    # work even without DANELFIN_API_KEY set / without DanelfinClient being
    # importable at all.
    with patch("src.ingestion.danelfin.DanelfinClient", side_effect=AssertionError("must not be called")):
        req = api_main.AddManualCandidateRequest(tickers=["ATI"], as_of_date=AS_OF)
        result = api_main.add_manual_candidate_endpoint(req)
    assert result["added"] == ["ATI"]


def test_add_manual_candidate_is_idempotent(_isolated_db):
    req = api_main.AddManualCandidateRequest(tickers=["ATI"], as_of_date=AS_OF)
    api_main.add_manual_candidate_endpoint(req)
    api_main.add_manual_candidate_endpoint(req)

    conn = api_main.get_connection(_isolated_db)
    rows = conn.execute(
        "SELECT * FROM candidates WHERE ticker = 'ATI' AND source = 'manual' AND date = ?", (AS_OF.isoformat(),)
    ).fetchall()
    assert len(rows) == 1


# --- /api/actions/fetch-trade-ideas ----------------------------------------

class _FakeDanelfinTradeIdeas:
    def __init__(self, *a, **kw):
        pass

    def get_trade_ideas(self, **kwargs):
        _FakeDanelfinTradeIdeas.last_call_kwargs = kwargs
        return [{"ticker": "ATI", "ai_score": 8.5, "direction": "long"}, {"ai_score": 9.0}]


@patch("src.ingestion.danelfin.DanelfinClient", _FakeDanelfinTradeIdeas)
def test_fetch_trade_ideas_happy_path_shape(_isolated_db):
    req = api_main.FetchTradeIdeasRequest(as_of_date=AS_OF, market="us", direction="long", limit=50)
    result = api_main.fetch_trade_ideas_endpoint(req)

    assert result["source"] == "danelfin_trade_ideas"
    assert result["as_of_date"] == AS_OF.isoformat()
    assert result["filters"] == {"market": "us", "direction": "long", "limit": 50}
    assert result["total_ideas"] == 2
    assert result["successful"] == ["ATI"]
    assert result["skipped_count"] == 1  # the record with no ticker
    assert result["failed_count"] == 0
    assert len(result["ideas"]) == 2

    # Confirms no ticker list is ever required/forwarded -- this is a
    # discovery endpoint, not an evaluation-of-known-tickers one.
    assert "tickers" not in _FakeDanelfinTradeIdeas.last_call_kwargs
    assert "ticker" not in _FakeDanelfinTradeIdeas.last_call_kwargs


@patch("src.ingestion.danelfin.DanelfinClient", _FakeDanelfinTradeIdeas)
def test_fetch_trade_ideas_requires_no_tickers_field_at_all(_isolated_db):
    # FetchTradeIdeasRequest simply has no `tickers` field to omit --
    # confirmed structurally, not just behaviorally.
    assert "tickers" not in api_main.FetchTradeIdeasRequest.model_fields
    req = api_main.FetchTradeIdeasRequest(as_of_date=AS_OF)
    result = api_main.fetch_trade_ideas_endpoint(req)
    assert result["filters"]["direction"] == "long"


def test_fetch_trade_ideas_missing_danelfin_key_returns_400(monkeypatch):
    monkeypatch.delenv("DANELFIN_API_KEY", raising=False)
    from fastapi import HTTPException

    req = api_main.FetchTradeIdeasRequest(as_of_date=AS_OF)
    with pytest.raises(HTTPException) as exc_info:
        api_main.fetch_trade_ideas_endpoint(req)
    assert exc_info.value.status_code == 400
    assert "DANELFIN_API_KEY" in exc_info.value.detail


@patch("src.ingestion.danelfin.DanelfinClient")
def test_fetch_trade_ideas_api_failure_is_reported_not_raised(mock_client_cls, _isolated_db):
    class _FlakyDanelfin:
        def get_trade_ideas(self, **kwargs):
            raise RuntimeError("simulated Trade Ideas API failure")
    mock_client_cls.return_value = _FlakyDanelfin()

    req = api_main.FetchTradeIdeasRequest(as_of_date=AS_OF)
    result = api_main.fetch_trade_ideas_endpoint(req)

    assert result["successful"] == []
    assert result["total_ideas"] == 0
    assert any("simulated Trade Ideas API failure" in w for w in result["warnings"])


@patch("src.ingestion.danelfin.DanelfinClient", _FakeDanelfinTradeIdeas)
def test_fetch_trade_ideas_candidate_is_upserted_correctly(_isolated_db):
    req = api_main.FetchTradeIdeasRequest(as_of_date=AS_OF)
    api_main.fetch_trade_ideas_endpoint(req)

    conn = api_main.get_connection(_isolated_db)
    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["source"] == "danelfin_trade_ideas"
    assert row["direction"] == "long"


@patch("src.ingestion.danelfin.DanelfinClient", _FakeDanelfinTradeIdeas)
def test_fetch_trade_ideas_is_idempotent(_isolated_db):
    req = api_main.FetchTradeIdeasRequest(as_of_date=AS_OF)
    api_main.fetch_trade_ideas_endpoint(req)
    api_main.fetch_trade_ideas_endpoint(req)

    conn = api_main.get_connection(_isolated_db)
    rows = conn.execute(
        "SELECT * FROM candidates WHERE ticker = 'ATI' AND source = 'danelfin_trade_ideas'"
    ).fetchall()
    assert len(rows) == 1
