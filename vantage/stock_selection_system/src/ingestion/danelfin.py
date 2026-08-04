"""
Danelfin client -- the eligibility-filter data source (Section 1: Danelfin is
used ONLY as an eligibility filter, never scored, never counted as evidence).

Requires DANELFIN_API_KEY in the environment. Per spec Section 14,
"Danelfin/eligibility-source API field
availability and free-tier limits must be reverified before the ingestion
pipeline is built" -- get_candidate()/get_candidates()' response shape below
remains a best-effort placeholder, unverified live (this environment's
sandbox cannot reach apirest.danelfin.com at all).

get_trade_ideas()'s response shape, by contrast, IS live-confirmed (a real
account's response was pasted back after an initial defensive-guess version
of the parser failed on it) -- see _extract_trade_idea_items() below for the
actual shape and TRADE_IDEAS_PAGINATION_META_KEYS/module-level notes for
what changed from the original guess.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import date
from typing import Optional

import requests
from dotenv import load_dotenv

load_dotenv()  # picks up DANELFIN_API_KEY from a .env file if present; a
                # real exported environment variable always takes precedence
                # since load_dotenv() does not override existing env vars.

BASE_URL = "https://apirest.danelfin.com"
TRADE_IDEAS_PATH = "/v3/trade-ideas"
BEST_STOCKS_PATH = "/v3/beststocks"
RANKING_PATH = "/ranking"
RANKING_MIN_REQUEST_INTERVAL_SECONDS = 6.1
RANKING_RATE_LIMIT_RETRY_DEFAULT_WAIT_SECONDS = 6.5

logger = logging.getLogger(__name__)

# Common wrapper keys tried, as a FALLBACK, when a Trade Ideas response is a
# dict but doesn't match the live-confirmed shape below (e.g. a future API
# version, or a different filter combination shaping the response
# differently) -- kept permissive rather than committing to only one shape.
_TRADE_IDEAS_LIST_KEYS = ("data", "items", "results", "trade_ideas", "tradeIdeas")

# Top-level keys in a Trade Ideas response that are pagination/response
# metadata, NOT a snapshot-date group of {ticker: metrics} -- confirmed live:
# a real response looks like {"2026-08-01": {"CGBL": {...}, "HWM": {...},
# ...}, "total": 318, "limit": 100, "offset": 0}. Every top-level key that
# ISN'T one of these is treated as a snapshot date whose value is a
# {ticker: metrics} dict.
TRADE_IDEAS_PAGINATION_META_KEYS = {"total", "limit", "offset", "count", "page", "has_more", "next_offset"}

DEFAULT_TRADE_IDEAS_PAGE_SIZE = 100
DEFAULT_TRADE_IDEAS_MAX_PAGES = 20  # safety cap against a misbehaving/looping paginated response

# LIVE-CONFIRMED: a real account got a 429 (rate limited) on the SECOND
# back-to-back pagination request (offset=100, immediately after a
# successful offset=0). A small delay between pages is a defensive
# mitigation, not a documented/verified Danelfin limit (this sandbox cannot
# reach apirest.danelfin.com to check published limits) -- tune via
# get_trade_ideas(request_delay_seconds=...) if it's still too aggressive
# or unnecessarily slow for your account's actual limit.
DEFAULT_TRADE_IDEAS_REQUEST_DELAY_SECONDS = 0.5
# On an HTTP 429 specifically, retry the SAME page once after waiting
# (honoring a Retry-After header if Danelfin sends one) before giving up on
# that page -- a rate limit is transient, so one retry recovers the common
# case instead of truncating the fetch every time pagination is used.
TRADE_IDEAS_RATE_LIMIT_RETRY_DEFAULT_WAIT_SECONDS = 2.0


class TradeIdeasPartialResult(list):
    """A list[dict] of trade-idea records, exactly like get_trade_ideas()
    has always returned -- equality, iteration, indexing, len() all behave
    identically to a plain list, so every existing caller/test is
    unaffected. The one addition is `.partial_error`: set to a message when
    pagination had to stop early because a LATER page failed (e.g. Danelfin
    rate-limiting back-to-back pagination requests with a 429), so the
    caller can tell "here are N results, but there may have been more" from
    "here are all the results" -- rather than the failure silently
    discarding every page already fetched successfully (see
    get_trade_ideas() below and candidate_selection.fetch_trade_ideas_candidates(),
    which surfaces this as a warning instead of losing the data)."""

    def __init__(self, items=None, partial_error: Optional[str] = None):
        super().__init__(items or [])
        self.partial_error = partial_error


def _extract_trade_idea_items(payload) -> list[dict]:
    """Pulls a flat list of individual trade-idea records out of one page's
    response body. Tries, in order:

      1. A bare list (some other endpoint/version might just return one).
      2. A dict wrapping a list under one of _TRADE_IDEAS_LIST_KEYS.
      3. THE LIVE-CONFIRMED SHAPE: a dict keyed by snapshot date (e.g.
         "2026-08-01"), each value itself a dict keyed by ticker (e.g.
         "ATI"), each of THOSE values the metrics object (aiscore,
         fundamental, technical, sentiment, low_risk, sector/industry or
         focus/aum, win_rate_*, avg_perf_*, avg_alpha_*, etc. -- NOT
         'ai_score'/'technical_score'/'fundamental_score' with underscores,
         and there is no 'rank', 'expected_return', or 'direction' field at
         all in a real response, despite those being plausible-sounding
         names). Flattened into one dict per ticker, with `ticker` and
         `date` (the snapshot date this ticker appeared under) injected
         onto each -- downstream normalization
         (candidate_selection.fetch_trade_ideas_candidates) reads `ticker`
         and the score fields from there like any other shape, and the
         extra fields (win_rate_1y, sector, aum, ...) ride along into
         candidates.raw_source_data for traceability even though they
         aren't individually normalized into their own columns.
      4. If the payload is a dict containing pagination-metadata keys (see
         TRADE_IDEAS_PAGINATION_META_KEYS) but no snapshot-date groups, it's
         a validly-shaped response with zero results for this page/filter
         combination -- returns [], not an error.

    Raises clearly (rather than silently returning []) only if NONE of the
    above match -- a caller treating that as "zero ideas" would be
    indistinguishable from a real empty result, which is exactly the kind
    of silent failure this project has tried to avoid elsewhere (see
    alpha_vantage.py's "Information" key fix)."""
    if isinstance(payload, list):
        return payload

    if isinstance(payload, dict):
        for key in _TRADE_IDEAS_LIST_KEYS:
            if key in payload and isinstance(payload[key], list):
                return payload[key]

        date_groups = {
            k: v for k, v in payload.items()
            if k not in TRADE_IDEAS_PAGINATION_META_KEYS and isinstance(v, dict)
        }
        if date_groups:
            items: list[dict] = []
            for snapshot_date, tickers_map in date_groups.items():
                for ticker, metrics in tickers_map.items():
                    if isinstance(metrics, dict):
                        items.append({**metrics, "ticker": ticker, "date": snapshot_date})
                    else:
                        items.append({"ticker": ticker, "date": snapshot_date})
            return items

        if TRADE_IDEAS_PAGINATION_META_KEYS & payload.keys():
            return []  # valid envelope, zero results for this page/filter

    raise RuntimeError(
        f"unexpected Trade Ideas response shape (no list of ideas found under "
        f"{_TRADE_IDEAS_LIST_KEYS!r}, no snapshot-date groups, and no recognized "
        f"pagination envelope either): {payload!r}"
    )


def _extract_best_stocks_items(payload) -> list[dict]:
    """Flatten the documented {snapshot_date: {ticker: metrics}} shape."""
    if not isinstance(payload, dict):
        raise RuntimeError("unexpected Best Stocks response shape: expected an object")
    items: list[dict] = []
    for snapshot_date, tickers in payload.items():
        if not isinstance(tickers, dict):
            continue
        for ticker, metrics in tickers.items():
            if isinstance(metrics, dict):
                items.append({**metrics, "ticker": ticker, "date": snapshot_date})
    if not items:
        raise RuntimeError("Best Stocks response contained no snapshot records")
    return items


class DanelfinClient:
    def __init__(self, api_key: Optional[str] = None, session: Optional[requests.Session] = None):
        self.api_key = api_key or os.environ.get("DANELFIN_API_KEY")
        if not self.api_key:
            raise RuntimeError(
                "DANELFIN_API_KEY is not set. Export it in the environment or pass "
                "api_key= explicitly before using DanelfinClient."
            )
        self.session = session or requests.Session()
        self._last_ranking_request_at = 0.0

    def get_candidate(self, ticker: str, as_of: Optional[date] = None) -> dict:
        """Returns the eligibility-filter row for a SINGLE ticker:
        {ticker, ai_score, technical_score, fundamental_score, rank, ...}.
        One isolated HTTP call -- lets a caller (e.g.
        src/ingestion/candidate_selection.py's select_candidates()) catch a
        single ticker's failure without losing results already fetched for
        other tickers, unlike get_candidates() below (which fails the whole
        batch on the first error).

        CAUTION: this environment could not reach apirest.danelfin.com to
        verify the real response shape (network-restricted sandbox), so
        `resp.json()` is returned close to as-is -- the exact key names
        (ai_score vs aiScore, a possibly-nested "scores" object, etc.) are
        unverified against a live account. `ticker` is force-set on the
        returned row from the request itself (not trusted from the
        response) since that much is guaranteed correct regardless of
        response shape."""
        headers = {"x-api-key": self.api_key}
        resp = self.session.get(f"{BASE_URL}/ranking", headers=headers, params={"ticker": ticker}, timeout=30)
        resp.raise_for_status()
        row = resp.json()
        if isinstance(row, dict):
            row = {**row, "ticker": ticker}
        return row

    def get_trade_ideas(
        self,
        market: Optional[str] = None,
        direction: Optional[str] = None,
        asset_type: Optional[str] = None,
        aiscore: Optional[float] = None,
        fundamental: Optional[float] = None,
        technical: Optional[float] = None,
        sentiment: Optional[float] = None,
        sector: Optional[str] = None,
        industry: Optional[str] = None,
        market_cap: Optional[str] = None,
        limit: int = DEFAULT_TRADE_IDEAS_PAGE_SIZE,
        offset: int = 0,
        max_pages: int = DEFAULT_TRADE_IDEAS_MAX_PAGES,
        request_delay_seconds: float = DEFAULT_TRADE_IDEAS_REQUEST_DELAY_SECONDS,
    ) -> "TradeIdeasPartialResult":
        """Discovers Danelfin Trade Ideas -- NO ticker required, unlike
        get_candidate()/get_candidates() above, which only ever evaluate
        tickers you already supply. This is what actually lets the system
        discover candidates on its own instead of requiring an operator to
        type ticker symbols in first.

        GET https://apirest.danelfin.com/v3/trade-ideas, authenticated via
        the `x-api-key` header (same as every other call in this client).
        All filter params are optional and omitted from the request
        entirely when None -- only non-None ones are sent as query params
        (`aiscore`, `fundamental`, `technical`, `sentiment`, `market_cap`
        etc. use whatever raw value/string you pass through; this client
        doesn't validate or coerce them, since the exact accepted
        value/range per filter is unverified here, see module docstring).

        Pagination: fetches pages of up to `limit` items starting at
        `offset`, incrementing by `limit` each request, until a page comes
        back with fewer than `limit` items (last page) or `max_pages` pages
        have been fetched (a safety cap against an API that never signals
        "last page" and would otherwise loop forever) -- whichever comes
        first. Returns the concatenated, flattened list of trade-idea
        records across every page fetched; treat this as the latest
        available Trade Ideas snapshot as of whenever this call runs, not a
        historical/dated query (Danelfin Trade Ideas has no as_of parameter
        in the filters above).

        Response shape is LIVE-CONFIRMED (see _extract_trade_idea_items()):
        a real response is `{"<snapshot_date>": {"<TICKER>": {aiscore,
        fundamental, technical, sentiment, ...}, ...}, "total", "limit",
        "offset"}` -- note `aiscore`/`fundamental`/`technical` (no
        `_score` suffix), and there is NO `rank`, `expected_return`, or
        `direction` field in a real response despite those being
        plausible-sounding names; candidate_selection.py's normalization
        leaves those columns NULL accordingly. Each returned dict has
        `ticker` and `date` (the snapshot date) injected on it.

        Raises (does not silently return []) only if a page's response
        doesn't look like any recognized shape at all -- an envelope with
        zero results (still shaped correctly) returns [] for that page, not
        an error. See _extract_trade_idea_items().

        Rate limits / partial pagination: LIVE-CONFIRMED, Danelfin can
        429 a back-to-back pagination request (a real account's SECOND
        request, at offset=100 immediately after a successful offset=0,
        got a 429). To handle this without losing already-fetched pages:
          - A small delay (`request_delay_seconds`) is inserted between
            page requests, as a defensive mitigation.
          - If a page request specifically 429s, it's retried ONCE after
            waiting (honoring a `Retry-After` response header if present,
            else TRADE_IDEAS_RATE_LIMIT_RETRY_DEFAULT_WAIT_SECONDS).
          - If a page fails (429-after-retry, or any other error) AFTER at
            least one earlier page was already fetched successfully,
            pagination stops there and the pages fetched so far are
            returned -- NOT discarded -- with `.partial_error` set on the
            returned TradeIdeasPartialResult describing what happened, so
            the caller can report the truncation instead of it being
            silently invisible (see candidate_selection.fetch_trade_ideas_candidates()).
          - If the very FIRST page fails, there is nothing to salvage --
            this still raises, exactly as before (unchanged, tested
            behavior for a total failure)."""
        base_filters = {
            "market": market, "direction": direction, "asset_type": asset_type,
            "aiscore": aiscore, "fundamental": fundamental, "technical": technical,
            "sentiment": sentiment, "sector": sector, "industry": industry, "market_cap": market_cap,
        }
        base_filters = {k: v for k, v in base_filters.items() if v is not None}
        headers = {"x-api-key": self.api_key}

        all_items: list[dict] = []
        current_offset = offset
        partial_error: Optional[str] = None

        for page_num in range(max_pages):
            params = {**base_filters, "limit": limit, "offset": current_offset}
            try:
                page_items = self._fetch_trade_ideas_page(headers, params)
            except Exception as exc:
                if not all_items:
                    raise  # nothing fetched yet at all -- a total failure
                partial_error = (
                    f"stopped after {page_num} page(s) ({len(all_items)} item(s) fetched) -- "
                    f"request for offset={current_offset} failed: {exc}"
                )
                break

            all_items.extend(page_items)
            if len(page_items) < limit:
                break  # short page -- no more results
            current_offset += limit
            if page_num + 1 < max_pages:
                time.sleep(request_delay_seconds)

        return TradeIdeasPartialResult(all_items, partial_error=partial_error)

    def get_best_stocks(self) -> list[dict]:
        """Return Danelfin's official 25-stock Best Stocks snapshot."""
        headers = {"x-api-key": self.api_key}
        resp = self.session.get(f"{BASE_URL}{BEST_STOCKS_PATH}", headers=headers, timeout=30)
        resp.raise_for_status()
        return _extract_best_stocks_items(resp.json())

    def get_ranking(
        self,
        snapshot_date: date,
        market: Optional[str] = None,
        request_delay_seconds: float = RANKING_MIN_REQUEST_INTERVAL_SECONDS,
    ) -> dict:
        """Return one historical ranking, paced to avoid provider 429s."""
        params = {"date": snapshot_date.isoformat()}
        if market:
            params["market"] = market
        headers = {"x-api-key": self.api_key}
        elapsed = time.monotonic() - self._last_ranking_request_at
        if request_delay_seconds > 0 and elapsed < request_delay_seconds:
            time.sleep(request_delay_seconds - elapsed)
        self._last_ranking_request_at = time.monotonic()
        resp = self.session.get(f"{BASE_URL}{RANKING_PATH}", headers=headers, params=params, timeout=30)
        if getattr(resp, "status_code", None) == 429:
            wait_seconds = RANKING_RATE_LIMIT_RETRY_DEFAULT_WAIT_SECONDS
            retry_after = (getattr(resp, "headers", None) or {}).get("Retry-After")
            if retry_after is not None:
                try:
                    wait_seconds = max(wait_seconds, float(retry_after))
                except (TypeError, ValueError):
                    pass
            logger.warning(
                "Danelfin historical ranking rate limited date=%s retry_after=%.1fs",
                snapshot_date,
                wait_seconds,
            )
            time.sleep(wait_seconds)
            self._last_ranking_request_at = time.monotonic()
            resp = self.session.get(f"{BASE_URL}{RANKING_PATH}", headers=headers, params=params, timeout=30)
        resp.raise_for_status()
        payload = resp.json()
        if not isinstance(payload, dict):
            raise RuntimeError("Danelfin ranking response was not an object")
        return payload

    def _fetch_trade_ideas_page(self, headers: dict, params: dict) -> list[dict]:
        """Fetches and parses one Trade Ideas page. On an HTTP 429
        specifically, retries the SAME request once after waiting (honoring
        a `Retry-After` header if Danelfin sends one), since a rate limit is
        transient and one retry recovers the common pagination case. Any
        other failure (or a second 429) propagates to the caller, which
        decides whether it's a total failure (no pages fetched yet) or a
        partial one (earlier pages already in hand) -- see get_trade_ideas()."""
        resp = self.session.get(f"{BASE_URL}{TRADE_IDEAS_PATH}", headers=headers, params=params, timeout=30)
        if getattr(resp, "status_code", None) == 429:
            wait_seconds = TRADE_IDEAS_RATE_LIMIT_RETRY_DEFAULT_WAIT_SECONDS
            retry_after = None
            if hasattr(resp, "headers"):
                retry_after = resp.headers.get("Retry-After")
            if retry_after is not None:
                try:
                    wait_seconds = float(retry_after)
                except (TypeError, ValueError):
                    pass
            time.sleep(wait_seconds)
            resp = self.session.get(f"{BASE_URL}{TRADE_IDEAS_PATH}", headers=headers, params=params, timeout=30)
        resp.raise_for_status()
        return _extract_trade_idea_items(resp.json())

    def get_candidates(self, tickers: list[str], as_of: Optional[date] = None) -> list[dict]:
        """Returns eligibility-filter rows for the given watchlist tickers by
        calling get_candidate() for each. Danelfin scores are used ONLY to
        decide which stocks enter the candidates table -- never stored as an
        Earnings/Market/Context score and never a direct input to decide().

        NOTE: unlike select_candidates() (src/ingestion/candidate_selection.py),
        this has NO per-ticker error isolation -- the first ticker's request
        exception aborts the whole batch, discarding any results already
        fetched. Kept as-is for src/ingestion/live.py's existing bundled
        ingest_candidates() (which already wraps the whole call in a
        batch-level try/except); prefer select_candidates() /
        get_candidate() directly for anything that needs per-ticker
        isolation, clear per-ticker errors, or success/skipped/failed
        accounting."""
        return [self.get_candidate(ticker, as_of=as_of) for ticker in tickers]
