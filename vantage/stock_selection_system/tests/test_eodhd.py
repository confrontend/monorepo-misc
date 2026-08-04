from datetime import date, timedelta
from unittest.mock import patch

import pytest

from src.db import init_db
from src.ingestion.eodhd import (
    EODHDClient,
    EODHDConfigurationError,
    EODHDProviderError,
    eodhd_authentication_failure,
    provider_symbol,
    run_eodhd_test,
)
from src.trading_calendar import default_calendar


AS_OF = date(2026, 8, 1)


class Response:
    def __init__(self, payload=None, status_code=200, malformed=False, text="", headers=None):
        self.payload = payload
        self.status_code = status_code
        self.malformed = malformed
        self.text = text
        self.headers = headers or {}

    def json(self):
        if self.malformed:
            raise ValueError("not json")
        return self.payload


class Session:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def get(self, url, params=None, timeout=None):
        self.calls.append((url, params))
        return self.response


def bars(count=205):
    sessions = default_calendar.sessions_in_window(AS_OF - timedelta(days=500), AS_OF)
    selected = sessions[-count:]
    return [
        {
            "date": d.isoformat(), "open": 10 + i, "high": 11 + i,
            "low": 9 + i, "close": 10.5 + i, "adjusted_close": 10.4 + i,
            "volume": 1000 + i,
        }
        for i, d in enumerate(selected)
    ]


class FakeClient:
    def __init__(self, fail_candidate=False):
        self.fail_candidate = fail_candidate
        self.earnings_payload = {"earnings": [
            {"code": "ATI.US", "report_date": "2026-07-15", "date": "2026-06-30", "actual": 1.2, "estimate": 1.0},
            {"code": "ATI.US", "report_date": "2026-08-20", "date": "2026-09-30", "actual": None, "estimate": 1.3},
        ]}
        self.trends_payload = {"trends": [[{
            "code": "ATI.US", "date": "2026-09-30", "period": "+1q",
            "epsTrendCurrent": "1.50", "epsTrend30daysAgo": "1.40",
        }]]}

    def get_eod(self, symbol, from_date, to_date):
        if symbol == "ATI.US" and self.fail_candidate:
            raise EODHDProviderError("provider_error", "candidate unavailable", "/api/eod/ATI.US")
        return bars()

    def get_earnings(self, symbol):
        return self.earnings_payload

    def get_trends(self, symbol):
        return self.trends_payload


def test_provider_symbol_preserves_exchange_and_class_share_symbols():
    assert provider_symbol("ATI") == "ATI.US"
    assert provider_symbol("ATI.US") == "ATI.US"
    assert provider_symbol("BRK.B") == "BRK.B.US"
    assert provider_symbol("AI.PA") == "AI.PA"


def test_missing_key_is_explicit_and_not_logged_or_exposed(monkeypatch, caplog):
    monkeypatch.delenv("EODHD_API_KEY", raising=False)
    with pytest.raises(EODHDConfigurationError) as exc:
        EODHDClient()
    assert "EODHD_API_KEY" in str(exc.value)
    assert "secret" not in caplog.text

    result = eodhd_authentication_failure("ATI", AS_OF)
    assert all(section["status"] == "authentication_failed" for section in result["tests"].values())


def test_eodhd_api_key_is_not_in_request_errors_or_logs(caplog):
    session = Session(Response({"error": "invalid api token"}, status_code=401, headers={"x-request-id": "req-123"}))
    client = EODHDClient(api_key="super-secret-token", session=session)
    with pytest.raises(EODHDProviderError) as exc:
        client.get_eod("ATI.US", AS_OF - timedelta(days=10), AS_OF)
    assert "super-secret-token" not in str(exc.value)
    assert "super-secret-token" not in caplog.text
    assert session.calls[0][1]["api_token"] == "super-secret-token"
    assert exc.value.http_status == 401
    assert exc.value.diagnostics["response_headers"]["x-request-id"] == "req-123"


def test_get_daily_normalizes_eodhd_bars_for_live_ingestion():
    payload = [{
        "date": "2026-07-31", "open": "10", "high": "11", "low": "9",
        "close": "10.5", "volume": "1000", "adjusted_close": "10.4",
    }]
    client = EODHDClient(api_key="key", session=Session(Response(payload)))
    result = client.get_daily("ATI")
    assert result[date(2026, 7, 31)] == {
        "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5, "volume": 1000.0,
    }


def test_successful_price_normalization_and_derived_values():
    result = run_eodhd_test("ATI", AS_OF, client=FakeClient())
    price = result["tests"]["candidate_prices"]
    assert price["status"] == "passed"
    assert price["data"]["bar_count"] == 205
    assert price["data"]["ma50"] is not None
    assert price["data"]["ma200"] is not None
    assert price["data"]["return_3m"] is not None
    assert result["tests"]["spy_prices"]["status"] == "passed"


def test_fewer_than_200_bars_is_missing():
    class ShortClient(FakeClient):
        def get_eod(self, symbol, from_date, to_date):
            return bars(199)

    result = run_eodhd_test("ATI", AS_OF, client=ShortClient())
    assert result["tests"]["candidate_prices"]["status"] == "missing"
    assert result["tests"]["candidate_prices"]["data"]["bar_count"] == 199


def test_reported_earnings_forward_estimates_and_calendar_are_mapped():
    result = run_eodhd_test("ATI", AS_OF, client=FakeClient())
    earnings = result["tests"]["reported_earnings"]["data"]
    assert earnings["fiscal_period_end"] == "2026-06-30"
    assert earnings["beat_miss"] == "beat"
    estimates = result["tests"]["forward_estimates"]["data"]
    assert estimates["fiscal_period_end"] == "2026-09-30"
    assert estimates["change"] == "rose"
    calendar = result["tests"]["earnings_calendar"]["data"]
    assert calendar["scheduled_report_date"] == "2026-08-20"
    assert calendar["within_5_nyse_trading_days"] is False


def test_missing_30_day_estimate_is_missing():
    client = FakeClient()
    client.trends_payload = {"trends": [[{
        "code": "ATI.US", "date": "2026-09-30", "period": "+1q",
        "epsTrendCurrent": "1.50", "epsTrend30daysAgo": None,
    }]]}
    result = run_eodhd_test("ATI", AS_OF, client=client)
    assert result["tests"]["forward_estimates"]["status"] == "missing"


@pytest.mark.parametrize("status,expected", [(401, "authentication_failed"), (403, "authentication_failed"), (429, "rate_limited")])
def test_http_statuses_are_classified(status, expected):
    client = EODHDClient(api_key="key", session=Session(Response({}, status_code=status)))
    with pytest.raises(EODHDProviderError) as exc:
        client.get_eod("ATI.US", AS_OF - timedelta(days=10), AS_OF)
    assert exc.value.status == expected


def test_malformed_provider_response_is_provider_error():
    client = EODHDClient(api_key="key", session=Session(Response(malformed=True, text="<html>not json</html>")))
    with pytest.raises(EODHDProviderError) as exc:
        client.get_eod("ATI.US", AS_OF - timedelta(days=10), AS_OF)
    assert exc.value.status == "provider_error"


def test_one_failed_section_does_not_stop_other_sections():
    result = run_eodhd_test("ATI", AS_OF, client=FakeClient(fail_candidate=True))
    assert result["tests"]["candidate_prices"]["status"] == "provider_error"
    assert result["tests"]["spy_prices"]["status"] == "passed"
    assert result["tests"]["reported_earnings"]["status"] == "passed"


def test_api_endpoint_is_read_only(monkeypatch):
    import api.main as api_main

    class FakeEODHD:
        pass

    monkeypatch.setattr(api_main, "EODHDClient", lambda: FakeEODHD())
    monkeypatch.setattr(api_main, "run_eodhd_test", lambda ticker, as_of_date, client: {"ticker": ticker, "as_of_date": as_of_date.isoformat(), "tests": {}, "all_required_data_available": False, "warnings": [], "errors": []})
    monkeypatch.setattr(api_main, "_conn", lambda: (_ for _ in ()).throw(AssertionError("database access")))
    result = api_main.test_eodhd(api_main.EODHDTestRequest(ticker="ATI", as_of_date=AS_OF))
    assert result["ticker"] == "ATI"
