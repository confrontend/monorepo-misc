#!/usr/bin/env python3
"""
Usage:
    python run_analysis.py --input <file_or_dir> --spy spy_series_2023-07-31_2026-08-03.csv --out report/

--input : a .sqlite/.db file, OR a directory (e.g. your
          seekingalpha/backtest/input/3-year folder) containing one
          or more such files with historical_prices / ticker_changes
          tables. Add a new file to the folder to add tickers or history —
          nothing else needs to change.
--spy   : the cached SPY series CSV. Only needs regenerating if you extend
          the date range past what's cached (see README.md).
--out   : output directory for full_results.csv and report.md.

This runs the existing stock bullish grid, the separately frozen bearish
families in BEARISH_PRESPEC.md, and the two ETF families in ETF_PRESPEC.md.
Holm/BH correction is applied within each declared family, anything below the
cluster-count floor is flagged untestable, and concentration/placebo diagnostics
run on the strongest testable cut and every cut that clears the bar.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
import pandas as pd
import numpy as np

import pipeline as pl


def _scalar(value):
    """numpy -> json-safe. NaN becomes null rather than the literal NaN,
    which json.dump would emit and JSON.parse would reject."""
    if value is None:
        return None
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return None if not np.isfinite(value) else float(value)
    if isinstance(value, (np.bool_, bool)):
        return bool(value)
    return value


def _analyse_bearish_family(grid):
    """Expand one bearish rule grid into its two corrected outcome tests."""
    rows = []
    for cell in grid:
        trades = cell['trades']
        ticker_count = trades['ticker'].nunique() if len(trades) else 0
        testable = ticker_count >= pl.MIN_CLUSTERS
        for outcome_name, outcome_column in pl.BEARISH_OUTCOMES.items():
            if testable:
                result = pl.wild_cluster_bootstrap_t(
                    trades[outcome_column].values, trades['ticker'].values)
                ci_low, ci_high = pl.cluster_bootstrap_ci(
                    trades[outcome_column].values, trades['ticker'].values)
            else:
                result = dict(
                    mean=(trades[outcome_column].mean() if len(trades) else np.nan),
                    t=np.nan, p=np.nan, n=len(trades), g=ticker_count,
                )
                ci_low = ci_high = np.nan
            plain = pl.bearish_trade_outcomes(trades, outcome_column)
            rows.append(dict(
                family=cell['family'],
                lookback=cell.get('lookback'),
                hold=cell['hold'],
                signal=cell['signal'],
                outcome=outcome_name,
                outcome_column=outcome_column,
                candidate_signals=cell['candidate_signals'],
                incomplete_trades=cell['incomplete_trades'],
                overlap_skipped=cell['overlap_skipped'],
                drop_reasons=json.dumps(cell['drop_reasons'], sort_keys=True),
                testable=testable,
                **result,
                **plain,
                ci_low=ci_low,
                ci_high=ci_high,
            ))

    results = pd.DataFrame(rows)
    testable_mask = results['testable']
    # Every frozen cell stays in the correction burden. Untestable cells have
    # no inferential p-value, so p=1 is used only while computing the family
    # adjustment; their displayed adjusted p remains blank. This preserves the
    # declared 12/48-test scopes without pretending thin cells were tested.
    holm, bh = pl.holm_bh(results['p'].fillna(1.0).values)
    results['holm_p'] = np.nan
    results['bh_p'] = np.nan
    results.loc[testable_mask, 'holm_p'] = holm[testable_mask.to_numpy()]
    results.loc[testable_mask, 'bh_p'] = bh[testable_mask.to_numpy()]
    results['discovered_rule'] = (
        testable_mask
        & (results['t'].abs() >= pl.DISCOVERY_T)
        & (results['holm_p'] < pl.ALPHA)
    )
    return results.sort_values('p', na_position='last').reset_index(drop=True)


def _top_bearish_candidate(results, grid, prices, out_dir, stem):
    testable = results[results['testable']].dropna(subset=['t'])
    if testable.empty:
        return None
    best = testable.iloc[testable['t'].abs().values.argmax()]
    best_lookback = best.get('lookback')
    best_lookback = None if pd.isna(best_lookback) else best_lookback
    cell = next(
        item for item in grid
        if item['hold'] == best['hold']
        and item['signal'] == best['signal']
        and item.get('lookback') == best_lookback
    )
    outcome_column = best['outcome_column']
    concentration = pl.bearish_concentration_check(cell['trades'], outcome_column)
    placebo = pl.bearish_placebo_test(
        cell['trades'], prices, outcome_column, n_sim=2000)
    concentration.to_csv(out_dir / f'{stem}_concentration.csv', index=False)
    pd.Series(placebo).to_csv(out_dir / f'{stem}_placebo.csv')

    candidate = {
        key: _scalar(best.get(key)) for key in [
            'family', 'lookback', 'hold', 'signal', 'outcome',
            'candidate_signals', 'incomplete_trades', 'overlap_skipped',
            'testable', 'mean', 'median', 'positive_rate',
            'stock_fell_rate', 'underperformed_spy_rate', 't', 'p', 'n', 'g',
            'ci_low', 'ci_high', 'holm_p', 'bh_p', 'discovered_rule',
        ]
    }
    candidate['drop_reasons'] = cell['drop_reasons']
    candidate['placebo'] = {key: _scalar(value) for key, value in placebo.items()}
    print(
        f"\n--- {stem.replace('_', ' ').title()} top candidate: "
        f"{best['signal']} / {best_lookback or 'no lookback'} / "
        f"{best['hold']} / {best['outcome']} "
        f"(n={best['n']:.0f}, g={best['g']:.0f}, mean={best['mean']:.4f}, "
        f"t={best['t']:.2f}, Holm p={best['holm_p']:.4f}) ---"
    )
    return candidate


def _analyse_etf_family(grid):
    """Apply the shared clustered test and family-wide corrections to one frozen ETF grid."""
    rows = []
    for cell in grid:
        trades = cell['trades']
        outcome_column = cell['outcome_column']
        ticker_count = trades['ticker'].nunique() if len(trades) else 0
        testable = ticker_count >= pl.MIN_CLUSTERS
        if testable:
            result = pl.wild_cluster_bootstrap_t(
                trades[outcome_column].values, trades['ticker'].values)
            ci_low, ci_high = pl.cluster_bootstrap_ci(
                trades[outcome_column].values, trades['ticker'].values, level=0.95)
        else:
            result = dict(
                mean=(trades[outcome_column].mean() if len(trades) else np.nan),
                t=np.nan, p=np.nan, n=len(trades), g=ticker_count)
            ci_low = ci_high = np.nan
        rows.append(dict(
            family=cell['family'], filter=cell['filter'],
            persistence=cell.get('persistence'), hold=cell['hold'],
            candidate_signals=cell['candidate_signals'],
            incomplete_trades=cell['incomplete_trades'],
            drop_reasons=json.dumps(cell['drop_reasons'], sort_keys=True),
            outcome=outcome_column, testable=testable,
            mean_return=(trades['ret'].mean() if len(trades) else np.nan),
            median_return=(trades['ret'].median() if len(trades) else np.nan),
            mean_spy_return=(trades['spy_ret'].mean() if len(trades) else np.nan),
            mean_excess_spy=(trades['bhar'].mean() if len(trades) else np.nan),
            beat_spy_rate=((trades['bhar'] > 0).mean() if len(trades) else np.nan),
            mean_pool_return=(trades['pool_ret'].mean()
                              if len(trades) and 'pool_ret' in trades else np.nan),
            mean_excess_pool=(trades['excess_pool'].mean()
                              if len(trades) and 'excess_pool' in trades else np.nan),
            beat_pool_rate=((trades['excess_pool'] > 0).mean()
                            if len(trades) and 'excess_pool' in trades else np.nan),
            # Absolute loss rate: did the ETF itself lose money, independent of SPY/pool. Distinct
            # from beat_spy_rate/beat_pool_rate, which only measure relative outperformance and can
            # look strong even when the ETF fell, as long as it fell less than the benchmark did.
            absolute_loss_rate=((trades['ret'] < 0).mean() if len(trades) else np.nan),
            **result, ci_low=ci_low, ci_high=ci_high,
        ))
    results = pd.DataFrame(rows)
    testable_mask = results['testable']
    holm, bh = pl.holm_bh(results['p'].fillna(1.0).values)
    results['holm_p'] = np.nan
    results['bh_p'] = np.nan
    results.loc[testable_mask, 'holm_p'] = holm[testable_mask.to_numpy()]
    results.loc[testable_mask, 'bh_p'] = bh[testable_mask.to_numpy()]
    results['discovered_rule'] = (
        testable_mask
        & (results['t'].abs() >= pl.DISCOVERY_T)
        & (results['holm_p'] < pl.ALPHA)
    )
    return results.sort_values('p', na_position='last').reset_index(drop=True)


def _etf_family_diagnostics(results, grid, prices, timeline, spy, out_dir, stem, progress=None):
    """Persist diagnostics for every clearing cell plus the strongest testable cell."""
    testable = results[results['testable']].dropna(subset=['t'])
    if testable.empty:
        pd.DataFrame().to_csv(out_dir / f'{stem}_concentration.csv', index=False)
        pd.DataFrame().to_csv(out_dir / f'{stem}_placebo.csv', index=False)
        return None
    strongest_index = testable['t'].abs().idxmax()
    diagnostic_indices = set(results.index[results['discovered_rule']].tolist()) | {strongest_index}
    concentration_frames = []
    placebo_rows = []
    strongest_candidate = None
    diagnostic_list = sorted(diagnostic_indices)
    for diagnostic_number, result_index in enumerate(diagnostic_list, start=1):
        if progress:
            progress(f"{stem}: diagnostic {diagnostic_number}/{len(diagnostic_list)}")
        row = results.loc[result_index]
        persistence = None if pd.isna(row.get('persistence')) else row.get('persistence')
        cell = next(item for item in grid
                    if item['filter'] == row['filter'] and item['hold'] == row['hold']
                    and item.get('persistence') == persistence)
        outcome_column = cell['outcome_column']
        diagnostic_trades = cell['trades'].copy()
        diagnostic_trades['bhar'] = diagnostic_trades[outcome_column]
        concentration = pl.concentration_check(diagnostic_trades)
        concentration.insert(0, 'hold', row['hold'])
        concentration.insert(0, 'persistence', persistence)
        concentration.insert(0, 'filter', row['filter'])
        concentration_frames.append(concentration)
        placebo = pl.etf_placebo_test(
            cell, prices, timeline, spy, n_sim=2000,
            seed=20260808 + int(result_index) * 101,
            progress=(lambda message, prefix=stem: progress(f"{prefix}: {message}")
                      if progress else None))
        placebo_rows.append(dict(
            filter=row['filter'], persistence=persistence, hold=row['hold'],
            **placebo))
        if result_index == strongest_index:
            strongest_candidate = {
                key: _scalar(row.get(key)) for key in [
                    'family', 'filter', 'persistence', 'hold', 'candidate_signals',
                    'incomplete_trades', 'testable', 'mean_return', 'median_return',
                    'mean_spy_return', 'mean_excess_spy', 'beat_spy_rate',
                    'mean_pool_return', 'mean_excess_pool', 'beat_pool_rate',
                    'absolute_loss_rate',
                    'mean', 't', 'p', 'n', 'g', 'ci_low', 'ci_high',
                    'holm_p', 'bh_p', 'discovered_rule',
                ]
            }
            strongest_candidate['drop_reasons'] = cell['drop_reasons']
            strongest_candidate['placebo'] = {
                key: _scalar(value) for key, value in placebo.items()}
    concentration_output = pd.concat(concentration_frames, ignore_index=True) \
        if concentration_frames else pd.DataFrame()
    concentration_output.to_csv(out_dir / f'{stem}_concentration.csv', index=False)
    pd.DataFrame(placebo_rows).to_csv(out_dir / f'{stem}_placebo.csv', index=False)
    return strongest_candidate


def _etf_trade_examples(cell, count=10):
    """Return evenly spaced chronological examples from one completed ETF cell.

    These are deliberately not the highest-return trades. Spacing across the validation period
    makes the UI examples useful for explaining the rule without presenting a cherry-picked list as
    evidence of the family average.
    """
    trades = cell['trades'].sort_values(['signal', 'ticker']).reset_index(drop=True)
    if trades.empty:
        return []
    indices = np.unique(np.rint(np.linspace(0, len(trades) - 1, min(count, len(trades)))).astype(int))
    examples = []
    for index in indices:
        trade = trades.iloc[int(index)]
        entry = pd.Timestamp(trade['entry'])
        exit_date = pd.Timestamp(trade['exit'])
        examples.append({
            'ticker': str(trade['ticker']),
            'signal_date': pd.Timestamp(trade['signal']).date().isoformat(),
            'buy_date': entry.date().isoformat(),
            'sell_date': exit_date.date().isoformat(),
            'days_held': int((exit_date - entry).days),
            'buy_price': float(trade['entry_price']),
            'sell_price': float(trade['exit_price']),
            'etf_return': float(trade['ret']),
            'spy_return': float(trade['spy_ret']),
            'excess_spy': float(trade['bhar']),
            'dollar_start': 100.0,
            'dollar_end': float(100 * (1 + trade['ret'])),
        })
    return examples


def main():
    default_db = Path(__file__).resolve().parent.parent / '.data' / 'vantage.sqlite'
    ap = argparse.ArgumentParser()
    # Both default to the app's database, which the Import button fills. Passing a folder of
    # .json/.csv files still works, and is what the standalone runs used before ingestion existed.
    ap.add_argument('--input', default=str(default_db))
    ap.add_argument('--spy', default=str(default_db))
    ap.add_argument('--out', default='report')
    args = ap.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading price + rating data...")
    prices, changes = pl.load_price_and_rating_data(args.input)
    print(f"  {prices['ticker'].nunique()} tickers, {len(prices)} price rows, "
          f"{len(changes)} rating-change events")

    print("Loading cached SPY series...")
    spy = pl.load_spy_series(args.spy)
    print(f"  {spy.index.min().date()} to {spy.index.max().date()} ({len(spy)} days)")

    print("Building rating timeline...")
    timeline = pl.build_rating_timeline(prices, changes)

    print("Running screen grid (this is the only step that scales with data size)...")
    grid = pl.run_screen_grid(timeline, prices, spy)

    rows = []
    for cell in grid:
        tdf = cell['trades']
        n_tickers = tdf['ticker'].nunique() if len(tdf) else 0
        testable = n_tickers >= pl.MIN_CLUSTERS
        if testable:
            r = pl.wild_cluster_bootstrap_t(tdf['bhar'].values, tdf['ticker'].values)
        else:
            r = dict(mean=tdf['bhar'].mean() if len(tdf) else np.nan, t=np.nan, p=np.nan,
                      n=len(tdf), g=n_tickers)
        # What the average trade did in plain terms, so the dashboard can show
        # a dollar outcome without re-deriving anything from the excess return.
        outcomes = pl.trade_outcomes(tdf)
        if testable:
            ret_lo, ret_hi = pl.cluster_bootstrap_ci(tdf['ret'].values, tdf['ticker'].values)
            bhar_lo, bhar_hi = pl.cluster_bootstrap_ci(tdf['bhar'].values, tdf['ticker'].values)
        else:
            ret_lo = ret_hi = bhar_lo = bhar_hi = np.nan
        rows.append(dict(lookback=cell['lookback'], hold=cell['hold'], floor=cell['floor'],
                          dip_tolerance=cell['dip_tolerance'], testable=testable, **r, **outcomes,
                          ret_ci_low=ret_lo, ret_ci_high=ret_hi,
                          bhar_ci_low=bhar_lo, bhar_ci_high=bhar_hi))

    results = pd.DataFrame(rows)
    testable_mask = results['testable']
    holm, bh = pl.holm_bh(results.loc[testable_mask, 'p'].fillna(1.0).values)
    results.loc[testable_mask, 'holm_p'] = holm
    results.loc[testable_mask, 'bh_p'] = bh
    results['discovered_rule'] = testable_mask & (results['t'].abs() >= pl.DISCOVERY_T) & \
                                  (results['holm_p'] < pl.ALPHA)

    results = results.sort_values('p', na_position='last').reset_index(drop=True)
    results.to_csv(out_dir / 'full_results.csv', index=False)
    print(f"\nSaved full grid ({len(results)} cuts, {int(results['testable'].sum())} testable) "
          f"to {out_dir/'full_results.csv'}")
    print(results.head(10).to_string(index=False))

    n_discovered = results['discovered_rule'].sum()
    print(f"\nCuts clearing t>={pl.DISCOVERY_T} AND Holm-corrected p<{pl.ALPHA}: {n_discovered}")

    # Everything the dashboard needs that isn't a per-row number: the
    # thresholds and grid the run actually used, plus what the data was.
    # Written here rather than read from pipeline.py by the frontend so the
    # displayed thresholds can never describe a different run than the
    # displayed results -- a stale run_meta.json means stale CSVs too.
    meta = {
        'generated_at': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'input_path': str(args.input),
        'spy_path': str(args.spy),
        'dataset': {
            'tickers': int(prices['ticker'].nunique()),
            'price_rows': int(len(prices)),
            'rating_events': int(len(changes)),
            'price_start': str(prices['as_of_date'].min().date()),
            'price_end': str(prices['as_of_date'].max().date()),
            'spy_start': str(spy.index.min().date()),
            'spy_end': str(spy.index.max().date()),
            'spy_days': int(len(spy)),
        },
        'thresholds': {
            'min_clusters': pl.MIN_CLUSTERS,
            'discovery_t': pl.DISCOVERY_T,
            'alpha': pl.ALPHA,
            'bootstrap_reps': pl.B_BOOT,
        },
        'grid': {
            'lookbacks': list(pl.LOOKBACKS_TD),
            'holds': list(pl.HOLDS_TD),
            'floors': list(pl.FLOORS),
            'dip_tolerances': list(pl.DIP_TOLS),
        },
        'summary': {
            'cuts_total': int(len(results)),
            'cuts_testable': int(results['testable'].sum()),
            'discovered_rules': int(n_discovered),
        },
        'top_candidate': None,
    }

    # Auto-diagnostics on the best testable candidate, discovered or not,
    # so a big mean never gets reported without seeing what's behind it.
    testable_results = results[results['testable']].dropna(subset=['t'])
    if len(testable_results):
        best = testable_results.iloc[testable_results['t'].abs().values.argmax()] \
            if not testable_results.empty else None
        if best is not None:
            cell = next(c for c in grid if c['lookback'] == best['lookback']
                        and c['hold'] == best['hold'] and c['floor'] == best['floor']
                        and c['dip_tolerance'] == best['dip_tolerance'])
            tdf = cell['trades']
            print(f"\n--- Diagnostics on top candidate: {best['lookback']} lookback / "
                  f"{best['hold']} hold / {best['floor']} / {best['dip_tolerance']} "
                  f"(n={best['n']:.0f}, g={best['g']:.0f}, t={best['t']:.2f}, p={best['p']:.4f}) ---")
            conc = pl.concentration_check(tdf)
            print(conc.to_string(index=False))
            conc.to_csv(out_dir / 'top_candidate_concentration.csv', index=False)

            hold_td = pl.HOLDS_TD[best['hold']]
            placebo = pl.placebo_test(tdf, prices, spy, hold_td=hold_td, n_sim=2000)
            print(f"\nPlacebo (random tickers, same dates): observed mean="
                  f"{placebo['observed_mean']*100:.2f}pp vs random median="
                  f"{placebo['random_median']*100:.2f}pp "
                  f"(empirical p={placebo['empirical_p']:.4f})")
            pd.Series(placebo).to_csv(out_dir / 'top_candidate_placebo.csv')

            meta['top_candidate'] = {
                'lookback': best['lookback'], 'hold': best['hold'],
                'floor': best['floor'], 'dip_tolerance': best['dip_tolerance'],
                'n': _scalar(best['n']), 'g': _scalar(best['g']),
                'mean': _scalar(best['mean']), 't': _scalar(best['t']),
                'p': _scalar(best['p']), 'holm_p': _scalar(best.get('holm_p')),
                'bh_p': _scalar(best.get('bh_p')),
                'discovered_rule': _scalar(best['discovered_rule']),
                'placebo_sims': 2000,
                'placebo': {k: _scalar(v) for k, v in placebo.items()},
            }

    # Bearish ratings are tested as two new, separately corrected families.
    # Their frozen rules live in BEARISH_PRESPEC.md.  Running them here keeps
    # one data load and one rating timeline while preserving separate output
    # files and correction scopes.
    print("\nRunning bearish transition family (12 tests)...")
    bearish_transition_grid = pl.run_bearish_transition_grid(timeline, prices, spy)
    bearish_transition = _analyse_bearish_family(bearish_transition_grid)
    bearish_transition.to_csv(out_dir / 'bearish_transition_results.csv', index=False)

    print("Running bearish persistence family (48 tests)...")
    bearish_persistence_grid = pl.run_bearish_persistence_grid(timeline, prices, spy)
    bearish_persistence = _analyse_bearish_family(bearish_persistence_grid)
    bearish_persistence.to_csv(out_dir / 'bearish_persistence_results.csv', index=False)

    transition_top = _top_bearish_candidate(
        bearish_transition, bearish_transition_grid, prices, out_dir,
        'bearish_transition')
    persistence_top = _top_bearish_candidate(
        bearish_persistence, bearish_persistence_grid, prices, out_dir,
        'bearish_persistence')

    universe_audit = pl.universe_end_audit(prices)
    bearish_meta = {
        'generated_at': meta['generated_at'],
        'spec': 'research/BEARISH_PRESPEC.md',
        'prior_exploratory_evidence_known': True,
        'dataset': meta['dataset'],
        'universe_audit': universe_audit,
        'thresholds': meta['thresholds'],
        'execution': {
            'entry': 'first available stock session strictly after the signal date',
            'holds': 'calendar days',
            'incomplete_horizons': 'dropped; never shortened to the last available price',
            'overlap': 'one open trade per ticker per cell',
            'costs': 'gross; adjusted prices include dividend/split economics, but borrow fees, locate availability, slippage, commissions, margin and forced buy-ins are not modeled',
        },
        'families': {
            'transition': {
                'correction_scope': int(len(bearish_transition)),
                'holds': list(pl.BEARISH_HOLDS_DAYS),
                'signals': list(pl.BEARISH_SIGNALS),
                'outcomes': list(pl.BEARISH_OUTCOMES),
                'summary': {
                    'tests_total': int(len(bearish_transition)),
                    'tests_testable': int(bearish_transition['testable'].sum()),
                    'tests_clearing_bar': int(bearish_transition['discovered_rule'].sum()),
                },
                'top_candidate': transition_top,
            },
            'persistence': {
                'correction_scope': int(len(bearish_persistence)),
                'lookbacks': list(pl.BEARISH_LOOKBACKS_TD),
                'holds': list(pl.BEARISH_HOLDS_DAYS),
                'signals': list(pl.BEARISH_SIGNALS),
                'outcomes': list(pl.BEARISH_OUTCOMES),
                'summary': {
                    'tests_total': int(len(bearish_persistence)),
                    'tests_testable': int(bearish_persistence['testable'].sum()),
                    'tests_clearing_bar': int(bearish_persistence['discovered_rule'].sum()),
                },
                'top_candidate': persistence_top,
            },
        },
    }
    (out_dir / 'bearish_meta.json').write_text(
        json.dumps(bearish_meta, indent=2), encoding='utf-8')
    meta['bearish_report'] = 'bearish_meta.json'

    # ETF research is two independent families. Rating trust owns the main question (does a
    # bullish ETF rating beat SPY?); persistence owns only the secondary question (does waiting
    # improve an already-bullish selection?). Their frozen contract is ETF_PRESPEC.md.
    etf_tickers = pl.load_etf_tickers(args.input)
    etf_prices = prices[prices['ticker'].isin(etf_tickers)].copy()
    etf_changes = changes[changes['ticker'].isin(etf_tickers)].copy()
    print(f"\nLoading ETF research universe: {etf_prices['ticker'].nunique()} ETFs")
    if len(etf_prices) and len(etf_changes):
        etf_timeline = pl.build_rating_timeline(etf_prices, etf_changes)

        print("Running ETF rating-trust family (6 tests versus SPY)...")
        etf_rating_grid = pl.run_etf_rating_trust_grid(etf_timeline, etf_prices, spy)
        etf_rating_results = _analyse_etf_family(etf_rating_grid)
        etf_rating_results.to_csv(out_dir / 'etf_rating_trust_results.csv', index=False)

        print("Running ETF persistence family (24 tests versus matching bullish ETFs)...", flush=True)
        etf_persistence_grid = pl.run_etf_persistence_grid(
            etf_timeline, etf_prices, spy,
            progress=lambda message: print(f"ETF persistence progress: {message}", flush=True),
        )
        etf_persistence_results = _analyse_etf_family(etf_persistence_grid)
        etf_persistence_results.to_csv(out_dir / 'etf_persistence_results.csv', index=False)

        etf_rating_top = _etf_family_diagnostics(
            etf_rating_results, etf_rating_grid, etf_prices, etf_timeline, spy,
            out_dir, 'etf_rating_trust',
            progress=lambda message: print(f"ETF diagnostics: {message}", flush=True))
        etf_persistence_top = _etf_family_diagnostics(
            etf_persistence_results, etf_persistence_grid, etf_prices, etf_timeline, spy,
            out_dir, 'etf_persistence',
            progress=lambda message: print(f"ETF diagnostics: {message}", flush=True))
        rating_examples_cell = next(
            cell for cell in etf_rating_grid
            if cell['filter'] == etf_rating_top['filter']
            and cell['hold'] == etf_rating_top['hold']
            and cell.get('persistence') == etf_rating_top.get('persistence'))
        etf_rating_top = dict(etf_rating_top, examples=_etf_trade_examples(rating_examples_cell, count=10))

        validation_start, validation_end = pl._etf_validation_bounds(etf_prices)
        etf_meta = {
            'generated_at': meta['generated_at'],
            'spec': 'research/ETF_PRESPEC.md',
            'prior_exploratory_evidence_known': True,
            'dataset': {
                'etfs': int(etf_prices['ticker'].nunique()),
                'price_rows': int(len(etf_prices)),
                'rating_events': int(len(etf_changes)),
                'price_start': str(etf_prices['as_of_date'].min().date()),
                'price_end': str(etf_prices['as_of_date'].max().date()),
                'validation_start': str(validation_start.date()),
                'validation_end': str(validation_end.date()),
            },
            'thresholds': meta['thresholds'],
            'execution': {
                'entry': 'first usable ETF record strictly after the signal date',
                'exit': 'closest usable ETF record within +/-7 calendar days of entry plus hold_days',
                'incomplete_horizons': 'dropped; never shortened',
                'costs': 'gross of commissions, spread, slippage, taxes, liquidity constraints and market impact',
            },
            'families': {
                'rating_trust': {
                    'question': 'Do bullish-rated ETFs outperform SPY?',
                    'benchmark': 'ETF adjusted return minus SPY adjusted return',
                    'correction_scope': int(len(etf_rating_results)),
                    'filters': list(pl.ETF_FILTERS),
                    'holds': list(pl.ETF_HOLDS_DAYS),
                    'summary': {
                        'tests_total': int(len(etf_rating_results)),
                        'tests_testable': int(etf_rating_results['testable'].sum()),
                        'tests_clearing_bar': int(etf_rating_results['discovered_rule'].sum()),
                        'positive_tests_clearing_bar': int((
                            etf_rating_results['discovered_rule'] & (etf_rating_results['mean'] > 0)).sum()),
                        'negative_tests_clearing_bar': int((
                            etf_rating_results['discovered_rule'] & (etf_rating_results['mean'] < 0)).sum()),
                    },
                    'top_candidate': etf_rating_top,
                },
                'persistence': {
                    'question': 'Does bullish-rating persistence improve on matching bullish ETFs?',
                    'benchmark': 'ETF adjusted return minus matching bullish ETF pool return',
                    'correction_scope': int(len(etf_persistence_results)),
                    'filters': list(pl.ETF_FILTERS),
                    'persistence': list(pl.ETF_PERSISTENCE_DAYS),
                    'holds': list(pl.ETF_HOLDS_DAYS),
                    'summary': {
                        'tests_total': int(len(etf_persistence_results)),
                        'tests_testable': int(etf_persistence_results['testable'].sum()),
                        'tests_clearing_bar': int(etf_persistence_results['discovered_rule'].sum()),
                        'positive_tests_clearing_bar': int((
                            etf_persistence_results['discovered_rule'] & (etf_persistence_results['mean'] > 0)).sum()),
                        'negative_tests_clearing_bar': int((
                            etf_persistence_results['discovered_rule'] & (etf_persistence_results['mean'] < 0)).sum()),
                    },
                    'top_candidate': etf_persistence_top,
                },
            },
        }
        (out_dir / 'etf_meta.json').write_text(
            json.dumps(etf_meta, indent=2), encoding='utf-8')
        meta['etf_report'] = 'etf_meta.json'
    else:
        print("No classified ETFs with both prices and rating changes; ETF report not generated.")

    print("Running final report save...")
    (out_dir / 'run_meta.json').write_text(json.dumps(meta, indent=2), encoding='utf-8')
    print(f"Saved run metadata to {out_dir/'run_meta.json'}")

    print(f"\nDone. All outputs in {out_dir}/")


if __name__ == '__main__':
    main()
