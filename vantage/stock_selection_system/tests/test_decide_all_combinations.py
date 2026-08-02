"""
Acceptance gate per the implementation prompt's function 5:
"Write unit tests covering all 27 combinations of (earnings_score, market_score,
context_score) in {-1,0,1}^3, crossed with red_flag in {True, False} and
earnings_within_5d in {True, False}, and assert each maps to exactly one label."

The base (red_flag=False, earnings_within_5d=False) expected label per (e, m, c)
combination below was hand-derived directly from the frozen spec's Section 9
numeric-rule table, independently of decide()'s own control flow, so this test
is not just re-deriving decide()'s logic against itself.
"""
import itertools

import pytest

from src.scoring import decide

SCORES = (-1, 0, 1)

# Hand-derived base label for every (earnings, market, context) combination,
# assuming red_flag=False and earnings_within_5d=False. Derived from:
#   total = e + m + c
#   total <= -1                              -> Reject   (checked first)
#   total >= 2                                -> Confirm
#   {e, m} == {1, -1} (opposite signs)        -> Mixed
#   otherwise (total is 0 or 1)               -> Mixed
BASE_LABEL = {
    (-1, -1, -1): "Reject",
    (-1, -1, 0): "Reject",
    (-1, -1, 1): "Reject",
    (-1, 0, -1): "Reject",
    (-1, 0, 0): "Reject",
    (-1, 0, 1): "Mixed",
    (-1, 1, -1): "Reject",  # opposite-sign carve-out: total=-1 forces Reject
    (-1, 1, 0): "Mixed",
    (-1, 1, 1): "Mixed",
    (0, -1, -1): "Reject",
    (0, -1, 0): "Reject",
    (0, -1, 1): "Mixed",
    (0, 0, -1): "Reject",
    (0, 0, 0): "Mixed",
    (0, 0, 1): "Mixed",
    (0, 1, -1): "Mixed",
    (0, 1, 0): "Mixed",
    (0, 1, 1): "Confirm",
    (1, -1, -1): "Reject",  # opposite-sign carve-out: total=-1 forces Reject
    (1, -1, 0): "Mixed",
    (1, -1, 1): "Mixed",
    (1, 0, -1): "Mixed",
    (1, 0, 0): "Mixed",
    (1, 0, 1): "Confirm",
    (1, 1, -1): "Mixed",
    (1, 1, 0): "Confirm",
    (1, 1, 1): "Confirm",
}


def expected_label(e, m, c, red_flag, earnings_within_5d):
    if red_flag:
        return "Reject"
    if earnings_within_5d:
        return "Wait"
    return BASE_LABEL[(e, m, c)]


def test_base_label_table_is_exhaustive():
    assert len(BASE_LABEL) == 27


@pytest.mark.parametrize(
    "e,m,c,red_flag,earnings_within_5d",
    list(
        itertools.product(SCORES, SCORES, SCORES, [True, False], [True, False])
    ),
)
def test_decide_all_108_combinations(e, m, c, red_flag, earnings_within_5d):
    decision, confidence = decide(e, m, c, red_flag, earnings_within_5d)
    expected = expected_label(e, m, c, red_flag, earnings_within_5d)
    assert decision == expected, f"e={e} m={m} c={c} red_flag={red_flag} wait={earnings_within_5d}"
    assert confidence == expected


def test_red_flag_always_wins_over_wait():
    decision, _ = decide(1, 1, -1, red_flag=True, earnings_within_5d=True)
    assert decision == "Reject"


def test_opposite_sign_total_minus_one_is_reject_not_mixed():
    # earnings=+1, market=-1, context=-1: opposite signs (e,m) but total=-1.
    # The carve-out in Section 9 requires total<=-1 to be checked BEFORE the
    # opposite-signs rule, so this must resolve to Reject, not Mixed.
    decision, _ = decide(1, -1, -1, red_flag=False, earnings_within_5d=False)
    assert decision == "Reject"


def test_confirm_requires_no_negative_group():
    # Confirm can only occur when total>=2, which is only reachable when
    # neither earnings nor market is -1 (context alone at -1 would set red_flag).
    decision, _ = decide(1, 1, 0, red_flag=False, earnings_within_5d=False)
    assert decision == "Confirm"
