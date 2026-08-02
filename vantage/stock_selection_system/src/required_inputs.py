"""
check_required_inputs() and the insufficient-data audit flow, per
stock_selection_frozen_spec.md Section 4 and the implementation prompt's
function 0 / 0a.

Missing data must never be treated as neutral (score 0). If any required input
for a group is missing, no score is computed for that group and no `reviews`
row is written -- the episode routes to insufficient_data_cases /
insufficient_data_fields instead.

Context-group "required inputs" per the spec are "guidance status ... insider-
transaction data ... material-event data for the applicable window" -- i.e.
confirmation that the window has been *covered* by ingestion, not merely that
zero rows happen to exist (zero rows could mean "no news" or "we haven't
ingested yet"). `context_ingestion_coverage` (schema.sql) tracks, per ticker,
the latest date through which ingestion is confirmed complete; a ticker whose
coverage hasn't reached as_of_date routes to insufficient_data_cases instead
of silently reading "zero rows" as a valid 0-eligible Context signal.
"""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Optional

from .scoring import GuidanceEvent, InsiderPurchase, MaterialEvent
from .trading_calendar import TradingCalendar, default_calendar

MIN_PRICE_HISTORY_TRADING_DAYS = 200
ESTIMATE_TOLERANCE_MIN_DAYS = 35
ESTIMATE_TOLERANCE_MAX_DAYS = 30


def _parse_date(v) -> Optional[date]:
    if v is None:
        return None
    if isinstance(v, date):
        return v
    return datetime.strptime(str(v)[:10], "%Y-%m-%d").date()


@dataclass
class ResolvedInputs:
    """Everything check_required_inputs() looked up, for reuse by the scoring
    step so the pipeline doesn't have to re-query the database."""

    # earnings
    latest_actual_eps: Optional[float] = None
    latest_estimated_eps: Optional[float] = None
    last_earnings_release_date: Optional[date] = None
    eps_estimate_30d_ago: Optional[float] = None
    eps_estimate_now: Optional[float] = None
    # market
    price: Optional[float] = None
    ma_50: Optional[float] = None
    ma_200: Optional[float] = None
    excess_return_3m: Optional[float] = None
    volume: Optional[float] = None
    avg_volume_30d: Optional[float] = None
    high_volume_breakdown: Optional[bool] = None
    # context
    guidance_events: list[GuidanceEvent] = field(default_factory=list)
    insider_purchases: list[InsiderPurchase] = field(default_factory=list)
    material_events: list[MaterialEvent] = field(default_factory=list)
    # wait check
    next_scheduled_report_date: Optional[date] = None


@dataclass
class RequiredInputsResult:
    ok: bool
    missing: list[tuple[str, str]]  # (missing_group, missing_field)
    resolved: ResolvedInputs


def _check_earnings_inputs(conn: sqlite3.Connection, ticker: str, as_of_date: date) -> tuple[list[tuple[str, str]], ResolvedInputs]:
    missing: list[tuple[str, str]] = []
    r = ResolvedInputs()

    row = conn.execute(
        "SELECT report_date, actual_eps, estimated_eps FROM earnings_history "
        "WHERE ticker = ? AND report_date <= ? ORDER BY report_date DESC LIMIT 1",
        (ticker, as_of_date.isoformat()),
    ).fetchone()
    if row is None or row["actual_eps"] is None or row["estimated_eps"] is None:
        missing.append(("earnings", "latest_actual_eps_vs_estimate"))
    else:
        r.latest_actual_eps = row["actual_eps"]
        r.latest_estimated_eps = row["estimated_eps"]
        r.last_earnings_release_date = _parse_date(row["report_date"])

    # Current ("now") estimate: most recent snapshot on or before as_of_date.
    now_row = conn.execute(
        "SELECT date, fiscal_period, eps_estimate FROM estimate_snapshots "
        "WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1",
        (ticker, as_of_date.isoformat()),
    ).fetchone()
    if now_row is None or now_row["eps_estimate"] is None:
        missing.append(("earnings", "eps_estimate_now"))
        return missing, r

    r.eps_estimate_now = now_row["eps_estimate"]
    fiscal_period = now_row["fiscal_period"]

    # 30-days-prior estimate: most recent snapshot, SAME fiscal_period, dated
    # in [as_of_date - 35, as_of_date - 30]. No fallback outside tolerance.
    window_start = (as_of_date - timedelta(days=ESTIMATE_TOLERANCE_MIN_DAYS)).isoformat()
    window_end = (as_of_date - timedelta(days=ESTIMATE_TOLERANCE_MAX_DAYS)).isoformat()
    prior_row = conn.execute(
        "SELECT eps_estimate FROM estimate_snapshots "
        "WHERE ticker = ? AND fiscal_period = ? AND date >= ? AND date <= ? "
        "ORDER BY date DESC LIMIT 1",
        (ticker, fiscal_period, window_start, window_end),
    ).fetchone()
    if prior_row is None or prior_row["eps_estimate"] is None:
        missing.append(("earnings", "eps_estimate_30d_ago"))
    else:
        r.eps_estimate_30d_ago = prior_row["eps_estimate"]

    return missing, r


def _check_market_inputs(
    conn: sqlite3.Connection, ticker: str, as_of_date: date, calendar: TradingCalendar
) -> tuple[list[tuple[str, str]], ResolvedInputs]:
    missing: list[tuple[str, str]] = []
    r = ResolvedInputs()

    # Count only rows whose date is a genuine NYSE trading session per the
    # shared calendar, not a raw row count -- a raw COUNT(*) would let a bad
    # row (e.g. a weekend date from a flaky upstream feed) inflate the
    # "200 trading days of history" requirement without actually providing
    # 200 real sessions.
    date_rows = conn.execute(
        "SELECT date FROM price_signals WHERE ticker = ? AND date <= ?",
        (ticker, as_of_date.isoformat()),
    ).fetchall()
    valid_trading_day_count = sum(1 for row in date_rows if calendar.is_trading_day(_parse_date(row["date"])))
    if valid_trading_day_count < MIN_PRICE_HISTORY_TRADING_DAYS:
        missing.append(("market", "price_history_200d"))

    row = conn.execute(
        "SELECT close, ma_50, ma_200, excess_return_3m, volume, avg_volume_30d, high_volume_breakdown "
        "FROM price_signals WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1",
        (ticker, as_of_date.isoformat()),
    ).fetchone()
    if row is None:
        missing.append(("market", "current_price_signals_row"))
        return missing, r

    field_map = {
        "close": "price",
        "ma_50": "ma_50",
        "ma_200": "ma_200",
        "excess_return_3m": "excess_return_3m",
        "volume": "volume",
        "avg_volume_30d": "avg_volume_30d",
        "high_volume_breakdown": "high_volume_breakdown",
    }
    for col, missing_name in field_map.items():
        if row[col] is None:
            missing.append(("market", missing_name))

    if not any(m[1] == "price" for m in missing):
        r.price = row["close"]
    if not any(m[1] == "ma_50" for m in missing):
        r.ma_50 = row["ma_50"]
    if not any(m[1] == "ma_200" for m in missing):
        r.ma_200 = row["ma_200"]
    if not any(m[1] == "excess_return_3m" for m in missing):
        r.excess_return_3m = row["excess_return_3m"]
    if not any(m[1] == "volume" for m in missing):
        r.volume = row["volume"]
    if not any(m[1] == "avg_volume_30d" for m in missing):
        r.avg_volume_30d = row["avg_volume_30d"]
    if not any(m[1] == "high_volume_breakdown" for m in missing):
        r.high_volume_breakdown = bool(row["high_volume_breakdown"])

    return missing, r


def _check_context_inputs(
    conn: sqlite3.Connection, ticker: str, as_of_date: date, last_earnings_release_date: Optional[date]
) -> tuple[list[tuple[str, str]], ResolvedInputs]:
    missing: list[tuple[str, str]] = []
    r = ResolvedInputs()

    meta = conn.execute(
        "SELECT sector_benchmark_ticker FROM security_metadata WHERE ticker = ?", (ticker,)
    ).fetchone()
    if meta is None or meta["sector_benchmark_ticker"] is None:
        missing.append(("context", "security_metadata_sector_benchmark"))

    coverage = conn.execute(
        "SELECT covered_through FROM context_ingestion_coverage WHERE ticker = ?", (ticker,)
    ).fetchone()
    if coverage is None or _parse_date(coverage["covered_through"]) < as_of_date:
        # Zero guidance/insider/material rows is only a trustworthy "no event"
        # signal if ingestion has actually confirmed this window was checked.
        # Without confirmed coverage, absence of rows is indistinguishable
        # from "never looked" -- which the missing-data policy (Section 4)
        # says must not be scored as neutral.
        missing.append(("context", "ingestion_coverage"))

    if last_earnings_release_date is not None:
        window_start, window_end = last_earnings_release_date, as_of_date
    else:
        window_start, window_end = as_of_date - timedelta(days=90), as_of_date

    for grow in conn.execute(
        "SELECT event_id, ticker, event_date, guidance_direction, detail FROM guidance_events "
        "WHERE ticker = ? AND event_date >= ? AND event_date <= ?",
        (ticker, window_start.isoformat(), window_end.isoformat()),
    ):
        r.guidance_events.append(
            GuidanceEvent(grow["event_id"], grow["ticker"], _parse_date(grow["event_date"]), grow["guidance_direction"], grow["detail"] or "")
        )

    for mrow in conn.execute(
        "SELECT event_id, ticker, event_date, event_type, polarity, detail FROM material_events "
        "WHERE ticker = ? AND event_date >= ? AND event_date <= ?",
        (ticker, window_start.isoformat(), window_end.isoformat()),
    ):
        r.material_events.append(
            MaterialEvent(mrow["event_id"], mrow["ticker"], _parse_date(mrow["event_date"]), mrow["event_type"], mrow["polarity"], mrow["detail"] or "")
        )

    # Insider purchases use their own trailing-30-calendar-day recency window
    # (Section 5), independent of the guidance/material window above -- pull a
    # generous lookback so the 5-trading-day clustering logic has full context.
    insider_lookback_start = as_of_date - timedelta(days=60)
    for prow in conn.execute(
        "SELECT purchase_id, ticker, transaction_date, insider_name, purchase_value_usd, transaction_type "
        "FROM insider_purchases WHERE ticker = ? AND transaction_date >= ? AND transaction_date <= ?",
        (ticker, insider_lookback_start.isoformat(), as_of_date.isoformat()),
    ):
        r.insider_purchases.append(
            InsiderPurchase(
                prow["purchase_id"], prow["ticker"], _parse_date(prow["transaction_date"]),
                prow["insider_name"], prow["purchase_value_usd"], prow["transaction_type"],
            )
        )

    return missing, r


def _check_wait_inputs(conn: sqlite3.Connection, ticker: str, as_of_date: date) -> tuple[list[tuple[str, str]], ResolvedInputs]:
    missing: list[tuple[str, str]] = []
    r = ResolvedInputs()
    row = conn.execute(
        "SELECT scheduled_report_date FROM earnings_calendar "
        "WHERE ticker = ? AND scheduled_report_date >= ? ORDER BY scheduled_report_date ASC LIMIT 1",
        (ticker, as_of_date.isoformat()),
    ).fetchone()
    if row is None or row["scheduled_report_date"] is None:
        missing.append(("wait_check", "scheduled_report_date"))
    else:
        r.next_scheduled_report_date = _parse_date(row["scheduled_report_date"])
    return missing, r


def check_required_inputs(
    conn: sqlite3.Connection, ticker: str, as_of_date: date, calendar: TradingCalendar = default_calendar
) -> RequiredInputsResult:
    """Verifies all required inputs (Section 4) exist before any group is
    scored. Returns ok=False with the full missing list if anything required
    is absent -- callers must not compute any score or write a reviews row in
    that case."""
    all_missing: list[tuple[str, str]] = []
    resolved = ResolvedInputs()

    e_missing, e_resolved = _check_earnings_inputs(conn, ticker, as_of_date)
    all_missing += e_missing
    for f in ("latest_actual_eps", "latest_estimated_eps", "last_earnings_release_date", "eps_estimate_30d_ago", "eps_estimate_now"):
        setattr(resolved, f, getattr(e_resolved, f))

    m_missing, m_resolved = _check_market_inputs(conn, ticker, as_of_date, calendar)
    all_missing += m_missing
    for f in ("price", "ma_50", "ma_200", "excess_return_3m", "volume", "avg_volume_30d", "high_volume_breakdown"):
        setattr(resolved, f, getattr(m_resolved, f))

    c_missing, c_resolved = _check_context_inputs(conn, ticker, as_of_date, resolved.last_earnings_release_date)
    all_missing += c_missing
    resolved.guidance_events = c_resolved.guidance_events
    resolved.insider_purchases = c_resolved.insider_purchases
    resolved.material_events = c_resolved.material_events

    w_missing, w_resolved = _check_wait_inputs(conn, ticker, as_of_date)
    all_missing += w_missing
    resolved.next_scheduled_report_date = w_resolved.next_scheduled_report_date

    return RequiredInputsResult(ok=len(all_missing) == 0, missing=all_missing, resolved=resolved)


# ---------------------------------------------------------------------------
# Insufficient-data audit case management
# ---------------------------------------------------------------------------

def record_insufficient_data_case(
    conn: sqlite3.Connection,
    ticker: str,
    as_of_date: date,
    episode_trigger: str,
    eligibility_date: date,
    source_candidate_id: Optional[int],
    missing: list[tuple[str, str]],
    trigger_source_table: Optional[str] = None,
    trigger_source_row_id: Optional[int] = None,
) -> int:
    """Writes ONE row to insufficient_data_cases (not one per missing field)
    plus one insufficient_data_fields row per missing field. If an unresolved
    case already exists for this (ticker, source_candidate_id, episode_trigger,
    eligibility_date, trigger_source_table, trigger_source_row_id) key
    (enforced by the partial unique index), reuses it instead of creating a
    duplicate -- a repeated ingestion run must not spawn a second unresolved
    case for the same episode intent.

    trigger_source_table/trigger_source_row_id preserve the originating
    source event row's identity so that, once this case eventually resolves,
    the same row can be recorded in consumed_triggers -- and, in the
    meantime, so episodes.detect_episode_trigger()/_is_consumed() can see
    that this specific event row already has an OPEN case and must not be
    offered up again as a second, competing pending trigger. They're also
    part of THIS dedup key (not just episode_trigger/eligibility_date) so
    that two distinct same-day events of the same trigger type -- e.g. two
    separate guidance_events rows both dated 2026-01-12 -- get two separate
    audit cases instead of silently merging into one (which would only ever
    resolve into a single reviews row, permanently losing the other)."""
    existing = conn.execute(
        "SELECT audit_id FROM insufficient_data_cases WHERE ticker = ? AND "
        "(source_candidate_id IS ? OR source_candidate_id = ?) AND episode_trigger = ? "
        "AND eligibility_date = ? AND (trigger_source_table IS ? OR trigger_source_table = ?) "
        "AND (trigger_source_row_id IS ? OR trigger_source_row_id = ?) AND resolved = FALSE",
        (
            ticker, source_candidate_id, source_candidate_id, episode_trigger, eligibility_date.isoformat(),
            trigger_source_table, trigger_source_table, trigger_source_row_id, trigger_source_row_id,
        ),
    ).fetchone()

    if existing is not None:
        audit_id = existing["audit_id"]
    else:
        cur = conn.execute(
            "INSERT INTO insufficient_data_cases (ticker, as_of_date, episode_trigger, "
            "eligibility_date, source_candidate_id, trigger_source_table, trigger_source_row_id, "
            "resolved) VALUES (?, ?, ?, ?, ?, ?, ?, FALSE)",
            (
                ticker, as_of_date.isoformat(), episode_trigger, eligibility_date.isoformat(),
                source_candidate_id, trigger_source_table, trigger_source_row_id,
            ),
        )
        audit_id = cur.lastrowid

    for missing_group, missing_field in missing:
        conn.execute(
            "INSERT OR IGNORE INTO insufficient_data_fields (audit_id, missing_group, missing_field) "
            "VALUES (?, ?, ?)",
            (audit_id, missing_group, missing_field),
        )
    conn.commit()
    return audit_id


def retry_insufficient_data(
    conn: sqlite3.Connection,
    run_episode_fn,
    today: Optional[date] = None,
    calendar: TradingCalendar = default_calendar,
) -> list[str]:
    """Periodic job: for each unresolved insufficient_data_cases row, re-checks
    whether ALL of its originally-missing fields are now available (does not
    resolve a case if only some are available). When a case fully resolves,
    calls run_episode_fn(...) using the PRESERVED episode_trigger and
    eligibility_date (not a new trigger type), then marks the case resolved.

    `run_episode_fn(ticker, as_of_date, episode_trigger, eligibility_date,
    resolved_from_audit_id, commit) -> episode_id | None` is injected by the
    pipeline layer to avoid a circular import between required_inputs and
    episodes. The reviews INSERT and the insufficient_data_cases UPDATE are
    committed together as one transaction (run_episode_fn is called with
    commit=False) so a crash between them can never leave a case marked
    unresolved while a reviews row referencing it already exists -- which
    would let the next retry create a SECOND reviews row for the same case.
    `reviews.resolved_from_audit_id` also carries a UNIQUE index (schema.sql)
    as a second line of defense if that ever happens anyway.

    Returns the list of newly-created episode_ids.
    """
    today = today or date.today()
    new_episode_ids: list[str] = []

    cases = conn.execute(
        "SELECT audit_id, ticker, episode_trigger, eligibility_date, source_candidate_id, "
        "trigger_source_table, trigger_source_row_id "
        "FROM insufficient_data_cases WHERE resolved = FALSE"
    ).fetchall()

    for case in cases:
        audit_id = case["audit_id"]
        ticker = case["ticker"]

        result = check_required_inputs(conn, ticker, today, calendar=calendar)
        if not result.ok:
            # Only resolves once ALL of the case's originally-missing fields
            # are available -- a partial improvement does not resolve it.
            continue

        eligibility_date = _parse_date(case["eligibility_date"])
        try:
            episode_id = run_episode_fn(
                ticker=ticker,
                as_of_date=today,
                episode_trigger=case["episode_trigger"],
                eligibility_date=eligibility_date,
                resolved_from_audit_id=audit_id,
                trigger_source_table=case["trigger_source_table"],
                trigger_source_row_id=case["trigger_source_row_id"],
                commit=False,
            )
            if episode_id is None:
                # run_episode_fn may itself decide required inputs still
                # aren't sufficient by its own as-of-date semantics; nothing
                # was written, leave unresolved.
                conn.rollback()
                continue

            conn.execute(
                "UPDATE insufficient_data_cases SET resolved = TRUE, resolved_episode_id = ? WHERE audit_id = ?",
                (episode_id, audit_id),
            )
            conn.commit()
        except sqlite3.IntegrityError:
            # e.g. the UNIQUE index on reviews.resolved_from_audit_id rejected
            # a second review for this case (a concurrent/prior run already
            # resolved it) -- roll back this attempt and move on.
            conn.rollback()
            continue

        new_episode_ids.append(episode_id)

    return new_episode_ids
