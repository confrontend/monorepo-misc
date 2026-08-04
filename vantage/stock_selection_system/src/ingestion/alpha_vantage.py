"""
Alpha Vantage client for EPS/estimates/earnings history and OHLCV price data
(the "Alpha Vantage for EPS/estimates/earnings history" data source named in
the implementation prompt's scope section).

Requires ALPHA_VANTAGE_API_KEY in the environment. Field availability below
was verified live against a real free-tier key (see src/ingestion/live.py
for the orchestration that consumes it):
  - TIME_SERIES_DAILY_ADJUSTED is PREMIUM-ONLY on the free tier (confirmed:
    returns {"Information": "...premium endpoint..."}).
  - TIME_SERIES_DAILY (unadjusted) itself works on the free tier, BUT
    outputsize='full' is ALSO confirmed premium-only on this endpoint
    (returns {"Information": "...outputsize=full parameter value is a
    premium feature for the TIME_SERIES_DAILY endpoint..."}) -- this was
    NOT caught by earlier testing, which only exercised the default
    'compact' outputsize. 'compact' returns only the ~100 most recent
    sessions, which is under required_inputs.py's
    MIN_PRICE_HISTORY_TRADING_DAYS=200. Net effect: on a free key, this
    client cannot supply enough daily history to compute ma_200 (or
    therefore price_signals / the Market score) at all -- see the "Live
    ingestion" section of README.md for what this means and the options
    going forward (a premium key, or sourcing price history from elsewhere
    and keeping this client for earnings/estimates/calendar only).
  - EARNINGS_ESTIMATES works on the free tier and, usefully, already
    includes eps_estimate_average_{7,30,60,90}_days_ago per fiscal period --
    no need to accumulate daily snapshots for 30 days before the Earnings
    score's "estimate rose/fell" signal becomes available.
  - EARNINGS_CALENDAR works but returns CSV, not JSON -- get_earnings_calendar()
    parses it separately from _get(). When rate-limited/erroring it falls
    back to a JSON body instead of CSV, which is detected and raised rather
    than fed into the CSV parser (see get_earnings_calendar()'s docstring).
  - Every free-tier error/rate-limit/premium-upsell response uses a top-level
    "Information" key (not just "Error Message"/"Note") -- _get() checks for
    all three; missing "Information" here previously meant a rate-limited or
    premium-gated call silently looked identical to "no data available."
Per spec Section 14, rate limits (free tier: 25 requests/day, 5/minute) still
matter for a multi-ticker watchlist run -- a single ingest_price_and_earnings()
call already uses up to 5 requests per ticker (4 + a shared SPY fetch), fired
back-to-back with no throttling, so a handful of tickers in one run can burn
most of a day's quota.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import time
from datetime import date, datetime
from typing import Optional

import requests
from dotenv import load_dotenv

load_dotenv()  # picks up ALPHA_VANTAGE_API_KEY from a .env file if present;
                # a real exported environment variable always takes precedence
                # since load_dotenv() does not override existing env vars.

BASE_URL = "https://www.alphavantage.co/query"


def _redact_error_text(value: object) -> object:
    if not isinstance(value, str):
        return value
    value = re.sub(r"(?i)(api_token|apikey|api_key|authorization)=([^&\s]+)", r"\1=***REDACTED***", value)
    return re.sub(r"(?i)(api\s+key(?:\s+as)?\s*[:=]?\s+)([A-Za-z0-9_-]{8,})", r"\1***REDACTED***", value)


class AlphaVantageClient:
    def __init__(self, api_key: Optional[str] = None, session: Optional[requests.Session] = None):
        self.api_key = api_key or os.environ.get("ALPHA_VANTAGE_API_KEY")
        if not self.api_key:
            raise RuntimeError(
                "ALPHA_VANTAGE_API_KEY is not set. Export it in the environment or pass "
                "api_key= explicitly before using AlphaVantageClient."
            )
        self.session = session or requests.Session()
        self._last_request_at = 0.0
        self.min_request_interval_seconds = 1.1

    def _wait_for_rate_limit(self) -> None:
        elapsed = time.monotonic() - self._last_request_at
        delay = self.min_request_interval_seconds - elapsed
        if delay > 0:
            time.sleep(delay)
        self._last_request_at = time.monotonic()

    def _get(self, params: dict) -> dict:
        params = {**params, "apikey": self.api_key}
        self._wait_for_rate_limit()
        resp = self.session.get(BASE_URL, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if "Error Message" in data or "Note" in data or "Information" in data:
            # "Information" is Alpha Vantage's key for BOTH premium-upsell
            # messages (e.g. "outputsize=full is a premium feature") and
            # rate-limit messages -- confirmed live. Previously unchecked
            # here, which meant a rate-limited/premium-gated call silently
            # looked like "no data" (data.get(...) on a key that doesn't
            # exist just returns {}/[]) instead of raising -- very confusing
            # to debug from the UI's warning list alone. Redact apikey
            # before it can end up in a raised exception -- this message is
            # exactly the kind of thing that gets logged, printed in a stack
            # trace, or pasted into a bug report.
            safe_params = {**params, "apikey": "***REDACTED***"}
            raise RuntimeError(
                f"Alpha Vantage API error/rate-limit for params {safe_params}: {_redact_error_text(data)}"
            )
        return data

    def get_daily(self, ticker: str, outputsize: str = "full") -> dict[date, dict]:
        """Returns {date: {open, high, low, close, volume}} for `ticker`,
        via the FREE-tier TIME_SERIES_DAILY endpoint (unadjusted -- see the
        module docstring).

        outputsize='full' is CONFIRMED PREMIUM-ONLY, live-verified (returns
        {"Information": "...outputsize=full parameter value is a premium
        feature for the TIME_SERIES_DAILY endpoint..."}) -- it is NOT just
        TIME_SERIES_DAILY_ADJUSTED that's gated. On a free key this method
        can only ever return 'compact' (~100 most recent sessions), which is
        under required_inputs.py's MIN_PRICE_HISTORY_TRADING_DAYS=200, so
        ma_200 (and therefore price_signals / the Market score) cannot be
        computed from this endpoint on a free tier at all. See the "Live
        ingestion" section of README.md for the options this leaves."""
        data = self._get({"function": "TIME_SERIES_DAILY", "symbol": ticker, "outputsize": outputsize})
        series = data.get("Time Series (Daily)", {})
        out: dict[date, dict] = {}
        for date_str, bar in series.items():
            d = datetime.strptime(date_str, "%Y-%m-%d").date()
            out[d] = {
                "open": float(bar["1. open"]),
                "high": float(bar["2. high"]),
                "low": float(bar["3. low"]),
                "close": float(bar["4. close"]),
                "volume": float(bar["5. volume"]),
            }
        return out

    def get_daily_adjusted(self, ticker: str, outputsize: str = "full") -> dict[date, dict]:
        """Returns {date: {open, high, low, close, adjusted_close, volume}}
        for `ticker`. PREMIUM-ONLY on Alpha Vantage's free tier -- confirmed
        live (returns an "Information"/premium-upsell payload instead of
        data on a free key). Kept for anyone with a premium key; live
        ingestion (src/ingestion/live.py) uses get_daily() instead."""
        data = self._get({"function": "TIME_SERIES_DAILY_ADJUSTED", "symbol": ticker, "outputsize": outputsize})
        series = data.get("Time Series (Daily)", {})
        out: dict[date, dict] = {}
        for date_str, bar in series.items():
            d = datetime.strptime(date_str, "%Y-%m-%d").date()
            out[d] = {
                "open": float(bar["1. open"]),
                "high": float(bar["2. high"]),
                "low": float(bar["3. low"]),
                "close": float(bar["4. close"]),
                "adjusted_close": float(bar["5. adjusted close"]),
                "volume": float(bar["6. volume"]),
            }
        return out

    def get_earnings(self, ticker: str) -> dict:
        """Returns Alpha Vantage's EARNINGS payload: quarterlyEarnings has
        reportedDate, reportedEPS, estimatedEPS, surprise, fiscalDateEnding."""
        return self._get({"function": "EARNINGS", "symbol": ticker})

    def get_earnings_estimates(self, ticker: str) -> dict:
        """Returns Alpha Vantage's EARNINGS_ESTIMATES payload: {"estimates":
        [{date, horizon ('fiscal quarter'/'fiscal year'), eps_estimate_average,
        eps_estimate_average_7_days_ago, ..._30_days_ago, ..._60_days_ago,
        ..._90_days_ago, revenue_estimate_average, ...}, ...]}. `date` is the
        FISCAL PERIOD END date, not the report date -- for an unreported
        quarter this is the closest thing to "which quarter this estimate is
        for" available. Verified working on the free tier."""
        return self._get({"function": "EARNINGS_ESTIMATES", "symbol": ticker})

    def get_earnings_calendar(self, ticker: str, horizon: str = "3month") -> list[dict]:
        """Returns Alpha Vantage's EARNINGS_CALENDAR rows for `ticker`:
        [{symbol, name, reportDate, fiscalDateEnding, estimate, currency}, ...].
        Unlike every other endpoint here, this one responds with CSV, not
        JSON -- confirmed live (Content-Type: application/x-download) --
        EXCEPT when erroring/rate-limited, in which case it falls back to a
        JSON {"Error Message"/"Note"/"Information": ...} body instead of
        CSV. Feeding that JSON text straight into csv.DictReader (the
        original bug here) doesn't raise -- it silently parses into
        garbage field names/rows, which then blow up confusingly deep in the
        caller (e.g. datetime.strptime on a single stray character) instead
        of surfacing the real rate-limit/error message. Detected and raised
        explicitly here instead."""
        params = {**{"function": "EARNINGS_CALENDAR", "symbol": ticker, "horizon": horizon}, "apikey": self.api_key}
        self._wait_for_rate_limit()
        resp = self.session.get(BASE_URL, params=params, timeout=30)
        resp.raise_for_status()
        text = resp.text
        stripped = text.lstrip("\ufeff \t\r\n")
        # Depending on the edge/cache response, Alpha Vantage may return the
        # rate-limit body as JSON, a quoted JSON-like body, or an HTML/text
        # wrapper. Detect the known error marker before csv.DictReader can
        # turn the payload into garbage rows such as reportDate='f'.
        if (
            stripped.startswith("{")
            or "\"Information\"" in text
            or "'Information'" in text
            or "Thank you for using Alpha Vantage" in text
        ):
            try:
                data = json.loads(stripped)
            except ValueError:
                data = text
            safe_params = {**params, "apikey": "***REDACTED***"}
            raise RuntimeError(f"Alpha Vantage EARNINGS_CALENDAR returned an error instead of CSV for params {safe_params}: {data}")
        reader = csv.DictReader(io.StringIO(text))
        return list(reader)
