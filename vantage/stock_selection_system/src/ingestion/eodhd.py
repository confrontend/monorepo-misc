"""EODHD price client and read-only provider diagnostic workflow.

EODHD is the production source for daily price history. Alpha Vantage remains
the source for earnings and EPS estimate data in ``live.py``. The diagnostic
helpers in this module are read-only and never open the application database.
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import date, timedelta
from typing import Any, Optional

import requests

from ..scoring import HIGH_VOLUME_BREAKDOWN_MULTIPLE
from ..trading_calendar import default_calendar

logger = logging.getLogger(__name__)

BASE_URL = "https://eodhd.com/api"
REQUIRED_BARS = 200
TRADING_DAYS_3M = 63
EODHD_STATUSES = {
    "passed",
    "missing",
    "unsupported",
    "rate_limited",
    "authentication_failed",
    "provider_error",
}


class EODHDConfigurationError(RuntimeError):
    pass


class EODHDProviderError(RuntimeError):
    def __init__(self, status: str, message: str, endpoint: str, raw: Any = None, http_status: Optional[int] = None, diagnostics: Optional[dict] = None):
        self.status = status if status in EODHD_STATUSES else "provider_error"
        self.endpoint = endpoint
        self.raw = _redact(raw)
        self.http_status = http_status
        self.diagnostics = _redact(diagnostics or {})
        super().__init__(_redact(message))


def _redact(value: Any) -> Any:
    """Remove API tokens from messages and provider payloads before returning."""
    if isinstance(value, dict):
        return {
            key: "***REDACTED***" if key.lower() in {"api_token", "apikey", "api_key"} else _redact(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_redact(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"(?i)(api_token|apikey|api_key)=([^&\s]+)", r"\1=***REDACTED***", value)
    return value


def provider_symbol(ticker: str) -> str:
    """Convert a user ticker to EODHD's US symbol without truncating classes.

    Examples: ATI -> ATI.US, BRK.B -> BRK.B.US, BRK-B -> BRK-B.US,
    ATI.US -> ATI.US. Existing exchange suffixes are preserved.
    """
    value = ticker.strip().upper()
    if not value:
        raise ValueError("ticker must not be empty")
    if value.endswith(".US"):
        return value
    exchange_suffixes = {"PA", "TO", "LSE", "LSEIOB", "F", "HK", "TSE", "LIS", "AS", "STU", "XETRA"}
    if "." in value and value.rsplit(".", 1)[1] in exchange_suffixes:
        return value
    return f"{value}.US"


def _number(value: Any) -> Optional[float]:
    if value in (None, "", "None", "null"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _date(value: Any) -> Optional[date]:
    if not value:
        return None
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def _jsonable(value: Any) -> Any:
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_jsonable(item) for item in value]
    return value


def _response_body(response: Any) -> Any:
    try:
        return response.json()
    except (ValueError, json.JSONDecodeError, AttributeError):
        return _redact(getattr(response, "text", ""))


def _response_diagnostics(response: Any) -> dict:
    headers = getattr(response, "headers", {}) or {}
    safe_headers = {
        str(key): str(value)
        for key, value in headers.items()
        if str(key).lower() in {"content-type", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-request-id", "request-id"}
    }
    return {"http_status": getattr(response, "status_code", None), "response_headers": _redact(safe_headers)}


class EODHDClient:
    def __init__(self, api_key: Optional[str] = None, session: Optional[requests.Session] = None):
        self.api_key = api_key or os.environ.get("EODHD_API_KEY")
        if not self.api_key:
            raise EODHDConfigurationError("EODHD_API_KEY is not configured")
        self.session = session or requests.Session()

    def _get(self, path: str, params: dict[str, Any]) -> Any:
        endpoint = f"/api/{path.lstrip('/')}"
        safe_params = {key: value for key, value in params.items() if key != "api_token"}
        request_params = {**params, "api_token": self.api_key, "fmt": "json"}
        logger.debug("EODHD request endpoint=%s params=%s", endpoint, safe_params)
        try:
            response = self.session.get(f"{BASE_URL}/{path.lstrip('/')}", params=request_params, timeout=30)
        except requests.RequestException as exc:
            raise EODHDProviderError("provider_error", f"request failed for {endpoint}: {exc}", endpoint) from exc

        provider_body = _response_body(response)
        provider_diagnostics = _response_diagnostics(response)
        if response.status_code in (401, 403):
            logger.warning("EODHD authentication failure endpoint=%s http_status=%s diagnostics=%s body=%s", endpoint, response.status_code, provider_diagnostics, _redact(provider_body))
            raise EODHDProviderError(
                "authentication_failed", f"EODHD rejected the request for {endpoint} (HTTP {response.status_code})",
                endpoint, raw=provider_body, http_status=response.status_code, diagnostics=provider_diagnostics,
            )
        if response.status_code == 429:
            logger.warning("EODHD rate limit endpoint=%s diagnostics=%s body=%s", endpoint, provider_diagnostics, _redact(provider_body))
            raise EODHDProviderError(
                "rate_limited", f"EODHD rate-limited the request for {endpoint} (HTTP 429)",
                endpoint, raw=provider_body, http_status=429, diagnostics=provider_diagnostics,
            )
        if response.status_code >= 400:
            raise EODHDProviderError(
                "provider_error", f"EODHD returned HTTP {response.status_code} for {endpoint}",
                endpoint, raw=provider_body, http_status=response.status_code, diagnostics=provider_diagnostics,
            )
        try:
            payload = response.json()
        except (ValueError, json.JSONDecodeError) as exc:
            raise EODHDProviderError(
                "provider_error", f"EODHD returned malformed JSON for {endpoint}", endpoint,
                raw=getattr(response, "text", ""), http_status=response.status_code, diagnostics=provider_diagnostics,
            ) from exc
        if isinstance(payload, dict) and any(key in payload for key in ("error", "errors", "Error Message")):
            raise EODHDProviderError("provider_error", f"EODHD returned an error for {endpoint}", endpoint, payload)
        return payload

    def get_eod(self, symbol: str, from_date: date, to_date: date) -> Any:
        return self._get(f"eod/{symbol}", {"from": from_date.isoformat(), "to": to_date.isoformat(), "period": "d", "order": "a"})

    def get_splits(self, symbol: str, from_date: date, to_date: date) -> Any:
        return self._get(f"splits/{symbol}", {"from": from_date.isoformat(), "to": to_date.isoformat()})

    def get_dividends(self, symbol: str, from_date: date, to_date: date) -> Any:
        return self._get(f"div/{symbol}", {"from": from_date.isoformat(), "to": to_date.isoformat()})

    def get_daily(self, ticker: str, outputsize: str = "full") -> dict[date, dict[str, float]]:
        """Return normalized daily bars for the live price-ingestion interface.

        EODHD's free plan provides roughly one year of EOD history, which is
        enough for the application's 200-trading-day requirement. Request a
        generous calendar window because weekends and market holidays are not
        trading bars.
        """
        del outputsize  # kept for compatibility with the Alpha Vantage client interface
        to_date = date.today()
        payload = self.get_eod(provider_symbol(ticker), to_date - timedelta(days=450), to_date)
        rows = payload if isinstance(payload, list) else payload.get("data") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise ValueError("EODHD EOD response did not contain a JSON array of bars")
        series: dict[date, dict[str, float]] = {}
        for row in rows:
            if not isinstance(row, dict):
                continue
            row_date = _date(row.get("date"))
            values = {field: _number(row.get(field)) for field in ("open", "high", "low", "close", "volume")}
            if row_date and all(value is not None for value in values.values()):
                series[row_date] = values  # type: ignore[assignment]
        if not series:
            raise ValueError(f"EODHD returned no usable daily bars for {ticker}")
        logger.info("EODHD daily history ticker=%s symbol=%s bars=%d", ticker, provider_symbol(ticker), len(series))
        return series

    def get_earnings(self, symbol: str) -> Any:
        return self._get("calendar/earnings", {"symbols": symbol})

    def get_trends(self, symbol: str) -> Any:
        return self._get("calendar/trends", {"symbols": symbol})


def _section(status: str, data: Any = None, raw: Any = None, endpoint: Optional[str] = None, error: Optional[str] = None, http_status: Optional[int] = None, diagnostics: Optional[dict] = None) -> dict:
    result = {"status": status, "data": _jsonable(data), "provider_response": _redact(raw)}
    if endpoint:
        result["endpoint"] = endpoint
    if error:
        result["error"] = _redact(error)
    if http_status is not None:
        result["http_status"] = http_status
    if diagnostics:
        result["provider_diagnostics"] = _redact(diagnostics)
    return result


def _failure(exc: Exception) -> dict:
    if isinstance(exc, EODHDProviderError):
        return _section(exc.status, raw=exc.raw, endpoint=exc.endpoint, error=str(exc), http_status=exc.http_status, diagnostics=exc.diagnostics)
    return _section("provider_error", error=str(exc))


def _bars(payload: Any, as_of_date: date) -> list[dict]:
    if isinstance(payload, list):
        rows = payload
    elif isinstance(payload, dict) and isinstance(payload.get("data"), list):
        rows = payload["data"]
    else:
        raise ValueError("EODHD EOD response did not contain a JSON array of bars")
    result = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        row_date = _date(row.get("date"))
        parsed = {
            "date": row_date,
            "open": _number(row.get("open")),
            "high": _number(row.get("high")),
            "low": _number(row.get("low")),
            "close": _number(row.get("close")),
            "adjusted_close": _number(row.get("adjusted_close", row.get("adjustedClose"))),
            "volume": _number(row.get("volume")),
        }
        if row_date and row_date <= as_of_date and default_calendar.is_trading_day(row_date):
            if all(parsed[field] is not None for field in ("open", "high", "low", "close", "volume")):
                result.append(parsed)
    return sorted(result, key=lambda row: row["date"])


def _price_data(payload: Any, as_of_date: date, is_spy: bool) -> tuple[dict, str]:
    bars = _bars(payload, as_of_date)
    data: dict[str, Any] = {"bar_count": len(bars), "required_bar_count": REQUIRED_BARS}
    if len(bars) < REQUIRED_BARS:
        return data, "missing"
    closes = [row["close"] for row in bars]
    volumes = [row["volume"] for row in bars]
    data.update({
        "last_bar_date": bars[-1]["date"],
        "current_close": closes[-1],
        "current_volume": volumes[-1],
        "ma50": sum(closes[-50:]) / 50,
        "ma200": sum(closes[-200:]) / 200,
        "average_volume_30": sum(volumes[-30:]) / 30,
        "return_3m": (closes[-1] / closes[-1 - TRADING_DAYS_3M]) - 1,
    })
    if not is_spy:
        data["high_volume_breakdown"] = False
    return data, "passed"


def _earnings_rows(payload: Any) -> list[dict]:
    if isinstance(payload, dict):
        if not isinstance(payload.get("earnings"), list):
            raise ValueError("EODHD earnings response did not contain an earnings array")
        return [row for row in payload["earnings"] if isinstance(row, dict)]
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    raise ValueError("EODHD earnings response was not a JSON object or array")


def _trend_rows(payload: Any, symbol: str) -> list[dict]:
    if not isinstance(payload, dict):
        raise ValueError("EODHD trends response was not a JSON object")
    trends = payload.get("trends", [])
    if not isinstance(trends, list):
        raise ValueError("EODHD trends response did not contain a trends array")
    if trends and isinstance(trends[0], list):
        trends = trends[0]
    return [row for row in trends if isinstance(row, dict) and (not row.get("code") or str(row["code"]).upper() == symbol)]


def run_eodhd_test(ticker: str, as_of_date: date, client: Optional[EODHDClient] = None) -> dict:
    """Run every diagnostic independently; one failed provider call cannot stop the others."""
    symbol = provider_symbol(ticker)
    client = client or EODHDClient()
    tests: dict[str, dict] = {}
    errors: list[str] = []
    warnings: list[str] = []

    for key, price_symbol in (("candidate_prices", symbol), ("spy_prices", "SPY.US")):
        try:
            payload = client.get_eod(price_symbol, as_of_date - timedelta(days=450), as_of_date)
            data, status = _price_data(payload, as_of_date, key == "spy_prices")
            tests[key] = _section(status, data=data, raw=payload, endpoint=f"/api/eod/{price_symbol}")
        except Exception as exc:
            tests[key] = _failure(exc)
            errors.append(f"{key}: {tests[key].get('error', 'provider failure')}")

    if tests.get("candidate_prices", {}).get("status") == "passed" and tests.get("spy_prices", {}).get("status") == "passed":
        candidate = tests["candidate_prices"]["data"]
        spy = tests["spy_prices"]["data"]
        candidate["relative_spy_return_3m"] = candidate["return_3m"] - spy["return_3m"]
        candidate["high_volume_breakdown"] = (
            candidate["current_close"] < candidate["ma200"]
            and candidate["current_volume"] >= HIGH_VOLUME_BREAKDOWN_MULTIPLE * candidate["average_volume_30"]
        )

    earnings_payload: Any = None
    try:
        earnings_payload = client.get_earnings(symbol)
        rows = _earnings_rows(earnings_payload)
        reported = [
            row for row in rows
            if (_date(row.get("report_date")) or date.max) <= as_of_date
            and _number(row.get("actual")) is not None
            and _number(row.get("estimate")) is not None
        ]
        if not reported:
            tests["reported_earnings"] = _section("missing", raw=earnings_payload, endpoint="/api/calendar/earnings")
        else:
            row = max(reported, key=lambda item: _date(item.get("report_date")) or date.min)
            actual, estimate = _number(row.get("actual")), _number(row.get("estimate"))
            tests["reported_earnings"] = _section("passed", {
                "report_date": row.get("report_date"), "fiscal_period_end": row.get("date"),
                "actual_eps": actual, "estimated_eps": estimate,
                "beat_miss": "beat" if actual > estimate else "miss" if actual < estimate else "in_line",
            }, earnings_payload, "/api/calendar/earnings")
    except Exception as exc:
        tests["reported_earnings"] = _failure(exc)
        errors.append(f"reported_earnings: {tests['reported_earnings'].get('error', 'provider failure')}")

    try:
        trends_payload = client.get_trends(symbol)
        rows = _trend_rows(trends_payload, symbol)
        upcoming = [row for row in rows if (_date(row.get("date")) or date.min) > as_of_date and row.get("period") in ("+1q", "0q")]
        upcoming.sort(key=lambda row: _date(row.get("date")) or date.max)
        row = upcoming[0] if upcoming else None
        current = _number(row.get("epsTrendCurrent")) if row else None
        prior = _number(row.get("epsTrend30daysAgo")) if row else None
        status = "passed" if row and current is not None and prior is not None else "missing"
        change = "rose" if current is not None and prior is not None and current > prior else "fell" if current is not None and prior is not None and current < prior else "unchanged" if current is not None and prior is not None else None
        tests["forward_estimates"] = _section(status, {
            "fiscal_period_end": row.get("date") if row else None,
            "current_consensus_eps": current, "consensus_eps_30_days_ago": prior, "change": change,
        }, trends_payload, "/api/calendar/trends")
    except Exception as exc:
        tests["forward_estimates"] = _failure(exc)
        errors.append(f"forward_estimates: {tests['forward_estimates'].get('error', 'provider failure')}")

    try:
        calendar_payload = earnings_payload if earnings_payload is not None else client.get_earnings(symbol)
        rows = [row for row in _earnings_rows(calendar_payload) if (_date(row.get("report_date")) or date.min) >= as_of_date]
        rows.sort(key=lambda row: _date(row.get("report_date")) or date.max)
        row = rows[0] if rows else None
        if row is None:
            tests["earnings_calendar"] = _section("missing", raw=calendar_payload, endpoint="/api/calendar/earnings")
        else:
            report_date = _date(row.get("report_date"))
            tests["earnings_calendar"] = _section("passed", {
                "scheduled_report_date": report_date,
                "within_5_nyse_trading_days": default_calendar.trading_days_between(as_of_date, report_date) <= 5,
                "days_until_report": default_calendar.trading_days_between(as_of_date, report_date),
            }, calendar_payload, "/api/calendar/earnings")
    except Exception as exc:
        tests["earnings_calendar"] = _failure(exc)
        errors.append(f"earnings_calendar: {tests['earnings_calendar'].get('error', 'provider failure')}")

    for name, result in tests.items():
        if result.get("status") == "missing":
            warnings.append(f"{name}: required data is missing")
        elif result.get("status") not in ("passed", "missing"):
            errors.append(f"{name}: {result.get('error', result.get('status'))}")

    return {
        "ticker": ticker.strip().upper(),
        "provider_symbols": {"ticker": symbol, "benchmark": "SPY.US"},
        "as_of_date": as_of_date.isoformat(),
        "tests": tests,
        "all_required_data_available": all(result.get("status") == "passed" for result in tests.values()),
        "warnings": warnings,
        "errors": list(dict.fromkeys(errors)),
    }


def eodhd_authentication_failure(ticker: str, as_of_date: date) -> dict:
    """Return the same diagnostic shape when configuration stops requests."""
    message = "EODHD_API_KEY is not configured"
    tests = {
        name: _section("authentication_failed", error=message)
        for name in ("candidate_prices", "spy_prices", "reported_earnings", "forward_estimates", "earnings_calendar")
    }
    return {
        "ticker": ticker.strip().upper(),
        "provider_symbols": {"ticker": provider_symbol(ticker), "benchmark": "SPY.US"},
        "as_of_date": as_of_date.isoformat(),
        "tests": tests,
        "all_required_data_available": False,
        "warnings": [],
        "errors": [message],
    }
