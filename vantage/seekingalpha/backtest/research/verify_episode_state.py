"""Cross-validation, not part of the frozen spec: catches drift between two independent
implementations of "what is this ETF's current rating episode" -- research/pipeline.py's
etf_rating_transition_events/etf_persistence_events (Python, used to define and test the historical
rule) and src/data.ts's currentEpisodeState (TypeScript, used to detect live matches on the ETF
Check page). There is no shared code path between them; nothing else would catch them disagreeing.

Usage:
    1. Start the dev server (npm run dev) so /api/analysis?action=episodeFixture is reachable.
    2. python verify_episode_state.py [--base-url http://localhost:5173]

Exits non-zero and prints every mismatch if the two sides disagree on qualifiesNow, episodeAgeDays,
or censored for any (ticker, filter) pair.

Expected, non-bug sources of difference (documented so a mismatch report is interpretable, not just
alarming): TS's usable-record filter additionally requires a finite price and quant score on a row,
where Python's build_rating_timeline only requires a valid tier -- a row with a valid rating but a
missing score could be excluded on the TS side and included on the Python side. That would appear
here as a genuine, worth-investigating difference, not a false alarm to suppress.
"""
import argparse
import json
import sys
import urllib.request
from pathlib import Path

import pandas as pd

import pipeline as pl

DB_PATH = Path(__file__).resolve().parent.parent / '.data' / 'vantage.sqlite'
FILTER_TS_TO_PY = {'strong-buy': 'strong_buy', 'bullish-plus': 'bullish_plus'}


def python_episode_state(dates, qualifies):
    """Mirrors currentEpisodeState() in src/data.ts exactly, including the left-censoring guard."""
    if len(dates) == 0:
        return None
    if not qualifies[-1]:
        return dict(qualifiesNow=False, episodeAgeDays=0, censored=False)
    start_index = len(dates) - 1
    while start_index > 0 and qualifies[start_index - 1]:
        start_index -= 1
    censored = start_index == 0
    episode_age_days = max(0, (dates[-1] - dates[start_index]).days)
    return dict(qualifiesNow=True, episodeAgeDays=int(episode_age_days), censored=censored)


def build_python_fixture():
    etfs = pl.load_etf_tickers(DB_PATH)
    prices, changes = pl.load_price_and_rating_data(DB_PATH)
    prices = prices[prices['ticker'].isin(etfs)].reset_index(drop=True)
    changes = changes[changes['ticker'].isin(etfs)].reset_index(drop=True)
    timeline = pl.build_rating_timeline(prices, changes)

    rows = {}
    for ticker, group in timeline.groupby('ticker'):
        group = group.sort_values('as_of_date')
        dates = pd.to_datetime(group['as_of_date']).to_numpy()
        dates = pd.to_datetime(dates)
        tiers = group['tier'].to_numpy()
        for ts_filter, py_filter in FILTER_TS_TO_PY.items():
            qualifies = pl.ETF_FILTERS[py_filter](pd.Series(tiers)).to_numpy(dtype=bool)
            state = python_episode_state(dates, qualifies)
            if state is None:
                continue
            rows[(ticker.upper(), ts_filter)] = state
    return rows


def fetch_ts_fixture(base_url):
    url = f"{base_url}/api/analysis?action=episodeFixture"
    with urllib.request.urlopen(url, timeout=60) as response:
        payload = json.loads(response.read())
    rows = {}
    for row in payload['data']:
        rows[(row['ticker'].upper(), row['filter'])] = dict(
            qualifiesNow=row['qualifiesNow'], episodeAgeDays=row['episodeAgeDays'], censored=row['censored'])
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base-url', default='http://localhost:5173')
    args = ap.parse_args()

    print("Computing Python-side episode states from the live database...")
    python_rows = build_python_fixture()
    print(f"  {len(python_rows)} (ticker, filter) pairs")

    print(f"Fetching TypeScript-side episode states from {args.base_url} ...")
    try:
        ts_rows = fetch_ts_fixture(args.base_url)
    except Exception as error:
        print(f"Could not reach the dev server: {error}\nIs `npm run dev` running?")
        sys.exit(2)
    print(f"  {len(ts_rows)} (ticker, filter) pairs")

    only_python = sorted(set(python_rows) - set(ts_rows))
    only_ts = sorted(set(ts_rows) - set(python_rows))
    shared = sorted(set(python_rows) & set(ts_rows))

    mismatches = []
    for key in shared:
        if python_rows[key] != ts_rows[key]:
            mismatches.append((key, python_rows[key], ts_rows[key]))

    print(f"\nCompared {len(shared)} shared pairs.")
    if only_python:
        print(f"  {len(only_python)} pairs only in Python (e.g. {only_python[:5]})")
    if only_ts:
        print(f"  {len(only_ts)} pairs only in TypeScript (e.g. {only_ts[:5]})")

    if not mismatches:
        print("PASS: every shared (ticker, filter) pair agrees on qualifiesNow, episodeAgeDays, and censored.")
        sys.exit(0)

    print(f"\nFAIL: {len(mismatches)} mismatches:")
    for (ticker, filter_name), python_state, ts_state in mismatches[:50]:
        print(f"  {ticker} / {filter_name}: python={python_state}  ts={ts_state}")
    if len(mismatches) > 50:
        print(f"  ... and {len(mismatches) - 50} more")
    sys.exit(1)


if __name__ == '__main__':
    main()
