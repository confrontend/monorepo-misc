from datetime import date, datetime, timezone

from src.ingestion.yahoo import YahooFinanceClient


class _Response:
    def __init__(self, payload):
        self.payload = payload
        self.status_code = 200
        self.headers = {}

    def raise_for_status(self):
        pass

    def json(self):
        return self.payload


class _Session:
    def __init__(self, payload):
        self.payload = payload
        self.params = None

    def get(self, url, params=None, timeout=None):
        self.params = params
        return _Response(self.payload)


def test_yahoo_chart_payload_is_normalized_to_daily_bars():
    timestamp = int(datetime(2026, 1, 2, tzinfo=timezone.utc).timestamp())
    session = _Session({
        "chart": {
            "result": [{
                "timestamp": [timestamp],
                "indicators": {"quote": [{
                    "open": [10], "high": [11], "low": [9], "close": [10.5], "volume": [1000],
                }]},
            }],
            "error": None,
        }
    })

    result = YahooFinanceClient(session=session).get_daily("ATI")

    assert result == {date(2026, 1, 2): {
        "open": 10.0, "high": 11.0, "low": 9.0, "close": 10.5, "volume": 1000.0,
    }}
    assert session.params["interval"] == "1d"
