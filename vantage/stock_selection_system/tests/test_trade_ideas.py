import json
from datetime import date
from unittest.mock import patch

import pytest

from src.db import init_db
from src.episodes import detect_episode_trigger
from src.ingestion.candidate_selection import TRADE_IDEAS_SOURCE, fetch_trade_ideas_candidates
from src.scoring import score_context, score_earnings, score_market

AS_OF = date(2026, 2, 2)


@pytest.fixture()
def conn(tmp_path):
    return init_db(str(tmp_path / "t.db"))


class FakeDanelfinTradeIdeas:
    """Mimics DanelfinClient.get_trade_ideas()'s interface: returns a
    canned list of raw records (or raises), and records exactly which
    filter kwargs it was called with -- everything
    fetch_trade_ideas_candidates() needs to be tested without any real
    network call."""

    def __init__(self, ideas: list = None, raise_exc: Exception = None):
        self._ideas = ideas if ideas is not None else []
        self._raise_exc = raise_exc
        self.calls = []

    def get_trade_ideas(self, **kwargs):
        self.calls.append(kwargs)
        if self._raise_exc:
            raise self._raise_exc
        return self._ideas


def test_all_valid_records_are_upserted_with_trade_ideas_source(conn):
    danelfin = FakeDanelfinTradeIdeas(ideas=[
        {"ticker": "ATI", "ai_score": 8.5, "technical_score": 7.0, "fundamental_score": 6.5,
         "expected_return": 0.12, "rank": "top_decile", "direction": "long"},
        {"ticker": "MSFT", "ai_score": 9.0, "direction": "long"},
    ])
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    assert result.source == TRADE_IDEAS_SOURCE
    assert result.total_ideas == 2
    assert result.successful == ["ATI", "MSFT"]
    assert result.skipped == []
    assert result.failed == []
    assert result.successful_count == 2

    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["source"] == "danelfin_trade_ideas"
    assert row["ai_score"] == pytest.approx(8.5)
    assert row["direction"] == "long"
    assert json.loads(row["raw_source_data"])["rank"] == "top_decile"


def test_no_ticker_input_required(conn):
    # The whole point: this can be called with ZERO tickers supplied by the
    # caller -- discovery happens entirely from what Danelfin returns.
    danelfin = FakeDanelfinTradeIdeas(ideas=[{"ticker": "ATI"}])
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)
    assert result.successful == ["ATI"]
    # No tickers were passed into get_trade_ideas() either.
    assert "tickers" not in danelfin.calls[0]
    assert "ticker" not in danelfin.calls[0]
    assert danelfin.calls[0]["direction"] == "long"


def test_filters_are_forwarded_to_the_client(conn):
    danelfin = FakeDanelfinTradeIdeas(ideas=[])
    fetch_trade_ideas_candidates(conn, AS_OF, danelfin, market="us", direction="long", limit=50)
    assert danelfin.calls[0] == {"market": "us", "direction": "long", "limit": 50}


def test_missing_ticker_field_is_skipped_not_failed(conn):
    danelfin = FakeDanelfinTradeIdeas(ideas=[{"ai_score": 9.0}])  # no ticker/symbol at all
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    assert result.successful == []
    assert result.skipped_count == 1
    assert result.failed_count == 0
    assert "no recognizable ticker" in result.skipped[0]["reason"]
    assert conn.execute("SELECT COUNT(*) AS n FROM candidates").fetchone()["n"] == 0


def test_symbol_key_is_accepted_as_a_ticker_alias(conn):
    danelfin = FakeDanelfinTradeIdeas(ideas=[{"symbol": "ati"}])
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)
    assert result.successful == ["ATI"]  # normalized to uppercase


def test_malformed_non_dict_record_is_failed(conn):
    danelfin = FakeDanelfinTradeIdeas(ideas=[["not", "a", "dict"], {"ticker": "ATI"}])
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    assert result.failed_count == 1
    assert "unexpected record shape" in result.failed[0]["reason"]
    # The one bad record didn't stop the good one after it from being processed.
    assert result.successful == ["ATI"]


def test_missing_api_key_or_batch_fetch_failure_is_reported_as_a_warning_not_raised(conn):
    danelfin = FakeDanelfinTradeIdeas(raise_exc=RuntimeError(
        "DANELFIN_API_KEY is not set. Export it in the environment or pass api_key= explicitly."
    ))
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    assert result.successful == []
    assert result.total_ideas == 0
    assert len(result.warnings) == 1
    assert "DANELFIN_API_KEY" in result.warnings[0]


def test_api_failure_mid_fetch_is_reported_as_a_warning(conn):
    danelfin = FakeDanelfinTradeIdeas(raise_exc=RuntimeError("simulated Trade Ideas API failure"))
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)
    assert "simulated Trade Ideas API failure" in result.warnings[0]


def test_rerunning_the_same_fetch_is_idempotent(conn):
    danelfin = FakeDanelfinTradeIdeas(ideas=[{"ticker": "ATI", "ai_score": 8.5}])
    fetch_trade_ideas_candidates(conn, AS_OF, danelfin)
    danelfin2 = FakeDanelfinTradeIdeas(ideas=[{"ticker": "ATI", "ai_score": 9.0}])
    result2 = fetch_trade_ideas_candidates(conn, AS_OF, danelfin2)

    assert result2.successful == ["ATI"]
    rows = conn.execute(
        "SELECT * FROM candidates WHERE ticker = 'ATI' AND source = ? AND date = ?",
        (TRADE_IDEAS_SOURCE, AS_OF.isoformat()),
    ).fetchall()
    assert len(rows) == 1  # updated in place, not duplicated
    assert rows[0]["ai_score"] == pytest.approx(9.0)


def test_duplicate_ticker_within_one_response_does_not_duplicate_rows(conn):
    # Same ticker appearing twice in one response -- still exactly one
    # candidates row, and the long-only workflow never stores a short value.
    danelfin = FakeDanelfinTradeIdeas(ideas=[
        {"ticker": "ATI", "ai_score": 7.0, "direction": "long"},
        {"ticker": "ATI", "ai_score": 8.0, "direction": "short"},
    ])
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    assert result.successful == ["ATI"]
    assert result.skipped_count == 1
    rows = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchall()
    assert len(rows) == 1
    assert rows[0]["direction"] == "long"


def test_db_error_during_upsert_is_reported_as_failed_not_raised(conn):
    danelfin = FakeDanelfinTradeIdeas(ideas=[{"ticker": "ATI", "ai_score": 8.5}])
    with patch("src.ingestion.candidate_selection.upsert_candidate", side_effect=RuntimeError("db is locked")):
        result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    assert result.successful == []
    assert result.failed_count == 1
    assert "db is locked" in result.failed[0]["reason"]


def test_ideas_preview_includes_every_record_with_its_status(conn):
    danelfin = FakeDanelfinTradeIdeas(ideas=[
        {"ticker": "ATI", "ai_score": 8.5},
        {"ai_score": 9.0},           # skipped -- no ticker
        ["not", "a", "dict"],        # failed -- malformed
    ])
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    assert len(result.ideas) == 3
    assert [row["status"] for row in result.ideas] == ["successful", "skipped", "failed"]
    assert result.ideas[0]["ticker"] == "ATI"


def test_trade_idea_candidate_triggers_the_existing_eligibility_workflow(conn):
    # Confirms the discovery workflow's whole point: a Trade-Ideas-sourced
    # candidates row must feed the SAME downstream pipeline as any other
    # source -- detect_episode_trigger() surfaces a first_eligibility
    # trigger for it exactly like a manually-added or select_candidates()
    # -sourced row would (episodes.py doesn't filter by source).
    danelfin = FakeDanelfinTradeIdeas(ideas=[{"ticker": "ATI"}])
    fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    trigger = detect_episode_trigger(conn, "ATI", AS_OF)
    assert trigger is not None
    assert trigger.episode_trigger == "first_eligibility"
    assert trigger.eligibility_date == AS_OF


def test_danelfin_trade_ideas_scores_never_feed_the_frozen_scoring_functions(conn):
    import inspect
    danelfin = FakeDanelfinTradeIdeas(ideas=[{
        "ticker": "ATI", "ai_score": 9.9, "technical_score": 9.9, "fundamental_score": 9.9,
        "expected_return": 0.99, "direction": "long",
    }])
    fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    for fn in (score_earnings, score_market, score_context):
        src = inspect.getsource(fn)
        assert "candidates" not in src
        assert "ai_score" not in src
        assert "danelfin" not in src.lower()


def test_partial_pagination_result_is_processed_and_reported_as_a_warning(conn):
    # LIVE-CONFIRMED bug fix: danelfin.get_trade_ideas() can return a
    # TradeIdeasPartialResult (a list subclass with `.partial_error` set)
    # when pagination was cut short by a later-page failure (e.g. a 429).
    # fetch_trade_ideas_candidates() must still process every item that WAS
    # returned (not discard them) while also surfacing the truncation as a
    # warning -- never silently losing results OR silently ignoring the error.
    from src.ingestion.danelfin import TradeIdeasPartialResult

    partial = TradeIdeasPartialResult(
        [{"ticker": "ATI", "ai_score": 8.5}],
        partial_error="stopped after 1 page(s) (1 item(s) fetched) -- request for offset=100 failed: 429 Client Error",
    )
    danelfin = FakeDanelfinTradeIdeas(ideas=partial)
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin)

    assert result.successful == ["ATI"]
    assert result.total_ideas == 1
    assert len(result.warnings) == 1
    assert "truncated" in result.warnings[0]
    assert "offset=100" in result.warnings[0]

    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row is not None
    assert row["source"] == TRADE_IDEAS_SOURCE


def test_to_dict_shape(conn):
    danelfin = FakeDanelfinTradeIdeas(ideas=[{"ticker": "ATI", "ai_score": 8.5}])
    result = fetch_trade_ideas_candidates(conn, AS_OF, danelfin, market="us")
    d = result.to_dict()
    assert d["source"] == "danelfin_trade_ideas"
    assert d["as_of_date"] == AS_OF.isoformat()
    assert d["filters"] == {"market": "us"}
    assert d["total_ideas"] == 1
    assert d["successful"] == ["ATI"]
    assert d["skipped"] == []
    assert d["failed"] == []
    assert d["warnings"] == []
    assert d["successful_count"] == 1 and d["skipped_count"] == 0 and d["failed_count"] == 0
    assert len(d["ideas"]) == 1
