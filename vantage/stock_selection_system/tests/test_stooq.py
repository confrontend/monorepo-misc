from datetime import date

import pytest

from src.ingestion.stooq import StooqClient


class _FakeResponse:
    def __init__(self, text):
        self.text = text

    def raise_for_status(self):
        pass


class _FakeSession:
    def __init__(self, text):
        self._text = text
        self.last_params = None

    def get(self, url, params=None, timeout=None):
        self.last_params = params
        return _FakeResponse(self._text)


def test_get_daily_parses_real_looking_csv():
    csv_text = (
        "Date,Open,High,Low,Close,Volume\n"
        "2026-01-02,10.0,10.5,9.8,10.2,1000000\n"
        "2026-01-05,10.2,10.6,10.1,10.4,1100000\n"
    )
    session = _FakeSession(csv_text)
    client = StooqClient(session=session)
    series = client.get_daily("ATI")

    assert series == {
        date(2026, 1, 2): {"open": 10.0, "high": 10.5, "low": 9.8, "close": 10.2, "volume": 1_000_000.0},
        date(2026, 1, 5): {"open": 10.2, "high": 10.6, "low": 10.1, "close": 10.4, "volume": 1_100_000.0},
    }
    # Bare ticker gets Stooq's US-exchange suffix appended automatically.
    assert session.last_params["s"] == "ati.us"


def test_get_daily_passes_through_an_already_suffixed_symbol():
    session = _FakeSession("Date,Open,High,Low,Close,Volume\n2026-01-02,1,1,1,1,1\n")
    client = StooqClient(session=session)
    client.get_daily("ati.us")
    assert session.last_params["s"] == "ati.us"


def test_get_daily_raises_on_no_data_response():
    # Regression-guarding: Stooq's documented behavior for an unknown
    # symbol/exchange suffix is a plain "No data" text body (not CSV, not an
    # HTTP error) -- must raise a clear error rather than returning {} and
    # looking identical to "this ticker genuinely has zero bars."
    session = _FakeSession("No data")
    client = StooqClient(session=session)
    with pytest.raises(RuntimeError, match="no data"):
        client.get_daily("NOTATICKER")


def test_get_daily_raises_on_unexpected_response_shape():
    session = _FakeSession("<html>something went wrong</html>")
    client = StooqClient(session=session)
    with pytest.raises(RuntimeError, match="didn't look like the expected CSV"):
        client.get_daily("ATI")


def test_get_daily_skips_malformed_rows_without_crashing():
    csv_text = (
        "Date,Open,High,Low,Close,Volume\n"
        "2026-01-02,10.0,10.5,9.8,10.2,1000000\n"
        "not-a-date,x,x,x,x,x\n"
        "2026-01-05,10.2,10.6,10.1,10.4,1100000\n"
    )
    session = _FakeSession(csv_text)
    client = StooqClient(session=session)
    series = client.get_daily("ATI")
    assert len(series) == 2
