"""
PriceDataSource: the interface the entry-price job and outcome-tracking job use
to fetch OHLCV opens/closes for a ticker on a specific trading date.

Design note (documented gap in the literal spec schema): `price_signals`, as
specified in codex_implementation_prompt.md, stores only `close` (plus
technicals derived from closes) -- it has no `open` column, yet Section 7
requires entry prices to be OPENS. Rather than silently bolting an `open`
column onto the frozen `price_signals` schema (which exists to drive
score_market(), not entry/exit pricing) or inventing a new persisted table not
in the spec, this prototype resolves the gap by having the entry-price and
outcome-tracking jobs pull opens/closes directly from a pluggable
PriceDataSource at the moment they're needed. `episode_entries` (opens) and
`recommendation_outcomes` (closes) -- both spec tables -- are exactly where
those fetched values get durably recorded, so nothing needed for later
analysis is lost; there's just no separate raw-OHLCV cache table.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import date
from typing import Optional


class PriceDataSource(ABC):
    @abstractmethod
    def get_open(self, ticker: str, on_date: date) -> Optional[float]:
        """Returns the opening price for `ticker` on `on_date`, or None if not
        yet available (e.g. the session hasn't happened, or the upstream API
        hasn't published it yet)."""
        raise NotImplementedError

    @abstractmethod
    def get_close(self, ticker: str, on_date: date) -> Optional[float]:
        """Returns the closing price for `ticker` on `on_date`, or None if not
        yet available."""
        raise NotImplementedError


class InMemoryPriceSource(PriceDataSource):
    """Simple dict-backed PriceDataSource for tests and the ATI demo. Keys are
    (ticker, date)."""

    def __init__(self):
        self._opens: dict[tuple[str, date], float] = {}
        self._closes: dict[tuple[str, date], float] = {}

    def set_open(self, ticker: str, on_date: date, price: float) -> None:
        self._opens[(ticker, on_date)] = price

    def set_close(self, ticker: str, on_date: date, price: float) -> None:
        self._closes[(ticker, on_date)] = price

    def get_open(self, ticker: str, on_date: date) -> Optional[float]:
        return self._opens.get((ticker, on_date))

    def get_close(self, ticker: str, on_date: date) -> Optional[float]:
        return self._closes.get((ticker, on_date))
