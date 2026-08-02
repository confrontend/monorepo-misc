"""
Episode-trigger detection (Section 10) and the pipeline that writes immutable
`reviews` rows: check_required_inputs -> score groups -> decide -> write.

Episode-trigger detection covers the 8 triggers listed in Section 10:
  1. first eligibility (stock enters the candidate list for the first time)
  2. earnings released
  3. formal guidance changes (raised/cut -- 'maintained' is not a change)
  4. the decision label changes
  5. M&A announced
  6. CEO or CFO departs unexpectedly
  7. an SEC/regulatory investigation begins
  8. a major contract win or loss

Known open item (documented, not silently resolved): trigger #4, "the decision
label changes," is inherently circular if treated as an independent detector --
you would need to score the stock to know whether its label changed, but
scoring is supposed to happen only *after* a trigger fires, and Section 10
explicitly says routine daily re-checks of an unchanged stock must NOT create
a new episode. This prototype resolves the tension by NOT auto-detecting label
changes as part of routine trigger scanning (`detect_episode_trigger`), and
instead exposing `force_rescore()` as an explicit, operator-invoked action
(e.g. run manually or on a much coarser cadence than the daily job) that scores
the stock once and only creates a new 'decision_label_change' episode if the
freshly computed label actually differs from the most recent episode's
decision. This keeps the four other, cheaply-observable triggers as the
routine daily detection path.
"""
from __future__ import annotations

import sqlite3
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timezone
from typing import Optional

from .required_inputs import (
    RequiredInputsResult,
    check_required_inputs,
    record_insufficient_data_case,
)
from .scoring import (
    check_earnings_within_5d,
    compute_red_flag,
    decide,
    score_context,
    score_earnings,
    score_market,
)
from .trading_calendar import TradingCalendar, default_calendar

RULE_VERSION = "v1"
MAX_TRIGGERS_PER_CALL = 25  # safety cap against runaway loops; realistic
                            # catch-up gaps are a handful of events at most

GUIDANCE_CHANGE_DIRECTIONS = {"raised", "cut"}
MATERIAL_EVENT_TRIGGER_MAP = {
    "M&A": "ma_announced",
    "CEO_departure": "ceo_cfo_departure",
    "CFO_departure": "ceo_cfo_departure",
    "investigation": "investigation_start",
    "contract_win": "contract_win_loss",
    "contract_loss": "contract_win_loss",
}


def _parse_date(v) -> Optional[date]:
    if v is None:
        return None
    if isinstance(v, date):
        return v
    return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()


@dataclass
class TriggerInfo:
    episode_trigger: str
    eligibility_date: date
    source_candidate_id: Optional[int] = None
    source_table: str = ""
    source_row_id: int = 0


def _last_episode(conn: sqlite3.Connection, ticker: str) -> Optional[sqlite3.Row]:
    """Most recently SCORED episode (by decision_timestamp_utc) -- used by
    force_rescore() to compare "would the label change." Unrelated to trigger
    detection; see detect_episode_trigger()/_is_consumed()."""
    return conn.execute(
        "SELECT * FROM reviews WHERE ticker = ? ORDER BY decision_timestamp_utc DESC LIMIT 1",
        (ticker,),
    ).fetchone()


def _is_consumed(conn: sqlite3.Connection, ticker: str, source_table: str, source_row_id: int) -> bool:
    """Whether this specific source event row has already been turned into an
    episode (or is pending resolution via a preserved insufficient_data_cases
    trigger_source_table/trigger_source_row_id -- see record_insufficient_data_case).
    This is per-EVENT-IDENTITY, not per-date: two distinct events dated on the
    identical calendar day are two distinct rows here, so neither one being
    consumed affects whether the other is still pending. This is what allows
    same-day trigger events to each get their own episode, unlike a
    date-only cursor."""
    row = conn.execute(
        "SELECT 1 FROM consumed_triggers WHERE ticker = ? AND source_table = ? AND source_row_id = ?",
        (ticker, source_table, source_row_id),
    ).fetchone()
    if row is not None:
        return True
    row = conn.execute(
        "SELECT 1 FROM insufficient_data_cases WHERE ticker = ? AND trigger_source_table = ? "
        "AND trigger_source_row_id = ? AND resolved = FALSE",
        (ticker, source_table, source_row_id),
    ).fetchone()
    return row is not None


def _first_eligibility_floor(conn: sqlite3.Connection, ticker: str) -> Optional[tuple[date, Optional[TriggerInfo]]]:
    """Returns (floor_date, pending_first_eligibility_trigger_or_None). The
    floor is the date this ticker first became an eligible candidate -- events
    from OTHER trigger sources dated before that floor predate the system
    ever tracking the stock and must not retroactively spawn an episode, so
    only earnings/guidance/material events on or after this floor are
    considered pending. Returns None if the ticker has never been (and still
    isn't, as of the caller's as_of_date) an eligible candidate at all, in
    which case no trigger of any kind applies yet."""
    consumed_first = conn.execute(
        "SELECT eligibility_date FROM consumed_triggers WHERE ticker = ? AND source_table = 'candidates' "
        "ORDER BY eligibility_date ASC LIMIT 1",
        (ticker,),
    ).fetchone()
    if consumed_first is not None:
        return _parse_date(consumed_first["eligibility_date"]), None

    # Not yet consumed -- may still be sitting in an open insufficient_data_cases
    # row (preserves its own eligibility_date/source identity) or genuinely
    # still pending detection.
    open_case = conn.execute(
        "SELECT eligibility_date FROM insufficient_data_cases WHERE ticker = ? AND "
        "trigger_source_table = 'candidates' AND resolved = FALSE ORDER BY eligibility_date ASC LIMIT 1",
        (ticker,),
    ).fetchone()
    if open_case is not None:
        return _parse_date(open_case["eligibility_date"]), None

    return None


def detect_episode_trigger(conn: sqlite3.Connection, ticker: str, as_of_date: date) -> Optional[TriggerInfo]:
    """Checks, for a given ticker on a given date, whether any Section 10
    trigger event exists (dated on or before as_of_date, and on or after the
    date this ticker first became an eligible candidate) that has not already
    been consumed by a prior episode or a still-open insufficient_data_cases
    case. Returns the earliest-dated (then most-stable-ordered) qualifying
    trigger still pending, or None if none is pending (in which case the
    caller must NOT create a new reviews row). Call this repeatedly (as
    run_episode() does) to work through multiple pending triggers one at a
    time -- each processed trigger is recorded in consumed_triggers, so the
    next call surfaces whichever trigger is next.

    Unlike a date-based cursor, this scans every qualifying row up to
    as_of_date and filters by per-row consumption, so two distinct trigger
    events dated on the SAME calendar day (e.g. an earnings release and a
    guidance change both on 2026-01-10) each surface as their own pending
    trigger rather than the second being silently dropped once the first
    advances a same-day cursor."""
    pending: list[TriggerInfo] = []

    candidate = conn.execute(
        "SELECT candidate_id, date FROM candidates WHERE ticker = ? AND date <= ? "
        "ORDER BY date ASC LIMIT 1",
        (ticker, as_of_date.isoformat()),
    ).fetchone()
    if candidate is not None and not _is_consumed(conn, ticker, "candidates", candidate["candidate_id"]):
        pending.append(TriggerInfo(
            episode_trigger="first_eligibility",
            eligibility_date=_parse_date(candidate["date"]),
            source_candidate_id=candidate["candidate_id"],
            source_table="candidates",
            source_row_id=candidate["candidate_id"],
        ))

    floor = _first_eligibility_floor(conn, ticker)
    if floor is None:
        # Ticker has never been an eligible candidate as of as_of_date -- the
        # only possible pending trigger is first_eligibility itself, already
        # captured above (or nothing, if it isn't a candidate yet either).
        pending.sort(key=lambda t: (t.eligibility_date, t.source_table, t.source_row_id))
        return pending[0] if pending else None
    floor_date, _ = floor

    earnings_rows = conn.execute(
        "SELECT rowid AS rid, report_date FROM earnings_history WHERE ticker = ? "
        "AND report_date >= ? AND report_date <= ? ORDER BY report_date ASC",
        (ticker, floor_date.isoformat(), as_of_date.isoformat()),
    ).fetchall()
    for row in earnings_rows:
        if not _is_consumed(conn, ticker, "earnings_history", row["rid"]):
            pending.append(TriggerInfo(
                "earnings_release", _parse_date(row["report_date"]),
                source_table="earnings_history", source_row_id=row["rid"],
            ))

    guidance_rows = conn.execute(
        "SELECT event_id, event_date FROM guidance_events WHERE ticker = ? AND "
        "event_date >= ? AND event_date <= ? AND guidance_direction IN ('raised','cut') ORDER BY event_date ASC",
        (ticker, floor_date.isoformat(), as_of_date.isoformat()),
    ).fetchall()
    for row in guidance_rows:
        if not _is_consumed(conn, ticker, "guidance_events", row["event_id"]):
            pending.append(TriggerInfo(
                "guidance_change", _parse_date(row["event_date"]),
                source_table="guidance_events", source_row_id=row["event_id"],
            ))

    material_rows = conn.execute(
        "SELECT event_id, event_date, event_type FROM material_events WHERE ticker = ? "
        "AND event_date >= ? AND event_date <= ? ORDER BY event_date ASC",
        (ticker, floor_date.isoformat(), as_of_date.isoformat()),
    ).fetchall()
    for row in material_rows:
        trigger_name = MATERIAL_EVENT_TRIGGER_MAP.get(row["event_type"])
        if trigger_name is not None and not _is_consumed(conn, ticker, "material_events", row["event_id"]):
            pending.append(TriggerInfo(
                trigger_name, _parse_date(row["event_date"]),
                source_table="material_events", source_row_id=row["event_id"],
            ))

    if not pending:
        return None

    pending.sort(key=lambda t: (t.eligibility_date, t.source_table, t.source_row_id))
    return pending[0]


@dataclass
class ScoringOutcome:
    required: RequiredInputsResult
    earnings_score: Optional[int] = None
    earnings_fact: Optional[str] = None
    market_score: Optional[int] = None
    market_fact: Optional[str] = None
    context_score: Optional[int] = None
    context_fact: Optional[str] = None
    total_score: Optional[int] = None
    red_flag: Optional[bool] = None
    earnings_within_5d: Optional[bool] = None
    decision: Optional[str] = None
    confidence: Optional[str] = None


def _score_ticker(conn: sqlite3.Connection, calendar: TradingCalendar, ticker: str, as_of_date: date) -> ScoringOutcome:
    required = check_required_inputs(conn, ticker, as_of_date, calendar=calendar)
    outcome = ScoringOutcome(required=required)
    if not required.ok:
        return outcome

    r = required.resolved
    outcome.earnings_score, outcome.earnings_fact = score_earnings(
        r.latest_actual_eps, r.latest_estimated_eps, r.eps_estimate_30d_ago, r.eps_estimate_now
    )
    outcome.market_score, outcome.market_fact = score_market(
        r.price, r.ma_50, r.ma_200, r.excess_return_3m, r.volume, r.avg_volume_30d, r.high_volume_breakdown
    )
    outcome.context_score, outcome.context_fact = score_context(
        ticker, as_of_date, r.last_earnings_release_date, r.guidance_events, r.insider_purchases,
        r.material_events, calendar=calendar,
    )
    outcome.red_flag = compute_red_flag(outcome.context_score)
    outcome.earnings_within_5d = check_earnings_within_5d(
        ticker, as_of_date, r.next_scheduled_report_date, calendar=calendar
    )
    outcome.total_score = outcome.earnings_score + outcome.market_score + outcome.context_score
    outcome.decision, outcome.confidence = decide(
        outcome.earnings_score, outcome.market_score, outcome.context_score,
        outcome.red_flag, outcome.earnings_within_5d,
    )
    return outcome


def _write_review(
    conn: sqlite3.Connection,
    ticker: str,
    as_of_date: date,
    episode_trigger: str,
    eligibility_date: date,
    outcome: ScoringOutcome,
    resolved_from_audit_id: Optional[int] = None,
    corrects_episode_id: Optional[str] = None,
    decision_timestamp_utc: Optional[datetime] = None,
    commit: bool = True,
    source_table: Optional[str] = None,
    source_row_id: Optional[int] = None,
) -> str:
    episode_id = str(uuid.uuid4())
    if decision_timestamp_utc is None:
        # Default the DATE component to as_of_date (the date this episode is
        # actually about) while keeping a real-ish time-of-day component, so
        # next_market_open_after's pre-open/post-open branching stays
        # meaningful. In live usage as_of_date == today, so this is just
        # "now." In backtest/demo usage where as_of_date is an arbitrary past
        # date, this avoids stamping a historical decision with the wall-clock
        # *date*, which would silently send entry-price lookups months into
        # the future.
        decision_timestamp_utc = datetime.combine(as_of_date, datetime.now(timezone.utc).time(), tzinfo=timezone.utc)
    ts = decision_timestamp_utc.isoformat()
    conn.execute(
        "INSERT INTO reviews (episode_id, decision_timestamp_utc, rule_version, review_date, "
        "ticker, episode_trigger, eligibility_date, resolved_from_audit_id, corrects_episode_id, "
        "earnings_score, earnings_fact, market_score, market_fact, context_score, context_fact, "
        "total_score, red_flag, earnings_within_5d, decision, confidence, explanation) VALUES "
        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            episode_id, ts, RULE_VERSION, as_of_date.isoformat(), ticker, episode_trigger,
            eligibility_date.isoformat(), resolved_from_audit_id, corrects_episode_id,
            outcome.earnings_score, outcome.earnings_fact,
            outcome.market_score, outcome.market_fact,
            outcome.context_score, outcome.context_fact,
            outcome.total_score, outcome.red_flag, outcome.earnings_within_5d,
            outcome.decision, outcome.confidence,
            _build_explanation(outcome),
        ),
    )
    if source_table is not None and source_row_id is not None:
        # Records that THIS specific source event row (not just "this date")
        # has now produced an episode, so detect_episode_trigger() never
        # surfaces it again -- including when a same-day sibling event is
        # still pending and gets its own episode on a later loop iteration
        # or call. Same transaction as the reviews INSERT above.
        conn.execute(
            "INSERT INTO consumed_triggers (ticker, source_table, source_row_id, episode_trigger, "
            "eligibility_date, episode_id) VALUES (?, ?, ?, ?, ?, ?)",
            (ticker, source_table, source_row_id, episode_trigger, eligibility_date.isoformat(), episode_id),
        )
    # commit=False lets retry_insufficient_data() write this row and mark the
    # audit case resolved as ONE atomic transaction (see required_inputs.py) --
    # a crash between two separate commits could otherwise leave a case
    # unresolved after its reviews row already exists, and the next retry
    # would write a second reviews row for the same audit_id.
    if commit:
        conn.commit()
    return episode_id


def _build_explanation(outcome: ScoringOutcome) -> str:
    if outcome.earnings_within_5d:
        return "Earnings release within 5 trading days; re-evaluate as a new episode after results."
    if outcome.red_flag:
        return "Major red flag present in Context group; automatic Reject."
    return (
        f"Earnings={outcome.earnings_score:+d}, Market={outcome.market_score:+d}, "
        f"Context={outcome.context_score:+d}, total={outcome.total_score:+d} -> {outcome.decision}."
    )


def run_episode(
    conn: sqlite3.Connection,
    ticker: str,
    as_of_date: date,
    calendar: TradingCalendar = default_calendar,
) -> list[str]:
    """Routine daily pipeline entry point for a single ticker: detects every
    Section 10 trigger that has fired since the last-processed trigger for
    this ticker and writes one immutable `reviews` row per trigger (each
    still scored using the freshest data as of as_of_date), in chronological
    order by eligibility_date.

    This loops rather than processing only the earliest pending trigger,
    because detect_episode_trigger()'s cursor only advances as each trigger
    is actually turned into an episode -- if this function stopped after one
    trigger while two were pending, the second would still be "pending" on
    the next call and would eventually be caught, but if the caller only
    invokes run_episode() once per day per ticker (the normal usage pattern),
    a second same-day trigger would otherwise wait until the NEXT calendar
    day to get its own episode, and any trigger more than one processing gap
    behind would compound. Processing all pending triggers per call closes
    that gap directly.

    Returns the list of newly-created episode_ids in chronological order
    (empty if no trigger fired or every pending trigger's required inputs
    were insufficient, in which case insufficient_data_cases audit rows are
    written instead)."""
    episode_ids: list[str] = []

    for _ in range(MAX_TRIGGERS_PER_CALL):
        trigger = detect_episode_trigger(conn, ticker, as_of_date)
        if trigger is None:
            break

        outcome = _score_ticker(conn, calendar, ticker, as_of_date)
        if not outcome.required.ok:
            record_insufficient_data_case(
                conn, ticker, as_of_date, trigger.episode_trigger, trigger.eligibility_date,
                trigger.source_candidate_id, outcome.required.missing,
                trigger_source_table=trigger.source_table or None,
                trigger_source_row_id=trigger.source_row_id or None,
            )
            # This trigger couldn't be scored. It is intentionally NOT marked
            # consumed (record_insufficient_data_case preserves its source
            # identity on the audit case instead, which _is_consumed() also
            # checks) -- stop here rather than looping forever on it. It will
            # be retried later via retry_insufficient_data().
            break

        episode_id = _write_review(
            conn, ticker, as_of_date, trigger.episode_trigger, trigger.eligibility_date, outcome,
            source_table=trigger.source_table or None, source_row_id=trigger.source_row_id or None,
        )
        episode_ids.append(episode_id)

    return episode_ids


def run_episode_for_retry(
    *,
    conn: sqlite3.Connection,
    ticker: str,
    as_of_date: date,
    episode_trigger: str,
    eligibility_date: date,
    resolved_from_audit_id: int,
    trigger_source_table: Optional[str] = None,
    trigger_source_row_id: Optional[int] = None,
    calendar: TradingCalendar = default_calendar,
    commit: bool = True,
) -> Optional[str]:
    """Adapter matching the `run_episode_fn` signature expected by
    required_inputs.retry_insufficient_data(): scores using the PRESERVED
    original episode_trigger/eligibility_date, not a new trigger type. Returns
    None (leaving the case unresolved) if inputs are still insufficient.
    commit=False lets the caller combine this write with marking the audit
    case resolved in one transaction. Forwards the case's preserved
    trigger_source_table/trigger_source_row_id so the originating source
    event finally gets recorded in consumed_triggers now that it can be
    scored -- it was deliberately left unconsumed while the case was open
    (see _is_consumed(), which also checks open insufficient_data_cases
    rows) so detect_episode_trigger() wouldn't treat it as available for a
    second, competing episode in the meantime."""
    outcome = _score_ticker(conn, calendar, ticker, as_of_date)
    if not outcome.required.ok:
        return None
    return _write_review(
        conn, ticker, as_of_date, episode_trigger, eligibility_date, outcome,
        resolved_from_audit_id=resolved_from_audit_id, commit=commit,
        source_table=trigger_source_table, source_row_id=trigger_source_row_id,
    )


def force_rescore(
    conn: sqlite3.Connection,
    ticker: str,
    as_of_date: date,
    calendar: TradingCalendar = default_calendar,
) -> Optional[str]:
    """Explicit, operator-invoked re-scoring (trigger #4: 'the decision label
    changes'). Only creates a new episode if a prior episode exists AND the
    freshly computed decision differs from it -- otherwise returns None, since
    an unchanged label on an unchanged stock must not create a new episode."""
    last = _last_episode(conn, ticker)
    if last is None:
        return None  # no baseline label to compare against; use run_episode() instead

    outcome = _score_ticker(conn, calendar, ticker, as_of_date)
    if not outcome.required.ok:
        record_insufficient_data_case(
            conn, ticker, as_of_date, "decision_label_change", as_of_date, None, outcome.required.missing,
        )
        return None

    if outcome.decision == last["decision"]:
        return None

    return _write_review(conn, ticker, as_of_date, "decision_label_change", as_of_date, outcome)


def record_correction(
    conn: sqlite3.Connection,
    ticker: str,
    as_of_date: date,
    corrects_episode_id: str,
    calendar: TradingCalendar = default_calendar,
) -> Optional[str]:
    """A correction to a past episode is a NEW reviews row referencing
    corrects_episode_id -- never an edit to the original (Section 12)."""
    outcome = _score_ticker(conn, calendar, ticker, as_of_date)
    if not outcome.required.ok:
        record_insufficient_data_case(
            conn, ticker, as_of_date, "correction", as_of_date, None, outcome.required.missing,
        )
        return None
    return _write_review(
        conn, ticker, as_of_date, "correction", as_of_date, outcome, corrects_episode_id=corrects_episode_id,
    )
