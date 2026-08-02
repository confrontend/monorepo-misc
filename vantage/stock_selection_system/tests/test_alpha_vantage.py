import pytest

from src.ingestion.alpha_vantage import AlphaVantageClient


class _FakeResponse:
    def __init__(self, payload=None, text=None):
        self._payload = payload
        # get_earnings_calendar reads .text directly (CSV, not JSON) rather
        # than calling .json() -- support both on the same fake.
        self.text = text if text is not None else ""

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeSession:
    """Records the params it was called with and returns a canned payload --
    lets us test _get()'s error-message formatting without any real network
    call or a real API key."""

    def __init__(self, payload=None, text=None):
        self._payload = payload
        self._text = text
        self.last_params = None

    def get(self, url, params=None, timeout=None):
        self.last_params = params
        return _FakeResponse(self._payload, self._text)


def test_get_raises_with_readable_message_on_rate_limit_note():
    session = _FakeSession({"Note": "Thank you for using Alpha Vantage! Our standard API rate limit is..."})
    client = AlphaVantageClient(api_key="secret-key-do-not-leak", session=session)
    with pytest.raises(RuntimeError, match="Alpha Vantage API error/rate-limit"):
        client._get({"function": "EARNINGS", "symbol": "ATI"})


def test_get_redacts_api_key_from_raised_error_message():
    # Regression test: the request DOES carry the real key (Alpha Vantage
    # requires it), but the raised error message -- which can end up logged,
    # printed in a stack trace, or pasted into a bug report/PR description --
    # must never contain it.
    secret = "TOTALLY-SECRET-KEY-12345"
    session = _FakeSession({"Error Message": "Invalid API call."})
    client = AlphaVantageClient(api_key=secret, session=session)

    with pytest.raises(RuntimeError) as exc_info:
        client._get({"function": "EARNINGS", "symbol": "ATI"})

    message = str(exc_info.value)
    assert secret not in message
    assert "REDACTED" in message
    # Sanity check the request itself still carried the real key -- only the
    # error MESSAGE should be redacted, not the actual outgoing request.
    assert session.last_params["apikey"] == secret


def test_get_raises_on_information_key_premium_or_rate_limit_message():
    # Regression test: "Information" is the key Alpha Vantage actually uses
    # for both premium-upsell messages (e.g. outputsize=full on
    # TIME_SERIES_DAILY) and rate-limit messages -- confirmed live. Before
    # this was checked, a response like this silently looked like "no data"
    # to every caller (data.get("Time Series (Daily)", {}) on a dict with no
    # such key just returns {}), which is exactly what happened during a
    # real ingestion run: price_signals/earnings/estimates all silently came
    # back empty instead of raising a clear "rate limited" error.
    session = _FakeSession({"Information": "Thank you for using Alpha Vantage! ... rate limit ..."})
    client = AlphaVantageClient(api_key="secret-key-do-not-leak", session=session)
    with pytest.raises(RuntimeError, match="Alpha Vantage API error/rate-limit"):
        client._get({"function": "TIME_SERIES_DAILY", "symbol": "ATI", "outputsize": "full"})


def test_get_earnings_calendar_parses_real_csv():
    csv_text = (
        "symbol,name,reportDate,fiscalDateEnding,estimate,currency\n"
        "ATI,Allegheny Technologies Inc,2026-10-29,2026-09-30,0.9,USD\n"
    )
    session = _FakeSession(text=csv_text)
    client = AlphaVantageClient(api_key="secret-key-do-not-leak", session=session)
    rows = client.get_earnings_calendar("ATI")
    assert rows == [{
        "symbol": "ATI", "name": "Allegheny Technologies Inc", "reportDate": "2026-10-29",
        "fiscalDateEnding": "2026-09-30", "estimate": "0.9", "currency": "USD",
    }]


def test_get_earnings_calendar_raises_instead_of_parsing_error_json_as_csv():
    # Regression test for the exact bug reported from a real ingestion run:
    # when rate-limited/erroring, EARNINGS_CALENDAR falls back to a JSON
    # body (not CSV). Feeding that straight into csv.DictReader didn't
    # raise -- it silently produced garbage rows, which then blew up deep
    # inside live.py as `time data 'f' does not match format '%Y-%m-%d'`
    # instead of surfacing the real rate-limit message. Must raise here,
    # at the source, with the actual message.
    error_json = '{"Information": "Thank you for using Alpha Vantage! ... rate limit ..."}'
    session = _FakeSession(text=error_json)
    client = AlphaVantageClient(api_key="secret-key-do-not-leak", session=session)
    with pytest.raises(RuntimeError, match="EARNINGS_CALENDAR returned an error instead of CSV"):
        client.get_earnings_calendar("ATI")


def test_get_earnings_calendar_rejects_wrapped_rate_limit_text():
    session = _FakeSession(text="prefix Thank you for using Alpha Vantage! rate limit suffix")
    client = AlphaVantageClient(api_key="secret-key-do-not-leak", session=session)
    with pytest.raises(RuntimeError, match="EARNINGS_CALENDAR returned an error instead of CSV"):
        client.get_earnings_calendar("ATI")
