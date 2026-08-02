"""
Danelfin client -- the eligibility-filter data source (Section 1: Danelfin is
used ONLY as an eligibility filter, never scored, never counted as evidence).

Requires DANELFIN_API_KEY in the environment. Not exercised by the test suite
or the ATI demo. Per spec Section 14, "Danelfin/eligibility-source API field
availability and free-tier limits must be reverified before the ingestion
pipeline is built" -- the exact response shape below is a best-effort
placeholder based on Danelfin's public documentation as of this writing and
should be confirmed against a live account before real ingestion is wired up.
"""
from __future__ import annotations

import os
from datetime import date
from typing import Optional

import requests

BASE_URL = "https://apirest.danelfin.com"


class DanelfinClient:
    def __init__(self, api_key: Optional[str] = None, session: Optional[requests.Session] = None):
        self.api_key = api_key or os.environ.get("DANELFIN_API_KEY")
        if not self.api_key:
            raise RuntimeError(
                "DANELFIN_API_KEY is not set. Export it in the environment or pass "
                "api_key= explicitly before using DanelfinClient."
            )
        self.session = session or requests.Session()

    def get_candidates(self, tickers: list[str], as_of: Optional[date] = None) -> list[dict]:
        """Returns eligibility-filter rows for the given watchlist tickers:
        [{ticker, ai_score, technical_score, fundamental_score, rank, ...}].
        Danelfin scores are used ONLY to decide which stocks enter the
        candidates table -- never stored as an Earnings/Market/Context score
        and never a direct input to decide()."""
        headers = {"x-api-key": self.api_key}
        out = []
        for ticker in tickers:
            resp = self.session.get(f"{BASE_URL}/ranking", headers=headers, params={"ticker": ticker}, timeout=30)
            resp.raise_for_status()
            out.append(resp.json())
        return out
