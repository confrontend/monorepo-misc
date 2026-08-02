"""
Alpha Vantage client for EPS/estimates/earnings history and OHLCV price data
(the "Alpha Vantage for EPS/estimates/earnings history" data source named in
the implementation prompt's scope section).

Requires ALPHA_VANTAGE_API_KEY in the environment. Not exercised by the test
suite or the ATI demo (which uses synthetic seed data instead) -- this is the
integration point to wire up once a real free-tier key is available. Per
spec Section 14, field availability and free-tier rate limits must be
reverified before this is used for live ingestion (Alpha Vantage's free tier
is rate-limited to a small number of requests per minute/day, which matters
for a 5-10 stock watchlist run daily).
"""
from __future__ import annotations

import os
from datetime import date, datetime
from typing import Optional

import requests

BASE_URL = "https://www.alphavantage.co/query"


class AlphaVantageClient:
    def __init__(self, api_key: Optional[str] = None, session: Optional[requests.Session] = None):
        self.api_key = api_key or os.environ.get("ALPHA_VANTAGE_API_KEY")
        if not self.api_key:
            raise RuntimeError(
                "ALPHA_VANTAGE_API_KEY is not set. Export it in the environment or pass "
                "api_key= explicitly before using AlphaVantageClient."
            )
        self.session = session or requests.Session()

    def _get(self, params: dict) -> dict:
        params = {**params, "apikey": self.api_key}
        resp = self.session.get(BASE_URL, params=params, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        if "Error Message" in data or "Note" in data:
            raise RuntimeError(f"Alpha Vantage API error/rate-limit for params {params}: {data}")
        return data

    def get_daily_adjusted(self, ticker: str, outputsize: str = "full") -> dict[date, dict]:
        """Returns {date: {open, high, low, close, adjusted_close, volume}} for `ticker`."""
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
