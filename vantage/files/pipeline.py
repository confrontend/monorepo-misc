"""
Seeking Alpha Quant Rating reliability pipeline — reusable analysis engine.

Design principle: the fragile/expensive step (getting a trustworthy SPY
benchmark) is done ONCE and cached to spy_series_*.csv. Everything else
(new tickers, new rating events, new screens) reads that cache instead of
rebuilding it, so re-running after adding data is fast and doesn't touch
the network.

See README.md for usage and how to point this at new data.
"""
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


# ---------------------------------------------------------------
# 1. Data ingestion — auto-detects any .sqlite/.db under input_path
#    (file or directory) with historical_prices / ticker_changes
#    tables, and merges however many you drop in. Add new tickers
#    or new history by adding another file to the folder — nothing
#    else changes.
# ---------------------------------------------------------------
def load_price_and_rating_data(input_path):
    input_path = Path(input_path)
    files = [input_path] if input_path.is_file() else sorted(
        p for p in input_path.rglob('*') if p.is_file()
    )
    price_frames, change_frames = [], []
    for f in files:
        try:
            con = sqlite3.connect(str(f))
            tables = [r[0] for r in con.execute(
                "select name from sqlite_master where type='table'")]
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
        raise FileNotFoundError(f"No historical_prices table found under {input_path}")
    prices = (pd.concat(price_frames, ignore_index=True)
                .drop_duplicates(subset=['ticker', 'as_of_date'])
                .sort_values(['ticker', 'as_of_date']).reset_index(drop=True))
    changes = (pd.concat(change_frames, ignore_index=True).drop_duplicates()
               if change_frames else pd.DataFrame(columns=['ticker', 'created_at', 'new_rating']))
    return prices, changes


def load_spy_series(spy_csv_path):
    """Load the cached SPY series. Only needs rebuilding if you extend the
    date range beyond what's already cached (see README)."""
    spy = pd.read_csv(spy_csv_path, parse_dates=['date']).set_index('date')['adj_close']
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
