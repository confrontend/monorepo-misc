from datetime import date

import pytest

from src.scoring import (
    GuidanceEvent,
    InsiderPurchase,
    MaterialEvent,
    check_earnings_within_5d,
    compute_high_volume_breakdown,
    compute_red_flag,
    context_window,
    score_context,
    score_earnings,
    score_market,
)
from src.trading_calendar import TradingCalendar


# -- score_earnings -------------------------------------------------------------

def test_earnings_beat_and_revision_rose_is_plus_one():
    score, fact = score_earnings(1.10, 1.00, 1.02, 1.04)
    assert score == 1
    assert "beat" in fact


def test_earnings_missed_is_minus_one_even_if_revision_rose():
    score, _ = score_earnings(0.90, 1.00, 1.02, 1.04)
    assert score == -1


def test_earnings_revision_fell_is_minus_one_even_if_beat():
    score, _ = score_earnings(1.10, 1.00, 1.04, 1.02)
    assert score == -1


def test_earnings_inline_and_flat_revision_is_zero():
    score, _ = score_earnings(1.00, 1.00, 1.02, 1.02)
    assert score == 0


def test_earnings_beat_but_flat_revision_is_zero():
    score, _ = score_earnings(1.10, 1.00, 1.02, 1.02)
    assert score == 0


# -- score_market -----------------------------------------------------------------

def test_market_plus_one_uptrend_and_strong_excess_return():
    score, fact = score_market(price=110, ma_50=105, ma_200=100, excess_return_3m=0.03, volume=1_000_000, avg_volume_30d=1_000_000, high_volume_breakdown=False)
    assert score == 1


def test_market_excess_return_exactly_2pct_is_plus_one_boundary_inclusive():
    score, _ = score_market(price=110, ma_50=105, ma_200=100, excess_return_3m=0.02, volume=1_000_000, avg_volume_30d=1_000_000, high_volume_breakdown=False)
    assert score == 1


def test_market_excess_return_just_under_2pct_is_not_plus_one():
    score, _ = score_market(price=110, ma_50=105, ma_200=100, excess_return_3m=0.0199, volume=1_000_000, avg_volume_30d=1_000_000, high_volume_breakdown=False)
    assert score == 0


def test_market_minus_one_price_below_200ma():
    score, _ = score_market(price=90, ma_50=95, ma_200=100, excess_return_3m=0.0, volume=1_000_000, avg_volume_30d=1_000_000, high_volume_breakdown=False)
    assert score == -1


def test_market_minus_one_excess_return_below_negative_5pct():
    score, _ = score_market(price=105, ma_50=104, ma_200=100, excess_return_3m=-0.06, volume=1_000_000, avg_volume_30d=1_000_000, high_volume_breakdown=False)
    assert score == -1


def test_market_excess_return_exactly_negative_5pct_is_not_minus_one_boundary():
    # -5% is the 0-band's inclusive lower bound, not part of the -1 band.
    score, _ = score_market(price=105, ma_50=104, ma_200=100, excess_return_3m=-0.05, volume=1_000_000, avg_volume_30d=1_000_000, high_volume_breakdown=False)
    assert score == 0


def test_market_minus_one_high_volume_breakdown():
    # Note: high_volume_breakdown is passed in (as the ingestion layer would
    # have already computed and stored it), not recomputed by score_market --
    # deliberately inconsistent with price/ma_200/volume here to prove the
    # function trusts the passed-in flag rather than re-deriving it.
    score, fact = score_market(price=95, ma_50=98, ma_200=100, excess_return_3m=0.0, volume=2_000_000, avg_volume_30d=1_000_000, high_volume_breakdown=True)
    assert score == -1
    assert "high_volume_breakdown=True" in fact


def test_market_trusts_stored_breakdown_flag_over_recomputation():
    # Raw numbers alone would NOT trigger a breakdown (price > ma_200), but
    # the stored flag says True -- score_market must honor the stored value.
    score, _ = score_market(price=105, ma_50=104, ma_200=100, excess_return_3m=0.0, volume=100, avg_volume_30d=1_000_000, high_volume_breakdown=True)
    assert score == -1


def test_high_volume_breakdown_helper():
    # This helper is used by the ingestion layer to compute the value that
    # gets stored in price_signals.high_volume_breakdown -- score_market()
    # itself no longer calls it (see test above).
    assert compute_high_volume_breakdown(price=95, ma_200=100, volume=1_500_000, avg_volume_30d=1_000_000) is True
    assert compute_high_volume_breakdown(price=105, ma_200=100, volume=1_500_000, avg_volume_30d=1_000_000) is False
    assert compute_high_volume_breakdown(price=95, ma_200=100, volume=1_400_000, avg_volume_30d=1_000_000) is False


def test_market_zero_mixed_mas_within_band():
    # price > ma_200 (avoids the -1 branch), but ma_50 < ma_200 so it's not a
    # confirmed uptrend (avoids the +1 branch) -> falls through to 0.
    score, _ = score_market(price=105, ma_50=90, ma_200=100, excess_return_3m=0.0, volume=500_000, avg_volume_30d=1_000_000, high_volume_breakdown=False)
    assert score == 0


# -- context_window ---------------------------------------------------------------

def test_context_window_uses_last_earnings_release():
    start, end = context_window(date(2026, 3, 1), date(2026, 1, 15))
    assert start == date(2026, 1, 15)
    assert end == date(2026, 3, 1)


def test_context_window_falls_back_to_90_days_when_no_prior_earnings():
    start, end = context_window(date(2026, 3, 1), None)
    assert start == date(2026, 3, 1) - __import__("datetime").timedelta(days=90)
    assert end == date(2026, 3, 1)


# -- score_context ------------------------------------------------------------------

@pytest.fixture(scope="module")
def cal():
    return TradingCalendar()


def test_context_negative_overrides_positive_conflict_rule(cal):
    as_of = date(2026, 2, 1)
    last_earnings = date(2026, 1, 1)
    guidance = [GuidanceEvent(1, "ATI", date(2026, 1, 5), "raised")]
    material = [MaterialEvent(1, "ATI", date(2026, 1, 20), "CEO_departure", "negative")]
    score, fact = score_context("ATI", as_of, last_earnings, guidance, [], material, calendar=cal)
    assert score == -1
    assert "material_events.event_id=1" in fact


def test_context_guidance_cut_is_minus_one(cal):
    as_of = date(2026, 2, 1)
    guidance = [GuidanceEvent(2, "ATI", date(2026, 1, 10), "cut")]
    score, _ = score_context("ATI", as_of, date(2026, 1, 1), guidance, [], [], calendar=cal)
    assert score == -1


def test_context_guidance_raised_is_plus_one(cal):
    as_of = date(2026, 2, 1)
    guidance = [GuidanceEvent(3, "ATI", date(2026, 1, 10), "raised")]
    score, _ = score_context("ATI", as_of, date(2026, 1, 1), guidance, [], [], calendar=cal)
    assert score == 1


def test_context_zero_when_nothing_qualifies(cal):
    as_of = date(2026, 2, 1)
    guidance = [GuidanceEvent(4, "ATI", date(2026, 1, 10), "maintained")]
    score, _ = score_context("ATI", as_of, date(2026, 1, 1), guidance, [], [], calendar=cal)
    assert score == 0


def test_context_events_outside_window_ignored(cal):
    as_of = date(2026, 2, 1)
    last_earnings = date(2026, 1, 15)
    # This guidance cut happened before the window opened (before last earnings).
    guidance = [GuidanceEvent(5, "ATI", date(2026, 1, 5), "cut")]
    score, _ = score_context("ATI", as_of, last_earnings, guidance, [], [], calendar=cal)
    assert score == 0


def test_context_qualifying_insider_cluster_is_plus_one(cal):
    as_of = date(2026, 2, 1)
    purchases = [
        InsiderPurchase(1, "ATI", date(2026, 1, 28), "Jane CFO", 60_000, "open-market"),
        InsiderPurchase(2, "ATI", date(2026, 1, 29), "John CEO", 75_000, "open-market"),
    ]
    score, fact = score_context("ATI", as_of, date(2026, 1, 1), [], purchases, [], calendar=cal)
    assert score == 1
    assert "insider_purchases" in fact


def test_context_insider_cluster_needs_two_distinct_insiders(cal):
    as_of = date(2026, 2, 1)
    purchases = [
        InsiderPurchase(1, "ATI", date(2026, 1, 28), "Jane CFO", 60_000, "open-market"),
        InsiderPurchase(2, "ATI", date(2026, 1, 29), "Jane CFO", 75_000, "open-market"),
    ]
    score, _ = score_context("ATI", as_of, date(2026, 1, 1), [], purchases, [], calendar=cal)
    assert score == 0


def test_context_insider_purchase_below_threshold_does_not_count(cal):
    as_of = date(2026, 2, 1)
    purchases = [
        InsiderPurchase(1, "ATI", date(2026, 1, 28), "Jane CFO", 40_000, "open-market"),
        InsiderPurchase(2, "ATI", date(2026, 1, 29), "John CEO", 75_000, "open-market"),
    ]
    score, _ = score_context("ATI", as_of, date(2026, 1, 1), [], purchases, [], calendar=cal)
    assert score == 0


def test_context_insider_non_open_market_does_not_count(cal):
    as_of = date(2026, 2, 1)
    purchases = [
        InsiderPurchase(1, "ATI", date(2026, 1, 28), "Jane CFO", 60_000, "10b5-1"),
        InsiderPurchase(2, "ATI", date(2026, 1, 29), "John CEO", 75_000, "open-market"),
    ]
    score, _ = score_context("ATI", as_of, date(2026, 1, 1), [], purchases, [], calendar=cal)
    assert score == 0


def test_context_insider_cluster_stale_beyond_30_days_does_not_count(cal):
    as_of = date(2026, 3, 15)
    purchases = [
        InsiderPurchase(1, "ATI", date(2026, 1, 5), "Jane CFO", 60_000, "open-market"),
        InsiderPurchase(2, "ATI", date(2026, 1, 6), "John CEO", 75_000, "open-market"),
    ]
    score, _ = score_context("ATI", as_of, date(2026, 1, 1), [], purchases, [], calendar=cal)
    assert score == 0


def test_context_insider_cluster_outside_5_trading_day_span_does_not_qualify(cal):
    as_of = date(2026, 2, 1)
    # 2026-01-06 and 2026-01-16 are more than 5 trading days apart.
    purchases = [
        InsiderPurchase(1, "ATI", date(2026, 1, 6), "Jane CFO", 60_000, "open-market"),
        InsiderPurchase(2, "ATI", date(2026, 1, 16), "John CEO", 75_000, "open-market"),
    ]
    score, _ = score_context("ATI", as_of, date(2026, 1, 1), [], purchases, [], calendar=cal)
    assert score == 0


# -- check_earnings_within_5d --------------------------------------------------------

def test_earnings_within_5d_true_at_boundary(cal):
    as_of = date(2026, 1, 6)
    scheduled = date(2026, 1, 15)  # exactly 7 trading days -- outside window
    assert check_earnings_within_5d("ATI", as_of, date(2026, 1, 13), calendar=cal) is True  # 5 trading days


def test_earnings_within_5d_false_when_too_far(cal):
    as_of = date(2026, 1, 6)
    assert check_earnings_within_5d("ATI", as_of, date(2026, 1, 20), calendar=cal) is False


def test_earnings_within_5d_raises_when_no_date():
    with pytest.raises(ValueError):
        check_earnings_within_5d("ATI", date(2026, 1, 6), None)


# -- compute_red_flag -------------------------------------------------------------------

def test_compute_red_flag_true_only_for_context_minus_one():
    assert compute_red_flag(-1) is True
    assert compute_red_flag(0) is False
    assert compute_red_flag(1) is False
