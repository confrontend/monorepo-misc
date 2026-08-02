import pytest
import requests

from src.ingestion.danelfin import DanelfinClient, _extract_trade_idea_items


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class _FakeSession:
    """Returns canned payloads keyed by ticker (from the `ticker` query
    param), and can be told to raise for specific tickers -- lets tests
    exercise per-ticker isolation without any real network call."""

    def __init__(self, payloads: dict, raise_for: set = frozenset()):
        self._payloads = payloads
        self._raise_for = raise_for
        self.requested_tickers = []

    def get(self, url, headers=None, params=None, timeout=None):
        ticker = params["ticker"]
        self.requested_tickers.append(ticker)
        if ticker in self._raise_for:
            raise RuntimeError(f"simulated network failure for {ticker}")
        return _FakeResponse(self._payloads.get(ticker, {}))


def test_get_candidate_force_injects_ticker():
    session = _FakeSession({"ATI": {"ai_score": 8.5, "rank": "top_decile"}})
    client = DanelfinClient(api_key="secret", session=session)
    row = client.get_candidate("ATI")
    assert row["ticker"] == "ATI"
    assert row["ai_score"] == 8.5


def test_get_candidate_sends_api_key_header():
    session = _FakeSession({"ATI": {"ai_score": 8.5}})
    client = DanelfinClient(api_key="my-secret-key", session=session)
    client.get_candidate("ATI")
    # _FakeSession.get signature captures headers positionally via kwarg;
    # re-call and inspect via a wrapper to confirm the header is present.
    captured = {}
    class _CapturingSession(_FakeSession):
        def get(self, url, headers=None, params=None, timeout=None):
            captured["headers"] = headers
            return super().get(url, headers=headers, params=params, timeout=timeout)
    client2 = DanelfinClient(api_key="my-secret-key", session=_CapturingSession({"ATI": {}}))
    client2.get_candidate("ATI")
    assert captured["headers"] == {"x-api-key": "my-secret-key"}


def test_get_candidates_batch_fails_fast_on_first_error():
    # Documented, intentional behavior difference from
    # select_candidates()/get_candidate(): get_candidates() has NO
    # per-ticker isolation -- the whole batch call raises through on the
    # first error, discarding results already fetched for earlier tickers.
    session = _FakeSession({"ATI": {"ai_score": 8.5}}, raise_for={"MSFT"})
    client = DanelfinClient(api_key="secret", session=session)
    with pytest.raises(RuntimeError, match="simulated network failure for MSFT"):
        client.get_candidates(["ATI", "MSFT", "AAPL"])
    # AAPL was never even requested, since MSFT's exception aborted the loop.
    assert session.requested_tickers == ["ATI", "MSFT"]


def test_get_candidates_happy_path_returns_one_row_per_ticker():
    session = _FakeSession({"ATI": {"ai_score": 8.5}, "MSFT": {"ai_score": 7.0}})
    client = DanelfinClient(api_key="secret", session=session)
    rows = client.get_candidates(["ATI", "MSFT"])
    assert [r["ticker"] for r in rows] == ["ATI", "MSFT"]


# --- get_trade_ideas() -------------------------------------------------

class _FakeTradeIdeasSession:
    """Serves canned pages keyed by offset -- lets tests control exactly how
    many pages are "available" and assert on the exact URL/params/headers
    used for each request, without any real network call."""

    def __init__(self, pages: dict[int, list], wrap_key: str | None = None, raise_at_offset: dict[int, Exception] = None):
        self._pages = pages
        self._wrap_key = wrap_key
        self._raise_at_offset = raise_at_offset or {}
        self.requests = []  # [(url, headers, params)]

    def get(self, url, headers=None, params=None, timeout=None):
        offset = params["offset"]
        self.requests.append((url, dict(headers or {}), dict(params or {})))
        if offset in self._raise_at_offset:
            raise self._raise_at_offset[offset]
        items = self._pages.get(offset, [])
        payload = {self._wrap_key: items} if self._wrap_key else items
        return _FakeResponse(payload)


def test_get_trade_ideas_hits_the_correct_url_with_no_ticker_param():
    session = _FakeTradeIdeasSession({0: [{"ticker": "ATI"}]})
    client = DanelfinClient(api_key="secret", session=session)
    client.get_trade_ideas(limit=50)

    assert len(session.requests) == 1
    url, headers, params = session.requests[0]
    assert url == "https://apirest.danelfin.com/v3/trade-ideas"
    assert "ticker" not in params
    assert params["limit"] == 50
    assert params["offset"] == 0


def test_get_trade_ideas_sends_api_key_header():
    session = _FakeTradeIdeasSession({0: [{"ticker": "ATI"}]})
    client = DanelfinClient(api_key="my-secret-key", session=session)
    client.get_trade_ideas()
    _, headers, _ = session.requests[0]
    assert headers == {"x-api-key": "my-secret-key"}


def test_get_trade_ideas_only_sends_non_none_filters():
    session = _FakeTradeIdeasSession({0: []})
    client = DanelfinClient(api_key="secret", session=session)
    client.get_trade_ideas(market="us", direction="long")
    _, _, params = session.requests[0]
    assert params["market"] == "us"
    assert params["direction"] == "long"
    for unset in ("asset_type", "aiscore", "fundamental", "technical", "sentiment", "sector", "industry", "market_cap"):
        assert unset not in params


def test_get_trade_ideas_paginates_until_a_short_page():
    # Two full pages of 2, then a short (final) page of 1 -- must fetch all
    # three requests and concatenate all 5 items.
    session = _FakeTradeIdeasSession({
        0: [{"ticker": "A"}, {"ticker": "B"}],
        2: [{"ticker": "C"}, {"ticker": "D"}],
        4: [{"ticker": "E"}],
    })
    client = DanelfinClient(api_key="secret", session=session)
    ideas = client.get_trade_ideas(limit=2)

    assert [i["ticker"] for i in ideas] == ["A", "B", "C", "D", "E"]
    assert [r[2]["offset"] for r in session.requests] == [0, 2, 4]


def test_get_trade_ideas_stops_at_max_pages_even_without_a_short_page():
    # Pathological API that always returns a full page -- max_pages must
    # still bound the loop so this can't fetch forever.
    session = _FakeTradeIdeasSession(
        {offset: [{"ticker": f"T{offset}a"}, {"ticker": f"T{offset}b"}] for offset in range(0, 100, 2)}
    )
    client = DanelfinClient(api_key="secret", session=session)
    ideas = client.get_trade_ideas(limit=2, max_pages=3)

    assert len(session.requests) == 3
    assert len(ideas) == 6


def test_get_trade_ideas_unwraps_a_dict_response_under_a_known_key():
    session = _FakeTradeIdeasSession({0: [{"ticker": "ATI"}]}, wrap_key="data")
    client = DanelfinClient(api_key="secret", session=session)
    ideas = client.get_trade_ideas(limit=50)
    assert ideas == [{"ticker": "ATI"}]


# --- Real live-account response shape (pasted back from an actual account
# after the sandbox couldn't verify this live) --------------------------
# Trimmed to 3 tickers; real responses have ~100-300+. Field names/values
# reproduced exactly as observed: note `aiscore`/`fundamental`/`technical`
# (NOT `ai_score` etc.), no `rank`/`expected_return`/`direction` field at
# all, and non-score metadata (win_rate_*, sector/industry OR focus/aum)
# that isn't individually normalized but should ride along in
# raw_source_data.
REAL_TRADE_IDEAS_RESPONSE = {
    "2026-08-01": {
        "ATI": {
            "aiscore": 7, "fundamental": 5, "technical": 8, "sentiment": 7, "low_risk": 5,
            "market_cap": "large", "average_volume_3m": 1717186, "signals_days": 452,
            "win_rate_1y": 0.94377510040161, "sector": "industrials", "industry": "aerospace-defense",
        },
        "HWM": {
            "aiscore": 7, "fundamental": 7, "technical": 5, "sentiment": 9, "low_risk": 6,
            "market_cap": "large", "average_volume_3m": 2768957, "signals_days": 830,
            "win_rate_1y": 1, "sector": "industrials", "industry": "aerospace-defense",
        },
        "QQQ": {
            "aiscore": 8, "fundamental": 10, "technical": 6, "sentiment": 9, "low_risk": 6,
            "market_cap": None, "average_volume_3m": 44164556, "signals_days": 1510,
            "win_rate_1y": 0.8234398782344, "focus": "large-cap", "aum": 452329730000,
        },
    },
    "total": 318,
    "limit": 100,
    "offset": 0,
}


def test_extract_trade_idea_items_handles_the_real_live_account_shape():
    items = _extract_trade_idea_items(REAL_TRADE_IDEAS_RESPONSE)
    assert len(items) == 3

    by_ticker = {item["ticker"]: item for item in items}
    assert set(by_ticker) == {"ATI", "HWM", "QQQ"}

    ati = by_ticker["ATI"]
    assert ati["date"] == "2026-08-01"
    assert ati["aiscore"] == 7
    assert ati["fundamental"] == 5
    assert ati["technical"] == 8
    assert ati["sector"] == "industrials"
    # Confirmed absent from a real response -- must not be fabricated.
    assert "rank" not in ati
    assert "expected_return" not in ati
    assert "direction" not in ati

    qqq = by_ticker["QQQ"]
    assert qqq["focus"] == "large-cap"
    assert qqq["aum"] == 452329730000


def test_extract_trade_idea_items_returns_empty_list_for_a_zero_result_envelope():
    # A validly-shaped response with zero snapshot-date groups (e.g. a
    # narrow filter combination matching nothing) must be [] , not an error.
    empty_envelope = {"total": 0, "limit": 100, "offset": 0}
    assert _extract_trade_idea_items(empty_envelope) == []


def test_get_trade_ideas_end_to_end_with_the_real_response_shape():
    # Full get_trade_ideas() call (pagination + extraction) against the
    # exact real shape -- total=318/limit=100 in the real payload doesn't
    # drive pagination directly (only the per-page item COUNT vs `limit`
    # does); with only 3 items on a limit=100 page, this is correctly
    # treated as a short (final) page.
    session = _FakeTradeIdeasSession({0: REAL_TRADE_IDEAS_RESPONSE})
    client = DanelfinClient(api_key="secret", session=session)
    ideas = client.get_trade_ideas(limit=100)

    assert len(session.requests) == 1  # stopped after the one short page
    assert {i["ticker"] for i in ideas} == {"ATI", "HWM", "QQQ"}


def test_get_trade_ideas_raises_clearly_on_unrecognized_response_shape():
    session = _FakeTradeIdeasSession({0: []})
    session._pages = {}  # force an unrecognized payload below instead

    class _WeirdSession(_FakeTradeIdeasSession):
        def get(self, url, headers=None, params=None, timeout=None):
            self.requests.append((url, headers, params))
            return _FakeResponse({"totally": "unexpected"})

    client = DanelfinClient(api_key="secret", session=_WeirdSession({}))
    with pytest.raises(RuntimeError, match="unexpected Trade Ideas response shape"):
        client.get_trade_ideas()


def test_get_trade_ideas_propagates_a_request_failure():
    session = _FakeTradeIdeasSession({}, raise_at_offset={0: RuntimeError("simulated network failure")})
    client = DanelfinClient(api_key="secret", session=session)
    with pytest.raises(RuntimeError, match="simulated network failure"):
        client.get_trade_ideas()


# --- 429 rate-limit handling --------------------------------------------
# LIVE-CONFIRMED bug: a real account's SECOND back-to-back pagination
# request (offset=100, right after a successful offset=0) got a 429. The
# original implementation let that HTTPError propagate out of the whole
# pagination loop, discarding the already-fetched first page and reporting
# "0 Trade Ideas found" even though 100 valid records had been fetched.
# These tests lock in the fix: retry once on a 429, and if a later page
# still fails, return what was already fetched instead of raising.

class _FakeResponseWithStatus(_FakeResponse):
    def __init__(self, payload, status_code=200, headers=None):
        super().__init__(payload)
        self.status_code = status_code
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} Client Error", response=self)


class _RateLimitedThenRecoversSession:
    """Offset 0 always succeeds. Offset `flaky_offset` returns a 429 the
    first `fail_times` times it's requested, then succeeds -- lets a test
    assert get_trade_ideas() retries once on a 429 and recovers within the
    SAME page rather than treating it as a later-page failure."""

    def __init__(self, pages: dict, flaky_offset: int, fail_times: int = 1, retry_after: str | None = None):
        self._pages = pages
        self._flaky_offset = flaky_offset
        self._fail_times = fail_times
        self._retry_after = retry_after
        self._calls_at_flaky_offset = 0
        self.requests = []

    def get(self, url, headers=None, params=None, timeout=None):
        offset = params["offset"]
        self.requests.append((url, dict(headers or {}), dict(params or {})))
        if offset == self._flaky_offset and self._calls_at_flaky_offset < self._fail_times:
            self._calls_at_flaky_offset += 1
            headers_out = {"Retry-After": self._retry_after} if self._retry_after else {}
            return _FakeResponseWithStatus({}, status_code=429, headers=headers_out)
        return _FakeResponseWithStatus(self._pages.get(offset, []), status_code=200)


class _PersistentlyFailingPageSession:
    """Offset 0 always succeeds. `fail_offset` always fails (every call,
    including retries) -- lets a test assert that a later page which never
    recovers still returns the earlier page's results with `.partial_error`
    set, rather than raising and losing them."""

    def __init__(self, pages: dict, fail_offset: int, error: Exception | None = None):
        self._pages = pages
        self._fail_offset = fail_offset
        self._error = error
        self.requests = []

    def get(self, url, headers=None, params=None, timeout=None):
        offset = params["offset"]
        self.requests.append((url, dict(headers or {}), dict(params or {})))
        if offset == self._fail_offset:
            if self._error is not None:
                raise self._error
            return _FakeResponseWithStatus({}, status_code=429)
        return _FakeResponseWithStatus(self._pages.get(offset, []), status_code=200)


def test_get_trade_ideas_retries_once_on_a_429_and_recovers(monkeypatch):
    monkeypatch.setattr("src.ingestion.danelfin.time.sleep", lambda s: None)
    session = _RateLimitedThenRecoversSession(
        {0: [{"ticker": "A"}] * 100, 100: [{"ticker": "B"}]}, flaky_offset=100, fail_times=1,
    )
    client = DanelfinClient(api_key="secret", session=session)
    ideas = client.get_trade_ideas(limit=100)

    assert [i["ticker"] for i in ideas] == ["A"] * 100 + ["B"]
    assert ideas.partial_error is None
    # offset=100 was requested twice (429, then a successful retry).
    assert [r[2]["offset"] for r in session.requests] == [0, 100, 100]


def test_get_trade_ideas_honors_retry_after_header(monkeypatch):
    slept = []
    monkeypatch.setattr("src.ingestion.danelfin.time.sleep", lambda s: slept.append(s))
    session = _RateLimitedThenRecoversSession(
        {0: [{"ticker": "A"}] * 100, 100: [{"ticker": "B"}]},
        flaky_offset=100, fail_times=1, retry_after="7",
    )
    client = DanelfinClient(api_key="secret", session=session)
    client.get_trade_ideas(limit=100)

    assert 7.0 in slept


def test_get_trade_ideas_preserves_earlier_pages_when_a_later_page_429s(monkeypatch):
    # This is the exact reported bug: page 1 (offset=0) succeeds with a
    # full page, page 2 (offset=100) 429s even after the one retry -- the
    # already-fetched page-1 items must come back, not be discarded.
    monkeypatch.setattr("src.ingestion.danelfin.time.sleep", lambda s: None)
    page_one = [{"ticker": f"T{i}"} for i in range(100)]
    session = _PersistentlyFailingPageSession({0: page_one}, fail_offset=100)
    client = DanelfinClient(api_key="secret", session=session)
    ideas = client.get_trade_ideas(limit=100)

    assert len(ideas) == 100
    assert [i["ticker"] for i in ideas] == [f"T{i}" for i in range(100)]
    assert ideas.partial_error is not None
    assert "offset=100" in ideas.partial_error


def test_get_trade_ideas_preserves_earlier_pages_on_a_non_429_later_page_failure(monkeypatch):
    # Same principle, but the later-page failure isn't an HTTP 429 at all
    # (e.g. a plain network error) -- still must not discard page 1.
    monkeypatch.setattr("src.ingestion.danelfin.time.sleep", lambda s: None)
    page_one = [{"ticker": "A"}] * 100
    session = _PersistentlyFailingPageSession(
        {0: page_one}, fail_offset=100, error=RuntimeError("simulated network failure"),
    )
    client = DanelfinClient(api_key="secret", session=session)
    ideas = client.get_trade_ideas(limit=100)

    assert len(ideas) == 100
    assert ideas.partial_error is not None
    assert "simulated network failure" in ideas.partial_error


def test_get_trade_ideas_still_raises_when_the_very_first_page_429s(monkeypatch):
    # No earlier page exists to salvage -- this must still surface as a
    # hard failure (matches test_get_trade_ideas_propagates_a_request_failure's
    # existing "first page fails -> raise" contract), not an empty partial result.
    monkeypatch.setattr("src.ingestion.danelfin.time.sleep", lambda s: None)
    session = _PersistentlyFailingPageSession({}, fail_offset=0)
    client = DanelfinClient(api_key="secret", session=session)
    with pytest.raises(requests.HTTPError):
        client.get_trade_ideas()


def test_get_trade_ideas_returns_a_plain_list_compatible_result_when_not_truncated():
    # TradeIdeasPartialResult must behave exactly like a plain list for the
    # common (non-truncated) case, so every existing caller/test comparing
    # it with == [...] or iterating it keeps working unchanged.
    session = _FakeTradeIdeasSession({0: [{"ticker": "ATI"}]})
    client = DanelfinClient(api_key="secret", session=session)
    ideas = client.get_trade_ideas(limit=50)
    assert ideas == [{"ticker": "ATI"}]
    assert ideas.partial_error is None
