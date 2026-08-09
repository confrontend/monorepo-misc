"""
Seeking Alpha Quant Rating reliability pipeline — reusable analysis engine.

Design principle: the fragile/expensive step (getting a trustworthy SPY
benchmark) is done ONCE and cached to spy_series_*.csv. Everything else
(new tickers, new rating events, new screens) reads that cache instead of
rebuilding it, so re-running after adding data is fast and doesn't touch
the network.

See README.md for usage and how to point this at new data.
"""
import json
import sqlite3
from pathlib import Path
import numpy as np
import pandas as pd

TIER = {'very_bearish': 1, 'bearish': 2, 'neutral': 3, 'bullish': 4, 'very_bullish': 5}

# ---------------------------------------------------------------
# Pre-registered search grid. Edit this, not ad hoc code, when you
# want to test a new cut — keeping it centralized is what makes the
# multiple-testing correction downstream honest.
# ---------------------------------------------------------------
LOOKBACKS_TD = {'3mo': 63, '6mo': 126, '12mo': 252, '18mo': 378}
HOLDS_TD = {'6mo': 126, '12mo': 252, '18mo': 378}
FLOORS = {
    'bullish_plus': lambda tier: tier >= 4,
    'very_bullish_only': lambda tier: tier == 5,
}
DIP_TOLS = {'0pct_strict': 0.0, '1pct_dip': 0.01}
MIN_CLUSTERS = 15      # below this, a cut is reported but flagged untestable
DISCOVERY_T = 3.0      # "discovered rule" bar: t >= this AND Holm-corrected p<ALPHA
ALPHA = 0.05
B_BOOT = 4999

# Bearish research is a separate, frozen methodology documented in
# BEARISH_PRESPEC.md.  It is deliberately not folded into the bullish grid:
# a transition into Sell and a long-running Sell rating are different
# hypotheses, and neither may change the correction family of the already-run
# bullish study.
BEARISH_LOOKBACKS_TD = {'3mo': 63, '6mo': 126, '12mo': 252, '18mo': 378}
BEARISH_HOLDS_DAYS = {'30d': 30, '90d': 90, '180d': 180}
BEARISH_SIGNALS = {
    'sell_or_strong_sell': lambda tier: tier <= 2,
    'strong_sell_only': lambda tier: tier == 1,
}
BEARISH_OUTCOMES = {
    'raw_short': 'raw_short_return',
    'spy_hedged_short': 'spy_hedged_short_return',
}

# ETF research is frozen separately in ETF_PRESPEC.md. Calendar-day windows and next-session entry
# deliberately match ETF Discovery rather than the older stock grid's trading-day convention.
ETF_FILTERS = {
    'strong_buy': lambda tier: tier == 5,
    'bullish_plus': lambda tier: tier >= 4,
}
ETF_PERSISTENCE_DAYS = {'30d': 30, '60d': 60, '90d': 90, '180d': 180}
ETF_HOLDS_DAYS = {'30d': 30, '90d': 90, '180d': 180}
ETF_VALIDATION_DAYS = 365
ETF_EXIT_TOLERANCE_DAYS = 7


# ---------------------------------------------------------------
# 1. Data ingestion — auto-detects any .sqlite/.db under input_path
#    (file or directory) with historical_prices / ticker_changes
#    tables, and merges however many you drop in. Add new tickers
#    or new history by adding another file to the folder — nothing
#    else changes.
#
#    Also reads the flat-CSV export shape that the app's own
#    input/3-year folder uses (prices_*.csv / changes_*.csv,
#    camelCase columns straight off the API) — see _read_csv_export.
#    Both paths produce identical frames, so everything downstream
#    is unaffected by which one a given file took.
# ---------------------------------------------------------------
PRICE_COLUMN_ALIASES = {'slug': 'ticker', 'ticker_slug': 'ticker'}
CHANGE_COLUMN_ALIASES = {
    'slug': 'ticker', 'ticker_slug': 'ticker',
    'createdAt': 'created_at',
    'newRating': 'new_rating',
    'sectorDisplay': 'sector_display',
}


def _sniff_csv_columns(path):
    """Read just the header line with plain Python.

    Deliberately not pandas: this runs against every file in the input
    folder, including ones that aren't ours, and it needs to answer "is this
    file for us?" without depending on any particular pandas version's
    read_csv behaviour. utf-8-sig strips a BOM if a Windows-side exporter
    left one, which would otherwise rename the first column to
    '﻿slug' and make the file silently unrecognisable.
    """
    with open(path, 'r', encoding='utf-8-sig', newline='') as handle:
        header = handle.readline()
    if not header.strip():
        return set()
    return {name.strip().strip('"').strip() for name in header.rstrip('\r\n').split(',')}


def _read_raw_json_export(path):
    """Return ('raw', (prices_frame, changes_frame)) for a raw API dump.

    This is the durable artifact in input/3-year: a list of capture
    records, each `{_slug, _kind: 'prices'|'changes', body: {data: [...]}}`
    straight off Seeking Alpha's API. The prices_*.csv / changes_*.csv files
    are derived from it and get cleaned up, so reading the dump directly is
    what makes a re-run reproducible from whatever is actually in the folder.
    """
    try:
        with open(path, 'r', encoding='utf-8-sig') as handle:
            records = json.load(handle)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return None, f'not readable as JSON ({error.__class__.__name__})'
    if not isinstance(records, list) or not records:
        return None, 'JSON is not a non-empty list of capture records'
    if not any(isinstance(r, dict) and '_kind' in r and 'body' in r for r in records):
        return None, 'JSON has no {_slug, _kind, body} capture records'

    price_rows, change_rows = [], []
    for record in records:
        if not isinstance(record, dict):
            continue
        ticker = str(record.get('_slug', '')).lower()
        entries = (record.get('body') or {}).get('data') or []
        if not ticker or not entries:
            continue
        if record.get('_kind') == 'prices':
            for entry in entries:
                a = entry.get('attributes') or {}
                if a.get('close') is None or a.get('as_of_date') is None:
                    continue
                price_rows.append((ticker, a['as_of_date'], a['close'],
                                   a.get('div_adj_factor', 1.0) or 1.0))
        elif record.get('_kind') == 'changes':
            for entry in entries:
                a = entry.get('attributes') or {}
                rating = a.get('newRating')
                # Same exclusion the sqlite query applies inline.
                if rating is None or rating == '-' or a.get('createdAt') is None:
                    continue
                change_rows.append((ticker, a['createdAt'], rating,
                                    a.get('sectorDisplay')))

    if not price_rows:
        return None, 'capture records contain no usable price rows'

    p = pd.DataFrame(price_rows, columns=['ticker', 'as_of_date', 'close', 'div_adj_factor'])
    p['as_of_date'] = pd.to_datetime(p['as_of_date'], utc=True).dt.tz_localize(None)
    p['adj_close'] = p['close'] * p['div_adj_factor']
    c = pd.DataFrame(change_rows, columns=['ticker', 'created_at', 'new_rating', 'sector_display'])
    if len(c):
        c['created_at'] = pd.to_datetime(c['created_at'], utc=True, format='mixed').dt.tz_localize(None)
    return 'raw', (p[['ticker', 'as_of_date', 'adj_close']], c)


def _read_csv_export(path):
    """Return ('prices'|'changes'|None, frame_or_reason) for a flat CSV export.

    Recognises a file by its columns rather than its filename, so the
    timestamped export names (prices_2026-08-06T06-54-58.csv) don't need
    to follow any convention. Column names are accepted in either the
    API's camelCase form or the sqlite tables' snake_case form.

    On a non-match the second element is a human-readable reason rather
    than None: a file that looks like ours but is skipped anyway is the
    single most confusing failure this loader can have, so the reason is
    carried up into the error message instead of being swallowed.
    """
    try:
        cols = _sniff_csv_columns(path)
    except (OSError, UnicodeDecodeError) as error:
        return None, f'could not read header ({error.__class__.__name__}: {error})'
    if not cols:
        return None, 'empty file'

    if {'close', 'div_adj_factor'} <= cols and ({'slug'} <= cols or {'ticker_slug'} <= cols):
        if 'as_of_date' not in cols:
            return None, "looks like a prices export but has no 'as_of_date' column"
        p = pd.read_csv(path, encoding='utf-8-sig', usecols=lambda c: c in {
            'slug', 'ticker_slug', 'as_of_date', 'close', 'div_adj_factor'})
        p = p.rename(columns=PRICE_COLUMN_ALIASES)
        p['ticker'] = p['ticker'].astype(str).str.lower()
        p['as_of_date'] = pd.to_datetime(p['as_of_date'], utc=True).dt.tz_localize(None)
        p['adj_close'] = p['close'] * p['div_adj_factor']
        return 'prices', p[['ticker', 'as_of_date', 'adj_close']]

    if ({'newRating'} <= cols or {'new_rating'} <= cols) and \
            ({'createdAt'} <= cols or {'created_at'} <= cols):
        if not ({'slug'} <= cols or {'ticker_slug'} <= cols):
            return None, "looks like a ratings export but has no 'slug'/'ticker_slug' column"
        c = pd.read_csv(path, encoding='utf-8-sig', usecols=lambda col: col in {
            'slug', 'ticker_slug', 'createdAt', 'created_at',
            'newRating', 'new_rating', 'sectorDisplay', 'sector_display'})
        c = c.rename(columns=CHANGE_COLUMN_ALIASES)
        # Same exclusion the sqlite query applies inline: unrated and the
        # "-" placeholder are not ratings and must not enter the timeline.
        c = c[c['new_rating'].notna() & (c['new_rating'] != '-')]
        c['ticker'] = c['ticker'].astype(str).str.lower()
        c['created_at'] = pd.to_datetime(c['created_at'], utc=True).dt.tz_localize(None)
        if 'sector_display' not in c.columns:
            c['sector_display'] = pd.NA
        return 'changes', c[['ticker', 'created_at', 'new_rating', 'sector_display']]

    return None, f'no recognised price or rating columns (found: {", ".join(sorted(cols)[:12])})'


def load_price_and_rating_data(input_path):
    input_path = Path(input_path)
    files = [input_path] if input_path.is_file() else sorted(
        p for p in input_path.rglob('*') if p.is_file()
    )
    price_frames, change_frames = [], []
    skipped = []
    for f in files:
        if f.suffix.lower() in {'.csv', '.tsv'}:
            kind, frame_or_reason = _read_csv_export(f)
            if kind == 'prices':
                price_frames.append(frame_or_reason)
            elif kind == 'changes':
                change_frames.append(frame_or_reason)
            else:
                skipped.append(f'{f.name}: {frame_or_reason}')
            continue
        if f.suffix.lower() == '.json':
            kind, payload = _read_raw_json_export(f)
            if kind == 'raw':
                raw_prices, raw_changes = payload
                price_frames.append(raw_prices)
                if len(raw_changes):
                    change_frames.append(raw_changes)
            else:
                skipped.append(f'{f.name}: {payload}')
            continue
        try:
            con = sqlite3.connect(str(f))
            # Views count. The app's database exposes historical_prices and ticker_changes as
            # views over its normalised tables precisely so this loader keeps working unchanged.
            tables = [r[0] for r in con.execute(
                "select name from sqlite_master where type in ('table', 'view')")]
        except sqlite3.DatabaseError:
            continue
        if 'historical_prices' in tables:
            p = pd.read_sql(
                "SELECT ticker_slug, as_of_date, close, div_adj_factor FROM historical_prices", con)
            p['ticker'] = p['ticker_slug'].str.lower()
            p['as_of_date'] = pd.to_datetime(p['as_of_date'], utc=True).dt.tz_localize(None)
            p['adj_close'] = p['close'] * p['div_adj_factor']
            price_frames.append(p[['ticker', 'as_of_date', 'adj_close']])
        if 'ticker_changes' in tables:
            c = pd.read_sql(
                "SELECT ticker_slug, created_at, new_rating, sector_display FROM ticker_changes "
                "WHERE new_rating IS NOT NULL AND new_rating != '-'", con)
            c['ticker'] = c['ticker_slug'].str.lower()
            c['created_at'] = pd.to_datetime(c['created_at'], utc=True).dt.tz_localize(None)
            change_frames.append(c[['ticker', 'created_at', 'new_rating', 'sector_display']])
        con.close()
    if not price_frames:
        detail = ('\nFiles inspected but not used:\n  ' + '\n  '.join(skipped)) if skipped else \
            f'\n(no .csv/.tsv files found under {input_path.resolve()})'
        raise FileNotFoundError(
            f"No price data found under {input_path} — expected either a .sqlite/.db "
            f"file with a historical_prices table, or a .csv export with "
            f"slug/close/div_adj_factor/as_of_date columns.{detail}")
    prices = (pd.concat(price_frames, ignore_index=True)
                .drop_duplicates(subset=['ticker', 'as_of_date'])
                .sort_values(['ticker', 'as_of_date']).reset_index(drop=True))
    changes = (pd.concat(change_frames, ignore_index=True).drop_duplicates()
               if change_frames else pd.DataFrame(columns=['ticker', 'created_at', 'new_rating']))
    return prices, changes


def load_etf_tickers(input_path):
    """Read the canonical ETF classification from the same input as prices/ratings.

    The app's compatibility views intentionally contain only market rows; `fund_type` belongs to
    the underlying `tickers` table. JSON fallback reads the retained included-ticker metadata.
    """
    input_path = Path(input_path)
    files = [input_path] if input_path.is_file() else sorted(
        path for path in input_path.rglob('*') if path.is_file())
    etfs = set()
    for file_path in files:
        if file_path.suffix.lower() in {'.sqlite', '.db'}:
            try:
                con = sqlite3.connect(str(file_path))
                tables = {row[0] for row in con.execute(
                    "select name from sqlite_master where type='table'")}
                if 'tickers' in tables:
                    columns = {row[1] for row in con.execute('pragma table_info(tickers)')}
                    if 'fund_type' in columns:
                        etfs.update(str(row[0]).lower() for row in con.execute(
                            "select slug from tickers where upper(trim(fund_type)) = 'ETF'"))
                con.close()
            except sqlite3.DatabaseError:
                continue
        elif file_path.suffix.lower() == '.json':
            try:
                payload = json.loads(file_path.read_text(encoding='utf-8-sig'))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if not isinstance(payload, list):
                continue
            for wrapper in payload:
                if not isinstance(wrapper, dict):
                    continue
                slug = str(wrapper.get('_slug', '')).lower()
                included = ((wrapper.get('body') or {}).get('included') or [])
                ticker = next((item for item in included if item.get('type') == 'ticker'
                               and str((item.get('attributes') or {}).get('slug', '')).lower() == slug), None)
                fund_type = ((ticker or {}).get('attributes') or {}).get('fundType')
                if slug and str(fund_type).upper() == 'ETF':
                    etfs.add(slug)
    return etfs


def load_spy_series(source, symbol='SPY'):
    """Load the benchmark series from the database (preferred) or a CSV.

    The database holds real Yahoo adjusted closes, imported from the same
    folder as everything else. That is now the default because the
    reconstructed CSV this project used previously turned out to disagree with
    the real series on 15 of its 755 days -- by up to 5.95% on 2025-04-08 --
    which lands directly in the excess return of any trade entering or exiting
    on one of those dates. CSV loading is kept for dates the benchmark feed
    doesn't cover.
    """
    path = Path(source)
    if path.suffix.lower() in {'.sqlite', '.db'}:
        con = sqlite3.connect(str(path))
        try:
            frame = pd.read_sql(
                'SELECT as_of_date AS date, adj_close FROM benchmark_prices '
                'WHERE symbol = ? ORDER BY as_of_date', con, params=(symbol,))
        finally:
            con.close()
        if frame.empty:
            raise ValueError(f"No {symbol} rows in benchmark_prices — import the benchmark file first")
        frame['date'] = pd.to_datetime(frame['date'])
        return frame.set_index('date')['adj_close'].sort_index()

    spy = pd.read_csv(source, parse_dates=['date']).set_index('date')['adj_close']
    return spy.sort_index()


# ---------------------------------------------------------------
# 2. Rating timeline: forward-fill each rating-change event onto
#    that ticker's actual trading calendar.
# ---------------------------------------------------------------
def build_rating_timeline(prices, changes):
    changes = changes.copy()
    changes['tier'] = changes['new_rating'].map(TIER)
    changes = changes.dropna(subset=['tier']).sort_values(['ticker', 'created_at'])
    frames = []
    for tkr, gp in prices.groupby('ticker'):
        gc = changes[changes['ticker'] == tkr]
        if gc.empty:
            continue
        merged = pd.merge_asof(
            gp.sort_values('as_of_date'),
            gc[['created_at', 'tier']].sort_values('created_at'),
            left_on='as_of_date', right_on='created_at', direction='backward')
        merged['ticker'] = tkr
        frames.append(merged[['ticker', 'as_of_date', 'tier']])
    if not frames:
        return pd.DataFrame(columns=['ticker', 'as_of_date', 'tier'])
    tl = pd.concat(frames, ignore_index=True).dropna(subset=['tier'])
    tl['tier'] = tl['tier'].astype(int)
    return tl.sort_values(['ticker', 'as_of_date']).reset_index(drop=True)


# ---------------------------------------------------------------
# 3. Persistence screens: entry = first day a trailing window of
#    `window_td` trading days satisfies floor_fn with at most
#    dip_tol fraction of days below it. Exit = entry + hold_td
#    trading days (fixed horizon, ignores subsequent rating changes).
# ---------------------------------------------------------------
def entry_events(ticker_timeline, floor_fn, window_td, dip_tol):
    df = ticker_timeline.sort_values('as_of_date').reset_index(drop=True)
    ok = floor_fn(df['tier']).astype(int)
    roll_frac = ok.rolling(window_td, min_periods=window_td).mean()
    qualifies = roll_frac >= (1 - dip_tol)
    prev = qualifies.shift(1, fill_value=False)
    return df.loc[qualifies & ~prev, 'as_of_date']


def forward_bhar(ticker_prices_sorted, entry_date, hold_td, spy_series):
    sub = ticker_prices_sorted
    idx_arr = sub.index[sub['as_of_date'] == entry_date]
    if len(idx_arr) == 0:
        return None
    idx = idx_arr[0]
    exit_idx = idx + hold_td
    if exit_idx >= len(sub):
        return None  # would need look-ahead beyond available data -> excluded
    p0, p1 = sub.loc[idx, 'adj_close'], sub.loc[exit_idx, 'adj_close']
    exit_date = sub.loc[exit_idx, 'as_of_date']
    if p0 <= 0 or pd.isna(p0) or pd.isna(p1):
        return None
    if entry_date not in spy_series.index or exit_date not in spy_series.index:
        return None  # outside cached SPY range -> extend the cache, see README
    ret = p1 / p0 - 1
    spy_ret = spy_series.loc[exit_date] / spy_series.loc[entry_date] - 1
    return dict(entry=entry_date, exit=exit_date, ret=ret, spy_ret=spy_ret, bhar=ret - spy_ret)


def run_screen_grid(timeline, prices, spy_series,
                     lookbacks=LOOKBACKS_TD, holds=HOLDS_TD,
                     floors=FLOORS, dip_tols=DIP_TOLS):
    """Runs every (lookback x hold x floor x dip_tolerance) combination in
    the grid and returns one row per combination with its trade list."""
    by_ticker_px = {t: g.sort_values('as_of_date').reset_index(drop=True)
                     for t, g in prices.groupby('ticker')}
    records = []
    for lb_name, lb_td in lookbacks.items():
        for hold_name, hold_td in holds.items():
            for floor_name, floor_fn in floors.items():
                for dip_name, dip_tol in dip_tols.items():
                    trades = []
                    for tkr, gp in timeline.groupby('ticker'):
                        px = by_ticker_px.get(tkr)
                        if px is None:
                            continue
                        for ed in entry_events(gp, floor_fn, lb_td, dip_tol):
                            r = forward_bhar(px, ed, hold_td, spy_series)
                            if r:
                                trades.append(dict(ticker=tkr, **r))
                    tdf = pd.DataFrame(trades)
                    records.append(dict(lookback=lb_name, hold=hold_name, floor=floor_name,
                                         dip_tolerance=dip_name, trades=tdf))
    return records


# ---------------------------------------------------------------
# 3b. Bearish research families (see BEARISH_PRESPEC.md).
#
# These functions intentionally use next-session entry and calendar-day
# horizons.  They are not shared with forward_bhar(), whose same-day,
# trading-day convention belongs to the older bullish study.
# ---------------------------------------------------------------
def bearish_transition_events(ticker_timeline, signal_name):
    """Return dates on which a ticker newly enters one bearish state.

    The first known rating is excluded because a transition cannot be
    established without a prior observed rating.
    """
    df = ticker_timeline.sort_values('as_of_date').reset_index(drop=True)
    previous = df['tier'].shift(1)
    if signal_name == 'sell_or_strong_sell':
        qualifies = df['tier'].le(2) & previous.gt(2)
    elif signal_name == 'strong_sell_only':
        qualifies = df['tier'].eq(1) & previous.notna() & previous.ne(1)
    else:
        raise KeyError(f'Unknown bearish signal: {signal_name}')
    return df.loc[qualifies, 'as_of_date']


def bearish_persistence_events(ticker_timeline, signal_name, window_td):
    """Return the first date on which a strict bearish window is complete."""
    if signal_name not in BEARISH_SIGNALS:
        raise KeyError(f'Unknown bearish signal: {signal_name}')
    df = ticker_timeline.sort_values('as_of_date').reset_index(drop=True)
    qualifies_today = BEARISH_SIGNALS[signal_name](df['tier']).astype(int)
    qualifies = qualifies_today.rolling(window_td, min_periods=window_td).mean().eq(1.0)
    previous = qualifies.shift(1, fill_value=False)
    return df.loc[qualifies & ~previous, 'as_of_date']


def forward_short_trade(ticker_prices_sorted, signal_date, hold_days, spy_series):
    """Price one complete fixed-horizon short entered after a rating signal.

    Returns ``(trade, reason)``.  A missing trade is never replaced with the
    last available observation before the target date; this is the explicit
    guard against right-edge horizon truncation.
    """
    sub = ticker_prices_sorted
    signal_date = pd.Timestamp(signal_date)
    entry_candidates = sub.index[sub['as_of_date'] > signal_date]
    if len(entry_candidates) == 0:
        return None, 'no_next_session'
    entry_idx = entry_candidates[0]
    entry_date = pd.Timestamp(sub.loc[entry_idx, 'as_of_date'])
    target_date = entry_date + pd.Timedelta(days=hold_days)
    exit_candidates = sub.index[sub['as_of_date'] >= target_date]
    if len(exit_candidates) == 0:
        return None, 'incomplete_horizon'
    exit_idx = exit_candidates[0]
    exit_date = pd.Timestamp(sub.loc[exit_idx, 'as_of_date'])
    p0, p1 = sub.loc[entry_idx, 'adj_close'], sub.loc[exit_idx, 'adj_close']
    if p0 <= 0 or pd.isna(p0) or pd.isna(p1):
        return None, 'invalid_stock_price'
    if entry_date not in spy_series.index or exit_date not in spy_series.index:
        return None, 'missing_benchmark_price'

    stock_return = float(p1 / p0 - 1)
    spy_return = float(spy_series.loc[exit_date] / spy_series.loc[entry_date] - 1)
    return dict(
        signal=signal_date,
        entry=entry_date,
        exit=exit_date,
        stock_return=stock_return,
        spy_return=spy_return,
        raw_short_return=-stock_return,
        spy_hedged_short_return=spy_return - stock_return,
    ), None


def _collect_bearish_trades(timeline, by_ticker_px, spy_series, event_fn, hold_days):
    trades = []
    candidate_signals = 0
    incomplete_trades = 0
    overlap_skipped = 0
    drop_reasons = {}
    for ticker, ticker_timeline in timeline.groupby('ticker'):
        prices = by_ticker_px.get(ticker)
        if prices is None:
            continue
        active_until = None
        events = list(pd.to_datetime(event_fn(ticker_timeline)).sort_values())
        candidate_signals += len(events)
        for signal_date in events:
            # A signal on the prior trade's exit day can be entered next
            # session. A signal before that exit would create overlapping
            # exposure to the same ticker and is skipped.
            if active_until is not None and signal_date < active_until:
                overlap_skipped += 1
                continue
            trade, reason = forward_short_trade(prices, signal_date, hold_days, spy_series)
            if trade is None:
                incomplete_trades += 1
                drop_reasons[reason] = drop_reasons.get(reason, 0) + 1
                continue
            trades.append(dict(ticker=ticker, **trade))
            active_until = trade['exit']

    columns = [
        'ticker', 'signal', 'entry', 'exit', 'stock_return', 'spy_return',
        'raw_short_return', 'spy_hedged_short_return',
    ]
    return dict(
        trades=pd.DataFrame(trades, columns=columns),
        candidate_signals=candidate_signals,
        incomplete_trades=incomplete_trades,
        overlap_skipped=overlap_skipped,
        drop_reasons=drop_reasons,
    )


def run_bearish_transition_grid(timeline, prices, spy_series,
                                holds=BEARISH_HOLDS_DAYS,
                                signals=BEARISH_SIGNALS):
    """Run the 2 signal x 3 hold transition rule grid.

    Outcome columns are expanded into the 12-test correction family by the
    report runner.
    """
    by_ticker_px = {
        ticker: group.sort_values('as_of_date').reset_index(drop=True)
        for ticker, group in prices.groupby('ticker')
    }
    records = []
    for signal_name in signals:
        for hold_name, hold_days in holds.items():
            collected = _collect_bearish_trades(
                timeline, by_ticker_px, spy_series,
                lambda group, name=signal_name: bearish_transition_events(group, name),
                hold_days,
            )
            records.append(dict(
                family='transition', lookback=None, signal=signal_name,
                hold=hold_name, hold_days=hold_days, **collected,
            ))
    return records


def run_bearish_persistence_grid(timeline, prices, spy_series,
                                 lookbacks=BEARISH_LOOKBACKS_TD,
                                 holds=BEARISH_HOLDS_DAYS,
                                 signals=BEARISH_SIGNALS):
    """Run the 4 lookback x 2 signal x 3 hold persistence rule grid."""
    by_ticker_px = {
        ticker: group.sort_values('as_of_date').reset_index(drop=True)
        for ticker, group in prices.groupby('ticker')
    }
    records = []
    for lookback_name, lookback_td in lookbacks.items():
        for signal_name in signals:
            for hold_name, hold_days in holds.items():
                collected = _collect_bearish_trades(
                    timeline, by_ticker_px, spy_series,
                    lambda group, name=signal_name, window=lookback_td:
                        bearish_persistence_events(group, name, window),
                    hold_days,
                )
                records.append(dict(
                    family='persistence', lookback=lookback_name,
                    lookback_td=lookback_td, signal=signal_name,
                    hold=hold_name, hold_days=hold_days, **collected,
                ))
    return records


# ---------------------------------------------------------------
# 3c. ETF rating-trust and persistence families (ETF_PRESPEC.md).
# ---------------------------------------------------------------
def etf_rating_transition_events(ticker_timeline, filter_name):
    """First observed transition into one bullish rating family.

    The first row is deliberately excluded: without a prior observed rating it is a left-censored
    state, not evidence that the ETF newly became bullish on that date.
    """
    frame = ticker_timeline.sort_values('as_of_date').reset_index(drop=True)
    qualifies = ETF_FILTERS[filter_name](frame['tier'])
    prior = qualifies.shift(1)
    return frame.loc[qualifies & prior.notna() & ~prior.astype(bool), 'as_of_date']


def etf_persistence_events(ticker_timeline, filter_name, persistence_days):
    """First date each continuous bullish episode reaches a calendar-day age."""
    frame = ticker_timeline.sort_values('as_of_date').reset_index(drop=True)
    qualifies = ETF_FILTERS[filter_name](frame['tier']).to_numpy(dtype=bool)
    dates = pd.to_datetime(frame['as_of_date']).to_numpy()
    events = []
    episode_start = None
    emitted = False
    for index, is_qualified in enumerate(qualifies):
        if not is_qualified:
            episode_start = None
            emitted = False
            continue
        if episode_start is None:
            episode_start = pd.Timestamp(dates[index])
        if not emitted and (pd.Timestamp(dates[index]) - episode_start).days >= persistence_days:
            events.append(pd.Timestamp(dates[index]))
            emitted = True
    return pd.Series(events, dtype='datetime64[ns]')


def forward_etf_trade(ticker_prices_sorted, signal_date, hold_days, spy_series,
                      tolerance_days=ETF_EXIT_TOLERANCE_DAYS):
    """Price one ETF trade with next-session entry and a bounded calendar-day exit."""
    prices = ticker_prices_sorted.sort_values('as_of_date').reset_index(drop=True)
    signal_date = pd.Timestamp(signal_date)
    entry_candidates = prices.index[prices['as_of_date'] > signal_date]
    if len(entry_candidates) == 0:
        return None, 'no_next_session'
    entry_index = int(entry_candidates[0])
    entry_date = pd.Timestamp(prices.loc[entry_index, 'as_of_date'])
    target_date = entry_date + pd.Timedelta(days=hold_days)
    candidate = prices[
        (prices['as_of_date'] > entry_date)
        & (prices['as_of_date'] >= target_date - pd.Timedelta(days=tolerance_days))
        & (prices['as_of_date'] <= target_date + pd.Timedelta(days=tolerance_days))
    ].copy()
    if candidate.empty:
        return None, 'incomplete_horizon'
    candidate['distance'] = (candidate['as_of_date'] - target_date).abs()
    exit_row = candidate.sort_values(['distance', 'as_of_date']).iloc[0]
    exit_date = pd.Timestamp(exit_row['as_of_date'])
    entry_price = prices.loc[entry_index, 'adj_close']
    exit_price = exit_row['adj_close']
    if (pd.isna(entry_price) or pd.isna(exit_price)
            or not np.isfinite(float(entry_price))
            or not np.isfinite(float(exit_price))
            or entry_price <= 0 or exit_price <= 0):
        return None, 'invalid_etf_price'
    if entry_date not in spy_series.index or exit_date not in spy_series.index:
        return None, 'missing_benchmark_price'
    etf_return = float(exit_price / entry_price - 1)
    spy_return = float(spy_series.loc[exit_date] / spy_series.loc[entry_date] - 1)
    return dict(
        signal=signal_date, entry=entry_date, exit=exit_date,
        entry_price=float(entry_price), exit_price=float(exit_price),
        spy_entry_price=float(spy_series.loc[entry_date]),
        spy_exit_price=float(spy_series.loc[exit_date]),
        ret=etf_return, spy_ret=spy_return, bhar=etf_return - spy_return,
    ), None


def _etf_validation_bounds(prices):
    validation_end = pd.Timestamp(prices['as_of_date'].max())
    return validation_end - pd.Timedelta(days=ETF_VALIDATION_DAYS), validation_end


def _tier_at_or_before(ticker_timeline, date):
    frame = ticker_timeline
    eligible = frame[frame['as_of_date'] <= pd.Timestamp(date)]
    return None if eligible.empty else int(eligible.iloc[-1]['tier'])


def _etf_returns_for_signal(signal_date, filter_name, hold_days, timelines, prices_by_ticker,
                            spy_series, cache):
    """All qualifying ETF returns on one date, cached across persistence cells."""
    key = (pd.Timestamp(signal_date), filter_name, hold_days)
    if key in cache:
        return cache[key]
    returns = {}
    for ticker, ticker_timeline in timelines.items():
        if filter_name is not None:
            tier = _tier_at_or_before(ticker_timeline, signal_date)
            if tier is None or not bool(ETF_FILTERS[filter_name](tier)):
                continue
        priced, _reason = forward_etf_trade(
            prices_by_ticker[ticker], signal_date, hold_days, spy_series)
        if priced is not None:
            returns[ticker] = priced
    cache[key] = returns
    return returns


def _collect_etf_trades(timeline, prices, spy_series, event_factory, hold_days,
                        filter_name, include_pool=False, pool_cache=None):
    prices_by_ticker = {
        ticker: group.sort_values('as_of_date').reset_index(drop=True)
        for ticker, group in prices.groupby('ticker')
    }
    timelines = {
        ticker: group.sort_values('as_of_date').reset_index(drop=True)
        for ticker, group in timeline.groupby('ticker')
    }
    validation_start, validation_end = _etf_validation_bounds(prices)
    trades = []
    candidate_signals = 0
    drop_reasons = {}
    pool_cache = pool_cache if pool_cache is not None else {}
    for ticker, ticker_timeline in timelines.items():
        ticker_prices = prices_by_ticker.get(ticker)
        if ticker_prices is None:
            continue
        events = [pd.Timestamp(date) for date in event_factory(ticker_timeline)
                  if validation_start <= pd.Timestamp(date) <= validation_end]
        candidate_signals += len(events)
        for signal_date in events:
            priced, reason = forward_etf_trade(ticker_prices, signal_date, hold_days, spy_series)
            if priced is None:
                drop_reasons[reason] = drop_reasons.get(reason, 0) + 1
                continue
            trade = dict(ticker=ticker, filter=filter_name, hold_days=hold_days, **priced)
            if include_pool:
                pool_returns = _etf_returns_for_signal(
                    signal_date, filter_name, hold_days, timelines, prices_by_ticker,
                    spy_series, pool_cache)
                peers = [value['ret'] for peer, value in pool_returns.items() if peer != ticker]
                if not peers:
                    drop_reasons['missing_bullish_pool'] = drop_reasons.get('missing_bullish_pool', 0) + 1
                    continue
                trade['pool_ret'] = float(np.mean(peers))
                trade['excess_pool'] = trade['ret'] - trade['pool_ret']
            trades.append(trade)
    columns = ['ticker', 'filter', 'hold_days', 'signal', 'entry', 'exit',
               'entry_price', 'exit_price', 'spy_entry_price', 'spy_exit_price',
               'ret', 'spy_ret', 'bhar']
    if include_pool:
        columns += ['pool_ret', 'excess_pool']
    return dict(
        trades=pd.DataFrame(trades, columns=columns),
        candidate_signals=candidate_signals,
        incomplete_trades=sum(drop_reasons.values()),
        drop_reasons=drop_reasons,
        validation_start=validation_start,
        validation_end=validation_end,
    )


def run_etf_rating_trust_grid(timeline, prices, spy_series,
                              filters=ETF_FILTERS, holds=ETF_HOLDS_DAYS):
    """Run the six-cell primary family: bullish rating transitions versus SPY."""
    records = []
    for filter_name in filters:
        for hold_name, hold_days in holds.items():
            collected = _collect_etf_trades(
                timeline, prices, spy_series,
                lambda group, name=filter_name: etf_rating_transition_events(group, name),
                hold_days, filter_name, include_pool=False)
            records.append(dict(
                family='rating_trust', filter=filter_name, persistence=None,
                hold=hold_name, hold_days=hold_days, outcome_column='bhar', **collected))
    return records


def run_etf_persistence_grid(timeline, prices, spy_series,
                             filters=ETF_FILTERS, persistence=ETF_PERSISTENCE_DAYS,
                             holds=ETF_HOLDS_DAYS, progress=None):
    """Run the 24-cell secondary family: persistence edge over matching bullish ETFs."""
    records = []
    pool_cache = {}
    total = len(filters) * len(persistence) * len(holds)
    completed = 0
    for filter_name in filters:
        for persistence_name, persistence_days in persistence.items():
            for hold_name, hold_days in holds.items():
                if progress:
                    progress(f"test {completed + 1}/{total}: {filter_name}, {persistence_name}, {hold_name}")
                collected = _collect_etf_trades(
                    timeline, prices, spy_series,
                    lambda group, name=filter_name, days=persistence_days:
                        etf_persistence_events(group, name, days),
                    hold_days, filter_name, include_pool=True, pool_cache=pool_cache)
                records.append(dict(
                    family='persistence', filter=filter_name,
                    persistence=persistence_name, persistence_days=persistence_days,
                    hold=hold_name, hold_days=hold_days,
                    outcome_column='excess_pool', **collected))
                completed += 1
                if progress:
                    progress(f"completed {completed}/{total} tests")
    return records


def etf_placebo_test(cell, prices, timeline, spy_series, n_sim=2000, seed=7, progress=None):
    """Random-ETF same-date control for either frozen ETF family."""
    trades = cell['trades']
    if trades.empty:
        return dict(observed_mean=np.nan, random_median=np.nan, random_p5=np.nan,
                    random_p95=np.nan, empirical_p=np.nan, simulations=0)
    prices_by_ticker = {
        ticker: group.sort_values('as_of_date').reset_index(drop=True)
        for ticker, group in prices.groupby('ticker')
    }
    timelines = {
        ticker: group.sort_values('as_of_date').reset_index(drop=True)
        for ticker, group in timeline.groupby('ticker')
    }
    options_cache = {}
    case_options = []
    for trade in trades.itertuples(index=False):
        placebo_filter = None if cell['family'] == 'rating_trust' else cell['filter']
        options = _etf_returns_for_signal(
            trade.signal, placebo_filter, cell['hold_days'], timelines,
            prices_by_ticker, spy_series, options_cache)
        if cell['family'] == 'rating_trust':
            values = [value['bhar'] for ticker, value in options.items() if ticker != trade.ticker]
        else:
            # The real signal ETF cannot be the placebo candidate, but it must
            # remain available as a peer.  Excluding it before this loop would
            # give every placebo candidate a different (and artificially
            # smaller) comparison pool than the observed trade.
            raw = {ticker: value['ret'] for ticker, value in options.items()}
            values = []
            for candidate, candidate_return in raw.items():
                if candidate == trade.ticker:
                    continue
                peers = [value for ticker, value in raw.items() if ticker != candidate]
                if peers:
                    values.append(candidate_return - float(np.mean(peers)))
        if values:
            case_options.append(np.asarray(values, dtype=float))
    observed_mean = float(trades[cell['outcome_column']].mean())
    if not case_options:
        return dict(observed_mean=observed_mean, random_median=np.nan, random_p5=np.nan,
                    random_p95=np.nan, empirical_p=np.nan, simulations=0)
    rng = np.random.default_rng(seed)
    simulation_means = np.empty(n_sim)
    for simulation in range(n_sim):
        simulation_means[simulation] = np.mean([
            values[rng.integers(len(values))] for values in case_options
        ])
        if progress and (simulation + 1) % 250 == 0:
            progress(f"placebo simulation {simulation + 1}/{n_sim}")
    return dict(
        observed_mean=observed_mean,
        random_median=float(np.median(simulation_means)),
        random_p5=float(np.percentile(simulation_means, 5)),
        random_p95=float(np.percentile(simulation_means, 95)),
        empirical_p=float((np.sum(simulation_means >= observed_mean) + 1) / (len(simulation_means) + 1)),
        simulations=int(len(simulation_means)),
    )


# ---------------------------------------------------------------
# 4. Cluster-robust wild bootstrap-t (Cameron-Gelbach-Miller 2008
#    style, Rademacher weights) for H0: mean(value) = 0, clustered
#    by ticker. Same test used throughout the chat analysis.
# ---------------------------------------------------------------
def wild_cluster_bootstrap_t(values, clusters, B=B_BOOT, seed=12345):
    y = np.asarray(values, dtype=float)
    N = len(y)
    uniq = np.unique(clusters)
    G = len(uniq)
    if G < 2 or N < 3:
        return dict(mean=np.nan, t=np.nan, p=np.nan, n=N, g=G)
    cmap = {c: i for i, c in enumerate(uniq)}
    idx = np.array([cmap[c] for c in clusters])

    def crve_t(y_):
        m = y_.mean()
        u = y_ - m
        sums = np.bincount(idx, weights=u, minlength=G)
        var = (G / (G - 1)) * np.sum(sums ** 2) / (N ** 2)
        se = np.sqrt(var) if var > 0 else np.nan
        t = m / se if se and se > 0 else np.nan
        return m, t

    mean_hat, t_orig = crve_t(y)
    rng = np.random.default_rng(seed)
    t_boot = np.empty(B)
    for b in range(B):
        w = rng.choice(np.array([-1.0, 1.0]), size=G)
        _, t_b = crve_t(y * w[idx])
        t_boot[b] = t_b
    valid = np.isfinite(t_boot)
    p = (np.sum(np.abs(t_boot[valid]) >= np.abs(t_orig)) + 1) / (valid.sum() + 1)
    return dict(mean=mean_hat, t=t_orig, p=p, n=N, g=G)


def cluster_bootstrap_ci(values, clusters, B=2000, seed=99, level=0.90):
    """Percentile CI for the mean, resampling whole tickers with replacement.

    Descriptive only — the discovery bar is still the wild bootstrap-t above,
    and nothing here feeds it. This exists so a dollar figure can be shown
    with the range it's actually pinned down to, rather than as a point
    estimate that looks more precise than it is. Clustered by ticker for the
    same reason everything else is: two trades in one name aren't two
    independent observations.
    """
    y = np.asarray(values, dtype=float)
    uniq = np.unique(clusters)
    G = len(uniq)
    if G < 2 or len(y) < 3:
        return (np.nan, np.nan)
    by_cluster = {c: y[np.asarray(clusters) == c] for c in uniq}
    rng = np.random.default_rng(seed)
    means = np.empty(B)
    for b in range(B):
        picks = rng.integers(0, G, size=G)
        sample = np.concatenate([by_cluster[uniq[i]] for i in picks])
        means[b] = sample.mean() if len(sample) else np.nan
    means = means[np.isfinite(means)]
    if not len(means):
        return (np.nan, np.nan)
    tail = (1 - level) / 2 * 100
    return (float(np.percentile(means, tail)), float(np.percentile(means, 100 - tail)))


def trade_outcomes(trades_df):
    """Plain-language summary of one cut: what an average trade actually did,
    in raw and benchmark terms, rather than only as an excess-return t-stat."""
    if not len(trades_df):
        return dict(mean_ret=np.nan, median_ret=np.nan, mean_spy_ret=np.nan,
                    win_rate_vs_spy=np.nan, win_rate_absolute=np.nan)
    return dict(
        mean_ret=float(trades_df['ret'].mean()),
        median_ret=float(trades_df['ret'].median()),
        mean_spy_ret=float(trades_df['spy_ret'].mean()),
        win_rate_vs_spy=float((trades_df['bhar'] > 0).mean()),
        win_rate_absolute=float((trades_df['ret'] > 0).mean()),
    )


def bearish_trade_outcomes(trades_df, outcome_column):
    """Plain-language outcome fields shared by both bearish families."""
    if not len(trades_df):
        return dict(
            median=np.nan, positive_rate=np.nan, stock_fell_rate=np.nan,
            underperformed_spy_rate=np.nan,
        )
    return dict(
        median=float(trades_df[outcome_column].median()),
        positive_rate=float((trades_df[outcome_column] > 0).mean()),
        stock_fell_rate=float((trades_df['stock_return'] < 0).mean()),
        underperformed_spy_rate=float(
            (trades_df['spy_hedged_short_return'] > 0).mean()),
    )


def holm_bh(pvals):
    pvals = np.asarray(pvals, dtype=float)
    n = len(pvals)
    order = np.argsort(pvals)
    holm = np.empty(n)
    running_max = 0
    for rank, i in enumerate(order):
        val = (n - rank) * pvals[i]
        running_max = max(running_max, val)
        holm[i] = min(running_max, 1.0)
    order_desc = order[::-1]
    bh = np.empty(n)
    running_min = 1.0
    for rank, i in enumerate(order_desc):
        k = n - rank
        val = pvals[i] * n / k
        running_min = min(running_min, val)
        bh[i] = min(running_min, 1.0)
    return holm, bh


# ---------------------------------------------------------------
# 5. Diagnostics: concentration check (is the mean a few outliers?)
#    and placebo test (would random tickers on the same dates do
#    as well? isolates selection value from period/universe tailwind).
# ---------------------------------------------------------------
def concentration_check(trades_df, top_ks=(1, 2, 3, 5, 8)):
    d = trades_df.sort_values('bhar', ascending=False).reset_index(drop=True)
    total = d['bhar'].sum()
    out = []
    for k in top_ks:
        if k >= len(d):
            break
        out.append(dict(top_k=k,
                         pct_of_total_bhar=100 * d['bhar'].iloc[:k].sum() / total if total else np.nan,
                         mean_bhar_excl=d['bhar'].iloc[k:].mean()))
    return pd.DataFrame(out)


def bearish_concentration_check(trades_df, outcome_column, top_ks=(1, 2, 3, 5, 8)):
    """Show whether a bearish result is carried by a few extreme trades.

    For a negative mean, the most negative observations are the ones carrying
    the result, so the sort direction is reversed. This keeps "percent of
    total" meaningful for evidence both for and against a short rule.
    """
    if not len(trades_df):
        return pd.DataFrame(columns=['top_k', 'pct_of_total_outcome', 'mean_outcome_excl'])
    ascending = trades_df[outcome_column].mean() < 0
    data = trades_df.sort_values(outcome_column, ascending=ascending).reset_index(drop=True)
    total = data[outcome_column].sum()
    rows = []
    for top_k in top_ks:
        if top_k >= len(data):
            break
        rows.append(dict(
            top_k=top_k,
            pct_of_total_outcome=(
                100 * data[outcome_column].iloc[:top_k].sum() / total
                if total else np.nan
            ),
            mean_outcome_excl=data[outcome_column].iloc[top_k:].mean(),
        ))
    return pd.DataFrame(rows)


def _exact_stock_return(price_lookup, entry_date, exit_date):
    p0 = price_lookup.get(entry_date)
    p1 = price_lookup.get(exit_date)
    if p0 is None or p1 is None:
        return None
    if p0 <= 0 or pd.isna(p0) or pd.isna(p1):
        return None
    return float(p1 / p0 - 1)


def bearish_placebo_test(trades_df, universe_prices, outcome_column,
                         n_sim=2000, seed=7):
    """Random-ticker control using each observed trade's exact dates.

    The two-sided empirical p-value is twice the smaller random-tail share,
    capped at one. It asks whether the observed mean is unusually high or low
    relative to random names exposed over the same market periods.
    """
    if not len(trades_df):
        return dict(
            outcome=outcome_column, observed_mean=np.nan, random_median=np.nan,
            random_p5=np.nan, random_p95=np.nan, empirical_p=np.nan,
            simulations=0,
        )
    by_ticker = {
        ticker: dict(zip(group['as_of_date'], group['adj_close']))
        for ticker, group in universe_prices.groupby('ticker')
    }
    periods = list(trades_df[['entry', 'exit', 'spy_return']].itertuples(index=False, name=None))
    # Build the available random-stock returns once per distinct date pair.
    # The previous implementation filtered a DataFrame for every random draw,
    # turning a few million cheap samples into a multi-minute table scan.
    returns_by_period = {}
    for entry_date, exit_date, _spy_return in periods:
        key = (entry_date, exit_date)
        if key in returns_by_period:
            continue
        returns_by_period[key] = np.asarray([
            stock_return
            for lookup in by_ticker.values()
            for stock_return in [_exact_stock_return(lookup, entry_date, exit_date)]
            if stock_return is not None
        ], dtype=float)
    observed_mean = float(trades_df[outcome_column].mean())
    rng = np.random.default_rng(seed)
    sim_means = np.empty(n_sim)
    for simulation in range(n_sim):
        values = []
        for entry_date, exit_date, spy_return in periods:
            choices = returns_by_period[(entry_date, exit_date)]
            if not len(choices):
                continue
            stock_return = choices[rng.integers(len(choices))]
            values.append(
                -stock_return if outcome_column == 'raw_short_return'
                else float(spy_return) - stock_return
            )
        sim_means[simulation] = np.mean(values) if values else np.nan
    sim_means = sim_means[np.isfinite(sim_means)]
    if not len(sim_means):
        return dict(
            outcome=outcome_column, observed_mean=observed_mean,
            random_median=np.nan, random_p5=np.nan, random_p95=np.nan,
            empirical_p=np.nan, simulations=0,
        )
    upper = (np.sum(sim_means >= observed_mean) + 1) / (len(sim_means) + 1)
    lower = (np.sum(sim_means <= observed_mean) + 1) / (len(sim_means) + 1)
    return dict(
        outcome=outcome_column,
        observed_mean=observed_mean,
        random_median=float(np.median(sim_means)),
        random_p5=float(np.percentile(sim_means, 5)),
        random_p95=float(np.percentile(sim_means, 95)),
        empirical_p=float(min(1.0, 2 * min(upper, lower))),
        simulations=int(len(sim_means)),
    )


def universe_end_audit(prices, stale_days=30):
    """Describe end-date coverage without claiming it proves provider policy."""
    global_end = pd.Timestamp(prices['as_of_date'].max())
    ends = prices.groupby('ticker')['as_of_date'].max().sort_values()
    cutoff = global_end - pd.Timedelta(days=stale_days)
    early = ends[ends < cutoff]
    likely_fixtures = [
        str(ticker) for ticker in early.index
        if 'test' in str(ticker).lower() or str(ticker).lower().startswith('zz')
    ]
    return dict(
        global_end=str(global_end.date()),
        stale_days=stale_days,
        tickers_total=int(len(ends)),
        early_end_count=int(len(early)),
        early_end_tickers=[
            {'ticker': str(ticker), 'last_date': str(pd.Timestamp(last_date).date())}
            for ticker, last_date in early.items()
        ],
        likely_fixture_tickers=likely_fixtures,
        real_early_end_count=int(len(early) - len(likely_fixtures)),
    )


def placebo_test(trades_df, universe_prices, spy_series, hold_td, n_sim=5000, seed=7):
    universe = sorted(universe_prices['ticker'].unique())
    by_ticker = {t: g.sort_values('as_of_date').reset_index(drop=True)
                  for t, g in universe_prices.groupby('ticker')}
    entry_dates = trades_df['entry'].tolist()
    observed_mean = trades_df['bhar'].mean()
    rng = np.random.default_rng(seed)
    sim_means = np.empty(n_sim)
    for s in range(n_sim):
        vals = []
        for ed in entry_dates:
            for _ in range(10):
                tkr = universe[rng.integers(len(universe))]
                sub = by_ticker.get(tkr)
                if sub is None:
                    continue
                r = forward_bhar(sub, ed, hold_td, spy_series)
                if r is not None:
                    vals.append(r['bhar'])
                    break
        sim_means[s] = np.mean(vals) if vals else np.nan
    sim_means = sim_means[~np.isnan(sim_means)]
    return dict(observed_mean=observed_mean,
                random_median=np.median(sim_means),
                random_p5=np.percentile(sim_means, 5),
                random_p95=np.percentile(sim_means, 95),
                empirical_p=(sim_means >= observed_mean).mean())
