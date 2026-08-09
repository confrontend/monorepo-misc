import unittest

import pandas as pd

import pipeline as pl


class BearishPipelineTests(unittest.TestCase):
    def setUp(self):
        self.prices = pd.DataFrame({
            'ticker': ['abc'] * 5,
            'as_of_date': pd.to_datetime([
                '2024-01-02', '2024-01-03', '2024-02-02',
                '2024-04-02', '2024-07-02',
            ]),
            'adj_close': [100.0, 98.0, 90.0, 80.0, 70.0],
        })
        spy_dates = pd.to_datetime([
            '2024-01-02', '2024-01-03', '2024-02-02',
            '2024-04-02', '2024-07-02',
        ])
        self.spy = pd.Series([100.0, 101.0, 102.0, 104.0, 106.0], index=spy_dates)

    def test_transition_requires_a_prior_rating(self):
        timeline = pd.DataFrame({
            'as_of_date': pd.to_datetime([
                '2024-01-01', '2024-01-02', '2024-01-03', '2024-01-04',
            ]),
            'tier': [2, 2, 3, 1],
        })
        bearish = list(pl.bearish_transition_events(timeline, 'sell_or_strong_sell'))
        strong_sell = list(pl.bearish_transition_events(timeline, 'strong_sell_only'))
        self.assertEqual(bearish, [pd.Timestamp('2024-01-04')])
        self.assertEqual(strong_sell, [pd.Timestamp('2024-01-04')])

    def test_persistence_emits_only_the_first_qualifying_day(self):
        timeline = pd.DataFrame({
            'as_of_date': pd.date_range('2024-01-01', periods=7, freq='D'),
            'tier': [2, 2, 2, 2, 3, 2, 2],
        })
        events = list(pl.bearish_persistence_events(
            timeline, 'sell_or_strong_sell', window_td=3))
        self.assertEqual(events, [pd.Timestamp('2024-01-03')])

    def test_short_enters_next_session_and_uses_full_calendar_horizon(self):
        trade, reason = pl.forward_short_trade(
            self.prices.reset_index(drop=True),
            pd.Timestamp('2024-01-02'),
            hold_days=30,
            spy_series=self.spy,
        )
        self.assertIsNone(reason)
        self.assertEqual(trade['entry'], pd.Timestamp('2024-01-03'))
        self.assertEqual(trade['exit'], pd.Timestamp('2024-02-02'))
        self.assertAlmostEqual(trade['raw_short_return'], 1 - 90 / 98)
        self.assertAlmostEqual(
            trade['spy_hedged_short_return'],
            (102 / 101 - 1) - (90 / 98 - 1),
        )

    def test_incomplete_horizon_is_dropped_not_shortened(self):
        trade, reason = pl.forward_short_trade(
            self.prices.reset_index(drop=True),
            pd.Timestamp('2024-04-02'),
            hold_days=180,
            spy_series=self.spy,
        )
        self.assertIsNone(trade)
        self.assertEqual(reason, 'incomplete_horizon')

    def test_universe_audit_reports_early_ending_series(self):
        prices = pd.DataFrame({
            'ticker': ['live', 'live', 'old'],
            'as_of_date': pd.to_datetime(['2024-01-01', '2024-06-01', '2024-01-01']),
            'adj_close': [10.0, 12.0, 5.0],
        })
        audit = pl.universe_end_audit(prices, stale_days=30)
        self.assertEqual(audit['global_end'], '2024-06-01')
        self.assertEqual(audit['early_end_count'], 1)
        self.assertEqual(audit['early_end_tickers'][0]['ticker'], 'old')


if __name__ == '__main__':
    unittest.main()
