import sqlite3

import pytest

from src.db import init_db


@pytest.fixture()
def conn(tmp_path):
    db_path = str(tmp_path / "test.db")
    return init_db(db_path)


def test_foreign_keys_enforced(conn):
    row = conn.execute("PRAGMA foreign_keys;").fetchone()
    assert row[0] == 1


def test_fk_violation_rejected(conn):
    # episode_entries.episode_id FK -> reviews.episode_id; no such review exists.
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, "
            "spy_entry_open, sector_entry_open, sector_benchmark_ticker) "
            "VALUES ('nonexistent', '2026-01-06', 1.0, 1.0, 1.0, 'XLI')"
        )


def _insert_review(conn, episode_id="ep-1"):
    conn.execute(
        "INSERT INTO reviews (episode_id, decision_timestamp_utc, rule_version, review_date, "
        "ticker, episode_trigger, earnings_score, market_score, context_score, total_score, "
        "red_flag, earnings_within_5d, decision, confidence) "
        "VALUES (?, '2026-01-06T10:00:00Z', 'v1', '2026-01-06', 'ATI', 'first_eligibility', "
        "1, 1, 0, 2, 0, 0, 'Confirm', 'Confirm')",
        (episode_id,),
    )
    conn.commit()


def test_reviews_update_blocked(conn):
    _insert_review(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE reviews SET decision = 'Reject' WHERE episode_id = 'ep-1'")


def test_reviews_delete_blocked(conn):
    _insert_review(conn)
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM reviews WHERE episode_id = 'ep-1'")


def test_episode_entries_update_blocked(conn):
    _insert_review(conn)
    conn.execute(
        "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, "
        "spy_entry_open, sector_entry_open, sector_benchmark_ticker) "
        "VALUES ('ep-1', '2026-01-07', 10.0, 500.0, 100.0, 'XLI')"
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE episode_entries SET stock_entry_open = 11.0 WHERE episode_id = 'ep-1'")


def test_episode_entries_delete_blocked(conn):
    _insert_review(conn)
    conn.execute(
        "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, "
        "spy_entry_open, sector_entry_open, sector_benchmark_ticker) "
        "VALUES ('ep-1', '2026-01-07', 10.0, 500.0, 100.0, 'XLI')"
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM episode_entries WHERE episode_id = 'ep-1'")


def test_episode_entries_unique_per_episode(conn):
    _insert_review(conn)
    conn.execute(
        "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, "
        "spy_entry_open, sector_entry_open, sector_benchmark_ticker) "
        "VALUES ('ep-1', '2026-01-07', 10.0, 500.0, 100.0, 'XLI')"
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, "
            "spy_entry_open, sector_entry_open, sector_benchmark_ticker) "
            "VALUES ('ep-1', '2026-01-08', 12.0, 501.0, 101.0, 'XLI')"
        )


def test_outcomes_update_delete_blocked(conn):
    _insert_review(conn)
    conn.execute(
        "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, "
        "spy_entry_open, sector_entry_open, sector_benchmark_ticker) "
        "VALUES ('ep-1', '2026-01-07', 10.0, 500.0, 100.0, 'XLI')"
    )
    conn.execute(
        "INSERT INTO recommendation_outcomes (episode_id, measurement_date, horizon_days, "
        "exit_date, stock_exit_close, spy_exit_close, sector_exit_close, stock_return, "
        "spy_return, sector_return) VALUES ('ep-1', '2026-01-16', 7, '2026-01-16', 11.0, 510.0, "
        "101.0, 0.1, 0.02, 0.01)"
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("UPDATE recommendation_outcomes SET stock_return = 0.2 WHERE episode_id = 'ep-1'")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("DELETE FROM recommendation_outcomes WHERE episode_id = 'ep-1'")


def test_outcomes_unique_per_episode_horizon(conn):
    _insert_review(conn)
    conn.execute(
        "INSERT INTO episode_entries (episode_id, entry_date, stock_entry_open, "
        "spy_entry_open, sector_entry_open, sector_benchmark_ticker) "
        "VALUES ('ep-1', '2026-01-07', 10.0, 500.0, 100.0, 'XLI')"
    )
    conn.execute(
        "INSERT INTO recommendation_outcomes (episode_id, measurement_date, horizon_days, "
        "exit_date, stock_exit_close, spy_exit_close, sector_exit_close, stock_return, "
        "spy_return, sector_return) VALUES ('ep-1', '2026-01-16', 7, '2026-01-16', 11.0, 510.0, "
        "101.0, 0.1, 0.02, 0.01)"
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO recommendation_outcomes (episode_id, measurement_date, horizon_days, "
            "exit_date, stock_exit_close, spy_exit_close, sector_exit_close, stock_return, "
            "spy_return, sector_return) VALUES ('ep-1', '2026-01-16', 7, '2026-01-16', 12.0, "
            "511.0, 102.0, 0.2, 0.03, 0.02)"
        )


def test_unique_unresolved_audit_case_blocks_duplicate(conn):
    conn.execute(
        "INSERT INTO insufficient_data_cases (ticker, as_of_date, episode_trigger, "
        "eligibility_date, resolved) VALUES ('ATI', '2026-01-06', 'first_eligibility', "
        "'2026-01-06', FALSE)"
    )
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO insufficient_data_cases (ticker, as_of_date, episode_trigger, "
            "eligibility_date, resolved) VALUES ('ATI', '2026-01-07', 'first_eligibility', "
            "'2026-01-06', FALSE)"
        )


def test_unique_unresolved_audit_case_allows_after_resolution(conn):
    conn.execute(
        "INSERT INTO insufficient_data_cases (ticker, as_of_date, episode_trigger, "
        "eligibility_date, resolved) VALUES ('ATI', '2026-01-06', 'first_eligibility', "
        "'2026-01-06', TRUE)"
    )
    conn.commit()
    # resolved=TRUE rows aren't covered by the partial unique index, so a new
    # unresolved case for the same key is allowed.
    conn.execute(
        "INSERT INTO insufficient_data_cases (ticker, as_of_date, episode_trigger, "
        "eligibility_date, resolved) VALUES ('ATI', '2026-01-08', 'first_eligibility', "
        "'2026-01-06', FALSE)"
    )
    conn.commit()


def _insert_case(conn, ticker="ATI"):
    cur = conn.execute(
        "INSERT INTO insufficient_data_cases (ticker, as_of_date, episode_trigger, "
        "eligibility_date, resolved) VALUES (?, '2026-01-06', 'first_eligibility', "
        "'2026-01-06', FALSE)",
        (ticker,),
    )
    conn.commit()
    return cur.lastrowid


def _insert_review_resolving(conn, episode_id, audit_id):
    conn.execute(
        "INSERT INTO reviews (episode_id, decision_timestamp_utc, rule_version, review_date, "
        "ticker, episode_trigger, resolved_from_audit_id, earnings_score, market_score, "
        "context_score, total_score, red_flag, earnings_within_5d, decision, confidence) "
        "VALUES (?, '2026-01-06T10:00:00Z', 'v1', '2026-01-06', 'ATI', 'first_eligibility', "
        "?, 1, 1, 0, 2, 0, 0, 'Confirm', 'Confirm')",
        (episode_id, audit_id),
    )


def test_resolved_from_audit_id_rejects_second_review_for_same_case(conn):
    audit_id = _insert_case(conn)
    _insert_review_resolving(conn, "ep-1", audit_id)
    conn.commit()
    with pytest.raises(sqlite3.IntegrityError):
        _insert_review_resolving(conn, "ep-2", audit_id)


def test_resolved_from_audit_id_allows_multiple_nulls(conn):
    # The overwhelming majority of reviews rows don't resolve any audit case
    # (resolved_from_audit_id is NULL) -- SQL's NULL != NULL semantics mean
    # the UNIQUE index must NOT reject multiple NULLs, unlike the
    # unique_unresolved_audit_case index which deliberately forces NULLs to
    # collide via COALESCE. No COALESCE here: NULL-distinctness is exactly
    # the wanted behavior for this column.
    _insert_review(conn, "ep-1")
    _insert_review(conn, "ep-2")  # both NULL resolved_from_audit_id; must not conflict
    rows = conn.execute("SELECT COUNT(*) AS n FROM reviews").fetchone()
    assert rows["n"] == 2


def test_insufficient_data_fields_one_row_per_missing_field(conn):
    cur = conn.execute(
        "INSERT INTO insufficient_data_cases (ticker, as_of_date, episode_trigger, "
        "eligibility_date, resolved) VALUES ('ATI', '2026-01-06', 'first_eligibility', "
        "'2026-01-06', FALSE)"
    )
    audit_id = cur.lastrowid
    conn.execute(
        "INSERT INTO insufficient_data_fields (audit_id, missing_group, missing_field) "
        "VALUES (?, 'earnings', 'eps_estimate_30d_ago')",
        (audit_id,),
    )
    conn.execute(
        "INSERT INTO insufficient_data_fields (audit_id, missing_group, missing_field) "
        "VALUES (?, 'market', 'spy_return_3m')",
        (audit_id,),
    )
    conn.commit()
    rows = conn.execute(
        "SELECT * FROM insufficient_data_fields WHERE audit_id = ?", (audit_id,)
    ).fetchall()
    assert len(rows) == 2
