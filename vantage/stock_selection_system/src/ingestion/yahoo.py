"""Keyless Yahoo Finance chart client used when Stooq's CSV route is blocked.

Yahoo's chart endpoint returns JSON OHLCV history and does not require a
login/API key for this read-only daily-history use case. The interface matches
Stooq/AlphaVantage so the ingestion pipeline stays provider-agnostic.
"""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timezone
from typing import Optional

import requests

BASE_URLS = (
    "https://query1.finance.yahoo.com/v8/finance/chart",
    "https://query2.finance.yahoo.com/v8/finance/chart",
)
logger = logging.getLogger(__name__)


class YahooFinanceClient:
    def __init__(self, session: Optional[requests.Session] = None):
        self.session = session or requests.Session()
        self._cache: dict[str, dict[date, dict]] = {}
        if session is None:
            self.session.headers.update({
                "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
                "Accept": "application/json",
            })

    def get_daily(self, ticker: str, outputsize: str = "full") -> dict[date, dict]:
        symbol = ticker.split(".", 1)[0].upper()
        if symbol in self._cache:
            return self._cache[symbol]

        now = int(datetime.now(timezone.utc).timestamp())
        # Ten years is more than enough for the system's 200-session technical
        # requirements and avoids requesting an unnecessarily large payload.
        params = {"period1": now - 10 * 365 * 24 * 60 * 60, "period2": now, "interval": "1d", "events": "history"}
        last_error = None
        payload = None
        for base_url in BASE_URLS:
            for attempt in range(2):
                response = self.session.get(f"{base_url}/{symbol}", params=params, timeout=30)
                if response.status_code == 429:
                    last_error = f"HTTP 429 from {base_url}"
                    retry_after = response.headers.get("Retry-After", "1")
                    try:
                        delay = min(float(retry_after), 3.0)
                    except ValueError:
                        delay = 1.0
                    if attempt == 0:
                        time.sleep(delay)
                        continue
                    break
                response.raise_for_status()
                payload = response.json()
                break
            if payload is not None:
                break
        if payload is None:
            raise RuntimeError(f"Yahoo chart request was rate-limited for '{symbol}' ({last_error})")
        result = (payload.get("chart") or {}).get("result") or []
        error = (payload.get("chart") or {}).get("error")
        if not result:
            raise RuntimeError(f"Yahoo chart returned no data for '{symbol}': {error or payload}")

        chart = result[0]
        timestamps = chart.get("timestamp") or []
        quote = ((chart.get("indicators") or {}).get("quote") or [{}])[0]
        out: dict[date, dict] = {}
        for i, timestamp in enumerate(timestamps):
            try:
                values = {key: quote[key][i] for key in ("open", "high", "low", "close", "volume")}
                if any(value is None for value in values.values()):
                    continue
                d = datetime.fromtimestamp(timestamp, tz=timezone.utc).date()
                out[d] = {
                    "open": float(values["open"]), "high": float(values["high"]),
                    "low": float(values["low"]), "close": float(values["close"]),
                    "volume": float(values["volume"]),
                }
            except (KeyError, IndexError, TypeError, ValueError):
                continue
        if not out:
            raise RuntimeError(f"Yahoo chart returned no usable daily bars for '{symbol}'")
        self._cache[symbol] = out
        return out


class FallbackPriceClient:
    """Try a primary provider, then a secondary provider per symbol."""

    def __init__(self, primary, fallback):
        self.primary = primary
        self.fallback = fallback

    def get_daily(self, ticker: str, outputsize: str = "full") -> dict[date, dict]:
        try:
            return self.primary.get_daily(ticker, outputsize=outputsize)
        except Exception as primary_exc:
            logger.warning("primary price provider failed ticker=%s; using fallback: %s", ticker, primary_exc)
            try:
                return self.fallback.get_daily(ticker, outputsize=outputsize)
            except Exception as fallback_exc:
                raise RuntimeError(
                    f"price providers failed for {ticker}: primary={primary_exc}; fallback={fallback_exc}"
                ) from fallback_exc
