"""
Pure, testable scoring functions per stock_selection_frozen_spec.md Section 2,
and the final decision sequence per Section 9.

These functions assume `check_required_inputs()` (see required_inputs.py) has
already passed for the group(s) being scored -- they do not themselves search
for missing data or apply the missing-data policy.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable, Optional

from .trading_calendar import TradingCalendar, default_calendar

MIN_INSIDER_PURCHASE_USD = 50_000.0
INSIDER_CLUSTER_MIN_DISTINCT_INSIDERS = 2
INSIDER_CLUSTER_TRADING_DAY_SPAN = 5  # per spec 2.3
INSIDER_CLUSTER_RECENCY_CALENDAR_DAYS = 30  # per spec Section 5
CONTEXT_FIRST_REVIEW_LOOKBACK_CALENDAR_DAYS = 90  # per spec Section 5
EXCESS_RETURN_UPPER_BAND = 0.02
EXCESS_RETURN_LOWER_BAND = -0.05
HIGH_VOLUME_BREAKDOWN_MULTIPLE = 1.5
EARNINGS_WITHIN_TRADING_DAYS = 5

NEGATIVE_MATERIAL_EVENT_TYPES = {
    "investigation",
    "accounting_issue",
    "CEO_departure",
    "CFO_departure",
}


# ---------------------------------------------------------------------------
# 1. Earnings
# ---------------------------------------------------------------------------

def score_earnings(
    latest_actual_eps: float,
    latest_estimated_eps: float,
    eps_estimate_30d_ago: float,
    eps_estimate_now: float,
) -> tuple[int, str]:
    """
    +1 if beat AND next-quarter estimate rose over 30 days
    -1 if missed OR next-quarter estimate fell over 30 days
     0 otherwise

    Only called after check_required_inputs() passes; eps_estimate_30d_ago must
    already have been resolved via the tolerance-window lookup in
    required_inputs.py -- this function does not itself search for a snapshot.
    """
    beat = latest_actual_eps > latest_estimated_eps
    missed = latest_actual_eps < latest_estimated_eps
    revision_rose = eps_estimate_now > eps_estimate_30d_ago
    revision_fell = eps_estimate_now < eps_estimate_30d_ago

    result_word = "beat" if beat else ("missed" if missed else "in-line with")
    revision_word = "rose" if revision_rose else ("fell" if revision_fell else "was flat vs")

    fact = (
        f"Latest actual EPS ${latest_actual_eps:.2f} {result_word} estimate "
        f"${latest_estimated_eps:.2f}; next-quarter EPS estimate {revision_word} "
        f"${eps_estimate_30d_ago:.2f} (30d ago) -> ${eps_estimate_now:.2f} (now)."
    )

    if beat and revision_rose:
        return 1, fact
    if missed or revision_fell:
        return -1, fact
    return 0, fact


# ---------------------------------------------------------------------------
# 2. Market
# ---------------------------------------------------------------------------

def compute_high_volume_breakdown(price: float, ma_200: float, volume: float, avg_volume_30d: float) -> bool:
    """Used by the INGESTION layer (ingestion/base.py:upsert_price_signal) to
    compute the value stored in price_signals.high_volume_breakdown. score_market()
    below consumes that stored value rather than recomputing it -- see its
    docstring for why."""
    return (price < ma_200) and (volume >= HIGH_VOLUME_BREAKDOWN_MULTIPLE * avg_volume_30d)


def score_market(
    price: float,
    ma_50: float,
    ma_200: float,
    excess_return_3m: float,
    volume: float,
    avg_volume_30d: float,
    high_volume_breakdown: bool,
) -> tuple[int, str]:
    """
    +1 if price > ma_50 AND ma_50 > ma_200 AND excess_return_3m >= 0.02
    -1 if price < ma_200 OR excess_return_3m < -0.05 OR high_volume_breakdown
     0 otherwise (neither of the other two -- not a narrower band-based condition)

    Excess-return bands are half-open, exact inequalities, no boundary rounding:
      [+2%, inf)  -> +1-eligible
      [-5%, +2%)  ->  0-eligible
      (-inf, -5%) -> -1-eligible

    `high_volume_breakdown` is taken as given, not recomputed here -- the
    implementation prompt requires price_signals to compute and store it
    directly at ingestion time ("do not compute these ad hoc inside
    score_market()"). Recomputing it here from volume/avg_volume_30d would
    defeat that: if the stored value and a locally-recomputed one ever
    diverged (e.g. a formula change applied to new ingestion but not
    reflected in already-stored history), this function would silently use
    the wrong one. volume/avg_volume_30d are still accepted so the fact
    string stays informative.
    """
    is_uptrend = price > ma_50 and ma_50 > ma_200
    plus_one = is_uptrend and excess_return_3m >= EXCESS_RETURN_UPPER_BAND
    minus_one = (price < ma_200) or (excess_return_3m < EXCESS_RETURN_LOWER_BAND) or high_volume_breakdown

    fact = (
        f"price={price:.2f}, ma_50={ma_50:.2f}, ma_200={ma_200:.2f}, "
        f"excess_return_3m={excess_return_3m:+.2%}, volume={volume:,.0f}, "
        f"avg_volume_30d={avg_volume_30d:,.0f}, high_volume_breakdown={high_volume_breakdown}"
    )

    if plus_one:
        return 1, fact
    if minus_one:
        return -1, fact
    return 0, fact


# ---------------------------------------------------------------------------
# 3. Context
# ---------------------------------------------------------------------------

@dataclass
class GuidanceEvent:
    event_id: int
    ticker: str
    event_date: date
    guidance_direction: str  # 'raised' / 'maintained' / 'cut'
    detail: str = ""


@dataclass
class InsiderPurchase:
    purchase_id: int
    ticker: str
    transaction_date: date
    insider_name: str
    purchase_value_usd: float
    transaction_type: str  # must be 'open-market' to qualify


@dataclass
class MaterialEvent:
    event_id: int
    ticker: str
    event_date: date
    event_type: str
    polarity: str  # 'positive' / 'negative'
    detail: str = ""


def context_window(as_of_date: date, last_earnings_release_date: Optional[date]) -> tuple[date, date]:
    """Section 5 window logic for guidance_events / material_events."""
    if last_earnings_release_date is not None:
        return last_earnings_release_date, as_of_date
    return as_of_date - timedelta(days=CONTEXT_FIRST_REVIEW_LOOKBACK_CALENDAR_DAYS), as_of_date


def _find_qualifying_insider_cluster(
    purchases: Iterable[InsiderPurchase],
    as_of_date: date,
    calendar: TradingCalendar,
) -> Optional[tuple[date, list[InsiderPurchase]]]:
    """
    Finds a 5-trading-day window (Section 2.3) containing >=2 distinct insiders,
    each with an open-market purchase >= $50,000, whose completion date falls
    within the trailing 30 calendar days of as_of_date (Section 5).

    Interpretation note (the spec does not pin this down further): a cluster's
    "completion date" is taken to be the transaction date of the purchase that
    caused the 2nd distinct qualifying insider to appear within the rolling
    5-trading-day window -- i.e. the moment the cluster condition first becomes
    true -- rather than the forced end of a fixed 5-day span. This is the
    earliest date at which the +1 condition could actually be observed.

    Returns (completion_date, purchases_in_cluster) for the first qualifying
    cluster found (by earliest completion date), or None.
    """
    qualifying = sorted(
        (
            p
            for p in purchases
            if p.transaction_type == "open-market" and p.purchase_value_usd >= MIN_INSIDER_PURCHASE_USD
        ),
        key=lambda p: p.transaction_date,
    )

    best: Optional[tuple[date, list[InsiderPurchase]]] = None
    for i, start_purchase in enumerate(qualifying):
        window_start = start_purchase.transaction_date
        # 5-trading-day window: the window's start day plus the next 4 trading
        # sessions = 5 trading sessions total (day-0 convention, Section 6/7).
        window_end = calendar.add_trading_days(window_start, INSIDER_CLUSTER_TRADING_DAY_SPAN - 1)
        in_window = [p for p in qualifying if window_start <= p.transaction_date <= window_end]
        distinct_insiders = {p.insider_name for p in in_window}
        if len(distinct_insiders) >= INSIDER_CLUSTER_MIN_DISTINCT_INSIDERS:
            # Completion date = date the 2nd distinct insider's purchase landed.
            seen: set[str] = set()
            completion_date = None
            for p in in_window:
                seen.add(p.insider_name)
                if len(seen) >= INSIDER_CLUSTER_MIN_DISTINCT_INSIDERS:
                    completion_date = p.transaction_date
                    break
            if completion_date is None:
                continue
            recency_days = (as_of_date - completion_date).days
            if 0 <= recency_days <= INSIDER_CLUSTER_RECENCY_CALENDAR_DAYS:
                candidate = (completion_date, in_window)
                if best is None or completion_date < best[0]:
                    best = candidate
    return best


def score_context(
    ticker: str,
    as_of_date: date,
    last_earnings_release_date: Optional[date],
    guidance_events: list[GuidanceEvent],
    insider_purchases: list[InsiderPurchase],
    material_events: list[MaterialEvent],
    calendar: TradingCalendar = default_calendar,
) -> tuple[int, str]:
    """
    Conflict rule: negative Context evidence overrides positive evidence within
    the applicable window. Negative conditions are checked first; positive
    conditions are only checked if no negative condition was found.
    """
    window_start, window_end = context_window(as_of_date, last_earnings_release_date)

    guidance_in_window = [g for g in guidance_events if window_start <= g.event_date <= window_end]
    material_in_window = [m for m in material_events if window_start <= m.event_date <= window_end]

    guidance_cut = next((g for g in guidance_in_window if g.guidance_direction == "cut"), None)
    # Any material_event with polarity == 'negative' counts -- the frozen spec's
    # Context -1 condition is "serious investigation begins, OR accounting/
    # restatement issue, OR unexpected CEO/CFO departure, OR comparable major
    # negative event", so NEGATIVE_MATERIAL_EVENT_TYPES is illustrative, not an
    # exhaustive filter; polarity is the authoritative signal.
    negative_material = next((m for m in material_in_window if m.polarity == "negative"), None)

    if guidance_cut is not None or negative_material is not None:
        parts = []
        if guidance_cut is not None:
            parts.append(f"guidance_events.event_id={guidance_cut.event_id} (cut on {guidance_cut.event_date})")
        if negative_material is not None:
            parts.append(
                f"material_events.event_id={negative_material.event_id} "
                f"({negative_material.event_type} on {negative_material.event_date})"
            )
        return -1, "Negative Context evidence: " + "; ".join(parts)

    guidance_raised = next((g for g in guidance_in_window if g.guidance_direction == "raised"), None)
    cluster = _find_qualifying_insider_cluster(insider_purchases, as_of_date, calendar)

    if guidance_raised is not None or cluster is not None:
        parts = []
        if guidance_raised is not None:
            parts.append(f"guidance_events.event_id={guidance_raised.event_id} (raised on {guidance_raised.event_date})")
        if cluster is not None:
            completion_date, cluster_purchases = cluster
            ids = [p.purchase_id for p in cluster_purchases]
            parts.append(
                f"insider_purchases.purchase_id={ids} (cluster of "
                f"{len({p.insider_name for p in cluster_purchases})} distinct insiders, "
                f"completed {completion_date})"
            )
        return 1, "Positive Context evidence: " + "; ".join(parts)

    return 0, (
        f"No qualifying Context evidence in window [{window_start}, {window_end}]: "
        f"guidance maintained/absent, no material event, no qualifying insider cluster."
    )


# ---------------------------------------------------------------------------
# Wait check
# ---------------------------------------------------------------------------

def check_earnings_within_5d(
    ticker: str,
    as_of_date: date,
    next_scheduled_report_date: Optional[date],
    calendar: TradingCalendar = default_calendar,
) -> bool:
    """
    next_scheduled_report_date is the nearest earnings_calendar.scheduled_report_date
    >= as_of_date, already resolved by the caller (check_required_inputs is
    responsible for confirming one exists at all -- this function assumes it does).
    """
    if next_scheduled_report_date is None:
        raise ValueError(
            "next_scheduled_report_date is required; check_required_inputs() should "
            "have routed this episode to insufficient_data_cases if it were missing."
        )
    days_away = calendar.trading_days_between(as_of_date, next_scheduled_report_date)
    return days_away <= EARNINGS_WITHIN_TRADING_DAYS


# ---------------------------------------------------------------------------
# Final decision (Section 9) -- exact sequence, no reordering.
# ---------------------------------------------------------------------------

def compute_red_flag(context_score: int) -> bool:
    """red_flag is derived directly from context_score, not a separately
    tracked/derivable value -- see Section 9 / implementation prompt function 5."""
    return context_score == -1


def decide(
    earnings_score: int,
    market_score: int,
    context_score: int,
    red_flag: bool,
    earnings_within_5d: bool,
) -> tuple[str, str]:
    """
    Exact precedence (must not be reordered):
      1. Red flag -> Reject
      2. Earnings within 5 trading days -> Wait
      3. Total score <= -1 -> Reject
      4. Total score >= 2 -> Confirm
      5. Earnings and Market opposite signs -> Mixed
      6. Otherwise (total is 0 or 1) -> Mixed

    Checking total <= -1 before the opposite-signs rule is what correctly sends
    an opposite-sign case with total = -1 to Reject.
    """
    if red_flag:
        return "Reject", "Reject"
    if earnings_within_5d:
        return "Wait", "Wait"

    total = earnings_score + market_score + context_score
    if total <= -1:
        return "Reject", "Reject"
    if total >= 2:
        return "Confirm", "Confirm"
    if {earnings_score, market_score} == {1, -1}:
        return "Mixed", "Mixed"
    return "Mixed", "Mixed"
