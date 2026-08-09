#!/usr/bin/env python3
"""
Usage:
    python run_analysis.py --input <file_or_dir> --spy spy_series_2023-07-31_2026-08-03.csv --out report/

--input : a .sqlite/.db file, OR a directory (e.g. your
          seekingalpha/backtest/input/3-year/single folder) containing one
          or more such files with historical_prices / ticker_changes
          tables. Add a new file to the folder to add tickers or history —
          nothing else needs to change.
--spy   : the cached SPY series CSV. Only needs regenerating if you extend
          the date range past what's cached (see README.md).
--out   : output directory for full_results.csv and report.md.

This runs the full pre-registered grid (pipeline.LOOKBACKS_TD x HOLDS_TD x
FLOORS x DIP_TOLS), applies Holm/BH correction across ALL of it as one
family, flags anything below the cluster-count floor as untestable, and
auto-runs the concentration + placebo diagnostics on the best-looking
testable cut so a big mean never gets reported without its context.
"""
import argparse
from pathlib import Path
import pandas as pd
import numpy as np

import pipeline as pl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True)
    ap.add_argument('--spy', required=True)
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
        rows.append(dict(lookback=cell['lookback'], hold=cell['hold'], floor=cell['floor'],
                          dip_tolerance=cell['dip_tolerance'], testable=testable, **r))

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

    print(f"\nDone. All outputs in {out_dir}/")


if __name__ == '__main__':
    main()
