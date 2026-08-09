import unittest
from unittest.mock import patch

import pandas as pd

import pipeline as pl


class EtfPipelineTests(unittest.TestCase):
    def setUp(self):
        self.prices = pd.DataFrame({
            'ticker': ['fund'] * 5,
            'as_of_date': pd.to_datetime([
                '2024-01-02', '2024-01-03', '2024-02-01',
                '2024-02-03', '2024-04-03',
            ]),
            'adj_close': [100.0, 101.0, 108.0, 110.0, 120.0],
        })
        dates = pd.to_datetime([
            '2024-01-02', '2024-01-03', '2024-02-01',
            '2024-02-03', '2024-04-03',
        ])
        self.spy = pd.Series([100.0, 100.5, 103.0, 104.0, 108.0], index=dates)

    def test_transition_requires_a_prior_non_bullish_rating(self):
        timeline = pd.DataFrame({
            'as_of_date': pd.to_datetime([
                '2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04',
            ]),
            'tier': [4, 3, 5, 5],
        })
        events = list(pl.etf_rating_transition_events(timeline, 'bullish_plus'))
        self.assertEqual(events, [pd.Timestamp('2024-01-03')])

    def test_persistence_uses_calendar_days_and_emits_once_per_episode(self):
        timeline = pd.DataFrame({
            'as_of_date': pd.to_datetime([
                '2024-01-01', '2024-01-15', '2024-01-31', '2024-02-15',
                '2024-02-16', '2024-02-17', '2024-03-18',
            ]),
            'tier': [4, 4, 4, 4, 3, 4, 4],
        })
        events = list(pl.etf_persistence_events(timeline, 'bullish_plus', 30))
        self.assertEqual(events, [pd.Timestamp('2024-01-31'), pd.Timestamp('2024-03-18')])

    def test_trade_enters_next_session_and_uses_closest_bounded_exit(self):
        trade, reason = pl.forward_etf_trade(
            self.prices, pd.Timestamp('2024-01-02'), 30, self.spy,
        )
        self.assertIsNone(reason)
        self.assertEqual(trade['entry'], pd.Timestamp('2024-01-03'))
        self.assertEqual(trade['exit'], pd.Timestamp('2024-02-01'))
        self.assertAlmostEqual(trade['ret'], 108 / 101 - 1)
        self.assertAlmostEqual(trade['bhar'], (108 / 101 - 1) - (103 / 100.5 - 1))

    def test_incomplete_horizon_is_dropped(self):
        trade, reason = pl.forward_etf_trade(
            self.prices, pd.Timestamp('2024-02-03'), 180, self.spy,
        )
        self.assertIsNone(trade)
        self.assertEqual(reason, 'incomplete_horizon')

    def test_non_positive_exit_price_is_dropped(self):
        for invalid_price in (0.0, -1.0):
            with self.subTest(invalid_price=invalid_price):
                prices = self.prices.copy()
                prices.loc[prices['as_of_date'] == pd.Timestamp('2024-02-01'), 'adj_close'] = invalid_price
                trade, reason = pl.forward_etf_trade(
                    prices, pd.Timestamp('2024-01-02'), 30, self.spy,
                )
                self.assertIsNone(trade)
                self.assertEqual(reason, 'invalid_etf_price')

    def test_family_b_placebo_keeps_signal_etf_in_each_peer_pool(self):
        dates = pd.to_datetime(['2024-01-01'])
        options = {
            'signal': {'ret': 0.10},
            'peer_a': {'ret': 0.20},
            'peer_b': {'ret': 0.20},
        }
        trades = pd.DataFrame([{
            'ticker': 'signal',
            'signal': dates[0],
            'hold_days': 30,
            'filter': 'bullish_plus',
            'excess_pool': 0.0,
        }])
        cell = {
            'family': 'persistence',
            'filter': 'bullish_plus',
            'hold_days': 30,
            'outcome_column': 'excess_pool',
            'trades': trades,
        }
        empty_prices = pd.DataFrame(columns=['ticker', 'as_of_date', 'adj_close'])
        empty_timeline = pd.DataFrame(columns=['ticker', 'as_of_date', 'tier'])
        empty_spy = pd.Series(dtype=float)
        with patch.object(pl, '_etf_returns_for_signal', return_value=options):
            result = pl.etf_placebo_test(
                cell, empty_prices, empty_timeline, empty_spy, n_sim=1, seed=7,
            )

        # Both placebo candidates: 0.20 - mean(0.10, 0.20) = 0.05.
        # If the signal ETF were wrongly removed first, the result would be 0.
        self.assertAlmostEqual(result['random_median'], 0.05)


if __name__ == '__main__':
    unittest.main()
