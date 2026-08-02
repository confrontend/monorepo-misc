"""
Stooq client -- free, no-API-key daily OHLCV price history, used as the
price-history source for live ingestion INSTEAD of Alpha Vantage.

Why this exists: Alpha Vantage's free tier turned out to be unusable for
price_signals specifically. TIME_SERIES_DAILY_ADJUSTED is premium-only
(confirmed live), and so -- less obviously, and confirmed live only after an
initial ingestion attempt failed -- is outputsize='full' on the plain
TIME_SERIES_DAILY endpoint. The free 'compact' size caps at ~100 sessions,
under required_inputs.py's MIN_PRICE_HISTORY_TRADING_DAYS=200, so ma_200 (and
therefore price_signals / the Market score) could never be computed from
Alpha Vantage on a free key at all. Stooq's daily-history CSV download has no
such gate and needs no API key. Alpha Vantage (src/ingestion/alpha_vantage.py)
is still used for earnings/estimates/calendar, which DO work on its free tier.

CAUTION: this environment's sandbox could not reach stooq.com to verify the
real CSV response shape live (same network restriction that blocked
apirest.danelfin.com -- see danelfin.py). The shape below (columns
Date,Open,High,Low,Close,Volume; a plain "No data" body for an unknown
symbol/exchange suffix) is Stooq's well-documented, widely-used public
format, not independently re-verified here. If real usage shows a different
shape, this is the one place to fix it -- get_daily() parses defensively and
raises a clear error (rather than silently returning wrong/empty data) if the
response doesn't look like the expected CSV.
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime
from typing import Optional

import requests

BASE_URL = "https://stooq.com/q/d/l/"
DEFAULT_HEADERS = {
    # Stooq may return an HTML 404-like response to requests' default
    # user-agent even when the symbol is valid. Identify this client like a
    # normal browser request; no credentials are involved.
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept": "text/csv,text/plain;q=0.9,*/*;q=0.8",
}


class StooqClient:
    def __init__(self, session: Optional[requests.Session] = None):
        self.session = session or requests.Session()
        # Do not mutate injected test/fake sessions; real requests sessions
        # expose headers and are safe to configure here.
        if session is None:
            self.session.headers.update(DEFAULT_HEADERS)

    def get_daily(self, ticker: str, outputsize: str = "full") -> dict[date, dict]:
        """Returns {date: {open, high, low, close, volume}} for `ticker`,
        full available daily history, no API key needed. `outputsize` is
        accepted (and ignored) only so this has the same call signature as
        AlphaVantageClient.get_daily() and either can be passed as
        `ingest_price_and_earnings`'s `price_client` -- Stooq always returns
        full history, there's no 'compact' concept to opt out of.

        US-listed tickers need Stooq's exchange suffix (e.g. "ATI" ->
        "ati.us"), applied here automatically for a bare ticker; pass
        `ticker` already suffixed (e.g. "ati.us") if you need a non-US
        listing."""
        symbol = ticker if "." in ticker else f"{ticker.lower()}.us"
        resp = self.session.get(BASE_URL, params={"s": symbol, "i": "d"}, timeout=30)
        try:
            resp.raise_for_status()
        except requests.HTTPError as exc:
            raise RuntimeError(
                f"Stooq request failed for symbol '{symbol}' with HTTP {resp.status_code}. "
                "The symbol may be unavailable, or Stooq may have rejected the request."
            ) from exc
        text = resp.text

        if not text.strip() or text.strip().lower().startswith("no data"):
            raise RuntimeError(f"Stooq returned no data for symbol '{symbol}' (ticker '{ticker}')")

        reader = csv.DictReader(io.StringIO(text))
        if reader.fieldnames is None or "Date" not in reader.fieldnames or "Close" not in reader.fieldnames:
            raise RuntimeError(
                f"Stooq response for '{symbol}' didn't look like the expected CSV "
                f"(Date,Open,High,Low,Close,Volume) -- got fields {reader.fieldnames!r}. "
                "This client's parsing may be out of date; see the module docstring."
            )

        out: dict[date, dict] = {}
        for row in reader:
            try:
                d = datetime.strptime(row["Date"], "%Y-%m-%d").date()
                out[d] = {
                    "open": float(row["Open"]),
                    "high": float(row["High"]),
                    "low": float(row["Low"]),
                    "close": float(row["Close"]),
                    "volume": float(row["Volume"]),
                }
            except (KeyError, ValueError):
                # Skip an individual malformed row rather than failing the
                # whole fetch -- Stooq's CSV is otherwise unstructured text
                # we don't control.
                continue
        return out
