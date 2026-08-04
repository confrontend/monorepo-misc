from datetime import date
from unittest.mock import patch

import pytest

from src.db import init_db
from src.ingestion.candidate_selection import add_manual_candidates, fetch_best_stocks_candidates, select_candidates
from src.episodes import detect_episode_trigger
from src.scoring import score_earnings, score_market, score_context

AS_OF = date(2026, 2, 2)


@pytest.fixture()
def conn(tmp_path):
    return init_db(str(tmp_path / "t.db"))


class FakeDanelfin:
    """Mimics DanelfinClient's get_candidate() interface: returns a canned
    row per ticker, can raise for specific tickers, and can return
    empty/malformed rows for others -- everything select_candidates() needs
    to isolate and classify per ticker."""

    def __init__(self, rows: dict = None, raise_for: set = frozenset()):
        self._rows = rows or {}
        self._raise_for = raise_for
        self.requested = []

    def get_candidate(self, ticker, as_of=None):
        self.requested.append(ticker)
        if ticker in self._raise_for:
            raise RuntimeError(f"simulated Danelfin failure for {ticker}")
        return self._rows.get(ticker, {"ticker": ticker})


class FakeBestStocksDanelfin:
    def get_best_stocks(self):
        return [{
            "ticker": "ATI", "rank": 3, "aiscore": 8, "technical": 7,
            "fundamental": 9, "sentiment": 6, "low_risk": 5,
            "perf_ytd": 12.5, "date": "2026-02-01",
        }]


def test_best_stocks_candidates_store_official_rank_and_scores(conn):
    result = fetch_best_stocks_candidates(conn, AS_OF, FakeBestStocksDanelfin())
    assert result["successful"] == ["ATI"]
    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["source"] == "danelfin_beststocks"
    assert row["source_rank"] == "3"
    assert row["ai_score"] == pytest.approx(8)
    assert row["technical_score"] == pytest.approx(7)
    assert row["fundamental_score"] == pytest.approx(9)


def test_all_successful_upserts_every_ticker(conn):
    danelfin = FakeDanelfin(rows={
        "ATI": {"ticker": "ATI", "ai_score": 8.5, "technical_score": 7.0, "fundamental_score": 6.5,
                "expected_return": 0.12, "rank": "top_decile"},
        "MSFT": {"ticker": "MSFT", "ai_score": 9.0, "technical_score": 8.0, "fundamental_score": 8.5,
                 "expected_return": 0.08, "rank": "top_decile"},
    })
    result = select_candidates(conn, ["ATI", "MSFT"], AS_OF, danelfin)

    assert result.requested == ["ATI", "MSFT"]
    assert result.successful == ["ATI", "MSFT"]
    assert result.skipped == []
    assert result.failed == {}
    assert result.successful_count == 2 and result.skipped_count == 0 and result.failed_count == 0

    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["date"] == AS_OF.isoformat()
    assert row["source"] == "danelfin"
    assert row["source_rank"] == "top_decile"
    assert row["ai_score"] == pytest.approx(8.5)
    assert row["technical_score"] == pytest.approx(7.0)
    assert row["fundamental_score"] == pytest.approx(6.5)
    assert row["expected_return"] == pytest.approx(0.12)


def test_ticker_with_no_data_is_skipped_not_failed(conn):
    danelfin = FakeDanelfin(rows={"ATI": {}})  # empty dict -> "no ranking today"
    result = select_candidates(conn, ["ATI"], AS_OF, danelfin)

    assert result.successful == []
    assert result.skipped == ["ATI"]
    assert result.failed == {}
    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row is None


def test_ticker_with_none_response_is_skipped(conn):
    danelfin = FakeDanelfin(rows={"ATI": None})
    result = select_candidates(conn, ["ATI"], AS_OF, danelfin)
    assert result.skipped == ["ATI"]


def test_network_failure_is_reported_as_failed_with_clear_message(conn):
    danelfin = FakeDanelfin(raise_for={"ATI"})
    result = select_candidates(conn, ["ATI"], AS_OF, danelfin)

    assert result.successful == []
    assert result.skipped == []
    assert "ATI" in result.failed
    assert "simulated Danelfin failure for ATI" in result.failed["ATI"]


def test_malformed_non_dict_response_is_failed_with_the_raw_value_in_the_message(conn):
    danelfin = FakeDanelfin(rows={"ATI": ["not", "a", "dict"]})
    result = select_candidates(conn, ["ATI"], AS_OF, danelfin)

    assert result.failed_count == 1
    assert "unexpected response shape" in result.failed["ATI"]
    assert "list" in result.failed["ATI"]


def test_one_ticker_failing_does_not_abort_the_batch(conn):
    danelfin = FakeDanelfin(
        rows={"MSFT": {"ticker": "MSFT", "ai_score": 9.0}},
        raise_for={"ATI"},
    )
    result = select_candidates(conn, ["ATI", "MSFT"], AS_OF, danelfin)

    assert danelfin.requested == ["ATI", "MSFT"]  # MSFT was still attempted
    assert result.successful == ["MSFT"]
    assert "ATI" in result.failed
    assert conn.execute("SELECT * FROM candidates WHERE ticker = 'MSFT'").fetchone() is not None


def test_missing_optional_score_fields_still_succeeds_with_nulls(conn):
    # Spec: rank/scores/expected_return are "if available" -- only `ticker`
    # is required. A row with just a ticker must still succeed.
    danelfin = FakeDanelfin(rows={"ATI": {"ticker": "ATI"}})
    result = select_candidates(conn, ["ATI"], AS_OF, danelfin)

    assert result.successful == ["ATI"]
    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["source_rank"] is None
    assert row["ai_score"] is None
    assert row["technical_score"] is None
    assert row["fundamental_score"] is None
    assert row["expected_return"] is None


def test_unparseable_score_field_falls_back_to_null_rather_than_failing(conn):
    danelfin = FakeDanelfin(rows={"ATI": {"ticker": "ATI", "ai_score": "not-a-number"}})
    result = select_candidates(conn, ["ATI"], AS_OF, danelfin)

    assert result.successful == ["ATI"]
    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["ai_score"] is None


def test_source_rank_falls_back_to_source_rank_key(conn):
    danelfin = FakeDanelfin(rows={"ATI": {"ticker": "ATI", "source_rank": "decile_2"}})
    select_candidates(conn, ["ATI"], AS_OF, danelfin)
    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["source_rank"] == "decile_2"


def test_rerunning_the_same_request_is_idempotent(conn):
    danelfin = FakeDanelfin(rows={"ATI": {"ticker": "ATI", "ai_score": 8.5}})
    select_candidates(conn, ["ATI"], AS_OF, danelfin)
    # Re-run with updated data for the same (date, ticker, source) key.
    danelfin2 = FakeDanelfin(rows={"ATI": {"ticker": "ATI", "ai_score": 9.0}})
    result2 = select_candidates(conn, ["ATI"], AS_OF, danelfin2)

    assert result2.successful == ["ATI"]
    rows = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI' AND date = ?", (AS_OF.isoformat(),)).fetchall()
    assert len(rows) == 1  # updated in place, not duplicated
    assert rows[0]["ai_score"] == pytest.approx(9.0)


def test_db_error_during_upsert_is_reported_as_failed_not_raised(conn):
    danelfin = FakeDanelfin(rows={"ATI": {"ticker": "ATI", "ai_score": 8.5}})
    with patch("src.ingestion.candidate_selection.upsert_candidate", side_effect=RuntimeError("db is locked")):
        result = select_candidates(conn, ["ATI"], AS_OF, danelfin)

    assert result.successful == []
    assert "failed to store candidate" in result.failed["ATI"]
    assert "db is locked" in result.failed["ATI"]


def test_to_dict_shape(conn):
    danelfin = FakeDanelfin(rows={"ATI": {"ticker": "ATI", "ai_score": 8.5}})
    result = select_candidates(conn, ["ATI"], AS_OF, danelfin)
    d = result.to_dict()
    assert d == {
        "as_of_date": AS_OF.isoformat(),
        "requested": ["ATI"],
        "successful": ["ATI"],
        "skipped": [],
        "failed": {},
        "successful_count": 1,
        "skipped_count": 0,
        "failed_count": 0,
    }


def test_danelfin_scores_never_feed_the_frozen_scoring_functions(conn):
    # Regression/contract test for the spec's hardest rule: Danelfin data
    # must never enter Earnings/Market/Context scoring. select_candidates()
    # only ever writes to `candidates`; none of score_earnings/score_market/
    # score_context read from that table at all -- confirmed here by
    # checking their source doesn't reference "candidates" or Danelfin
    # fields, so a future edit that accidentally wires Danelfin into scoring
    # would have to change scoring.py itself (which this test would then
    # need to be updated to catch some other way -- this is a documentation-
    # level guardrail, not a runtime one).
    import inspect
    danelfin = FakeDanelfin(rows={"ATI": {
        "ticker": "ATI", "ai_score": 9.9, "technical_score": 9.9, "fundamental_score": 9.9, "expected_return": 0.99,
    }})
    select_candidates(conn, ["ATI"], AS_OF, danelfin)

    for fn in (score_earnings, score_market, score_context):
        src = inspect.getsource(fn)
        assert "candidates" not in src
        assert "ai_score" not in src
        assert "danelfin" not in src.lower()


# --- add_manual_candidates() (requirement 4: manual fallback) --------------

def test_add_manual_candidates_stores_with_source_manual_and_null_scores(conn):
    result = add_manual_candidates(conn, ["ATI"], AS_OF)

    assert result.requested == ["ATI"]
    assert result.added == ["ATI"]
    assert result.failed == {}
    assert result.added_count == 1 and result.failed_count == 0

    row = conn.execute("SELECT * FROM candidates WHERE ticker = 'ATI'").fetchone()
    assert row["date"] == AS_OF.isoformat()
    assert row["source"] == "manual"
    assert row["ai_score"] is None
    assert row["technical_score"] is None
    assert row["fundamental_score"] is None
    assert row["expected_return"] is None
    assert row["source_rank"] is None


def test_add_manual_candidates_never_calls_danelfin():
    # The whole point of the manual path -- it must not require a
    # DanelfinClient/DANELFIN_API_KEY at all. Passing no danelfin argument
    # confirms the function signature itself doesn't need one.
    import inspect
    sig = inspect.signature(add_manual_candidates)
    assert "danelfin" not in sig.parameters


def test_add_manual_candidates_handles_multiple_tickers_independently(conn):
    result = add_manual_candidates(conn, ["ATI", "MSFT"], AS_OF)
    assert result.added == ["ATI", "MSFT"]
    assert conn.execute("SELECT COUNT(*) AS n FROM candidates").fetchone()["n"] == 2


def test_add_manual_candidates_rejects_blank_ticker_without_aborting_batch(conn):
    result = add_manual_candidates(conn, ["ATI", "  ", ""], AS_OF)
    assert result.added == ["ATI"]
    assert result.failed_count == 2


def test_add_manual_candidates_is_idempotent(conn):
    add_manual_candidates(conn, ["ATI"], AS_OF)
    result2 = add_manual_candidates(conn, ["ATI"], AS_OF)
    assert result2.added == ["ATI"]
    rows = conn.execute(
        "SELECT * FROM candidates WHERE ticker = 'ATI' AND source = 'manual' AND date = ?", (AS_OF.isoformat(),)
    ).fetchall()
    assert len(rows) == 1


def test_manual_candidate_enters_the_same_tracking_pipeline_as_danelfin(conn):
    # Confirms the spec's requirement 4 promise: a manually-added ticker
    # "should place the ticker into the same candidates table and allow the
    # normal tracking pipeline to process it" -- detect_episode_trigger()
    # must surface a first_eligibility trigger for it exactly like it would
    # for a Danelfin-sourced row (episodes.py doesn't filter by source at
    # all when looking up the earliest candidates row).
    add_manual_candidates(conn, ["ATI"], AS_OF)
    trigger = detect_episode_trigger(conn, "ATI", AS_OF)
    assert trigger is not None
    assert trigger.episode_trigger == "first_eligibility"
    assert trigger.eligibility_date == AS_OF


def test_manual_candidates_to_dict_shape(conn):
    result = add_manual_candidates(conn, ["ATI"], AS_OF)
    assert result.to_dict() == {
        "as_of_date": AS_OF.isoformat(),
        "requested": ["ATI"],
        "added": ["ATI"],
        "failed": {},
        "added_count": 1,
        "failed_count": 0,
    }
