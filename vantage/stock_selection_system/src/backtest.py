"""Cache-first, point-in-time Danelfin ranking backtest prototype.

This module deliberately backtests a documented rule (top N historical ranking
stocks), not Danelfin's proprietary historical Best Stocks list. Provider
responses are cached in a separate SQLite file so reruns do not repeat calls.
"""
from __future__ import annotations

import json
import logging
import sqlite3
import uuid
from calendar import monthrange
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Callable

from .ingestion.danelfin import DanelfinClient
from .ingestion.eodhd import EODHDClient, provider_symbol
from .trading_calendar import TradingCalendar, default_calendar

DEFAULT_BACKTEST_DB = Path(__file__).resolve().parent.parent / "backtest" / "backtest.db"
META_KEYS = {"total", "limit", "offset", "count", "page", "has_more", "next_offset"}
logger = logging.getLogger(__name__)


class BacktestCache:
    def __init__(self, path: str | Path = DEFAULT_BACKTEST_DB):
        self.path = Path(path or DEFAULT_BACKTEST_DB)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(self.path) as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS provider_cache (cache_key TEXT PRIMARY KEY, provider TEXT NOT NULL, request_json TEXT NOT NULL, response_json TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
            conn.execute("CREATE TABLE IF NOT EXISTS backtest_runs (run_id TEXT PRIMARY KEY, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, config_json TEXT NOT NULL, result_json TEXT NOT NULL)")

    def get_or_fetch(self, key: str, provider: str, request: dict, fetch: Callable[[], Any]) -> tuple[Any, bool]:
        with sqlite3.connect(self.path) as conn:
            row = conn.execute("SELECT response_json FROM provider_cache WHERE cache_key = ?", (key,)).fetchone()
        if row:
            return json.loads(row[0]), True
        payload = fetch()
        with sqlite3.connect(self.path) as conn:
            conn.execute("INSERT OR REPLACE INTO provider_cache (cache_key, provider, request_json, response_json) VALUES (?, ?, ?, ?)", (key, provider, json.dumps(request, sort_keys=True), json.dumps(payload, default=str)))
        return payload, False

    def save_run(self, run_id: str, config: dict, result: dict) -> None:
        with sqlite3.connect(self.path) as conn:
            conn.execute("INSERT OR REPLACE INTO backtest_runs (run_id, config_json, result_json) VALUES (?, ?, ?)", (run_id, json.dumps(config, sort_keys=True), json.dumps(result, default=str)))


def _ranking_rows(payload: dict) -> list[dict]:
    rows: list[dict] = []
    for snapshot_date, tickers in payload.items():
        if snapshot_date in META_KEYS or not isinstance(tickers, dict):
            continue
        for ticker, values in tickers.items():
            if isinstance(values, dict):
                rows.append({"ticker": str(ticker).upper(), "date": str(snapshot_date), **values})
    return rows


def _number(value: Any) -> float | None:
    try:
        return None if value is None else float(value)
    except (TypeError, ValueError):
        return None


def _date(value: Any) -> date | None:
    try:
        return date.fromisoformat(str(value)[:10])
    except (TypeError, ValueError):
        return None


def _bars(payload: Any) -> dict[date, dict]:
    rows = payload if isinstance(payload, list) else payload.get("data", []) if isinstance(payload, dict) else []
    out = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        d = _date(row.get("date"))
        if d and row.get("open") is not None:
            out[d] = {key: _number(row.get(key)) for key in ("open", "close", "adjusted_close", "volume")}
    return out


def _action_rows(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        return [row for row in payload if isinstance(row, dict)]
    if isinstance(payload, dict):
        return [row for row in payload.get("data", []) if isinstance(row, dict)]
    return []


def _split_ratio(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    if ":" in text:
        left, right = text.split(":", 1)
        try:
            return float(left) / float(right)
        except ValueError:
            return None
    return _number(text)


def _total_return(bars: dict[date, dict], splits: list[dict], dividends: list[dict], entry: date, exit_date: date) -> tuple[float | None, list[str]]:
    entry_bar, exit_bar = bars.get(entry), bars.get(exit_date)
    warnings: list[str] = []
    if not entry_bar or not exit_bar or entry_bar.get("open") is None or exit_bar.get("open") is None:
        return None, [f"missing raw open for {entry} or {exit_date}"]
    shares = 1.0
    cash = 0.0
    events = []
    for row in splits:
        d = _date(row.get("date"))
        ratio = _split_ratio(row.get("split") or row.get("ratio"))
        if d and entry < d <= exit_date and ratio and ratio > 0:
            events.append((d, 0, ratio, row))
    for row in dividends:
        d = _date(row.get("date") or row.get("ex_date") or row.get("exDividendDate"))
        value = _number(row.get("value") or row.get("unadjustedValue") or row.get("dividend"))
        if d and entry < d <= exit_date and value is not None:
            events.append((d, 1, value, row))
    for _, kind, value, _ in sorted(events, key=lambda event: (event[0], event[1])):
        if kind == 0:
            shares *= value
        else:
            cash += shares * value
    entry_value = float(entry_bar["open"])
    exit_value = float(exit_bar["open"]) * shares + cash
    return exit_value / entry_value - 1.0, warnings


def _monthly_dates(start: date, end: date, calendar: TradingCalendar) -> list[date]:
    sessions = calendar.sessions_in_window(start, end)
    selected: list[date] = []
    seen: set[tuple[int, int]] = set()
    for session in sessions:
        key = (session.year, session.month)
        if key not in seen:
            selected.append(session)
            seen.add(key)
    return selected


def run_backtest(start_date: date, end_date: date, top_n: int = 10, cache_path: str | Path = DEFAULT_BACKTEST_DB, danelfin: DanelfinClient | None = None, eodhd: EODHDClient | None = None, calendar: TradingCalendar = default_calendar, progress: Callable[[dict], None] | None = None) -> dict:
    if start_date >= end_date:
        raise ValueError("start_date must be before end_date")
    if not 1 <= top_n <= 100:
        raise ValueError("top_n must be between 1 and 100")
    cache = BacktestCache(cache_path)
    danelfin = danelfin or DanelfinClient()
    eodhd = eodhd or EODHDClient()
    snapshot_dates = _monthly_dates(start_date, end_date, calendar)
    if len(snapshot_dates) < 2:
        raise ValueError("The selected range must contain at least two trading months")

    def report(**values: Any) -> None:
        if progress:
            progress(values)

    cache_hits = 0
    cache_misses = 0
    warnings: list[str] = ["Score publication time is not documented; scores are assumed tradable at the next session open.", "This is a historical ranking backtest, not a reconstruction of Danelfin's proprietary Best Stocks Strategy."]
    selections: list[dict] = []
    report(phase="rankings", current=0, total=len(snapshot_dates), message="Preparing historical Danelfin rankings")
    for snapshot_date in snapshot_dates:
        key = f"danelfin:ranking:{snapshot_date.isoformat()}:us"
        logger.info("Backtest ranking snapshot requested date=%s", snapshot_date)
        payload, hit = cache.get_or_fetch(key, "danelfin", {"endpoint": "/ranking", "date": snapshot_date.isoformat()}, lambda d=snapshot_date: danelfin.get_ranking(d))
        logger.info("Backtest ranking snapshot loaded date=%s cache_hit=%s", snapshot_date, hit)
        cache_hits += int(hit)
        cache_misses += int(not hit)
        rows = [row for row in _ranking_rows(payload) if row.get("aiscore") is not None]
        rows.sort(key=lambda row: (-float(row["aiscore"]), row["ticker"]))
        selections.append({"score_date": snapshot_date, "entry_date": calendar.add_trading_days(snapshot_date, 1), "stocks": rows[:top_n]})
        report(phase="rankings", current=len(selections), total=len(snapshot_dates), current_date=snapshot_date.isoformat(), cache_hits=cache_hits, cache_misses=cache_misses, message=f"Loaded ranking for {snapshot_date.isoformat()}")

    # The benchmark is optional; selected ticker prices are sufficient for an
    # absolute-return backtest.
    all_tickers = {row["ticker"] for selection in selections for row in selection["stocks"]}
    price_data: dict[str, dict] = {}
    excluded_tickers: dict[str, str] = {}
    report(phase="prices", current=0, total=len(all_tickers), cache_hits=cache_hits, cache_misses=cache_misses, message="Preparing EODHD price history")
    for index, ticker in enumerate(sorted(all_tickers)):
        symbol = provider_symbol(ticker)
        try:
            request = {"endpoint": f"/eod/{symbol}", "from": start_date.isoformat(), "to": end_date.isoformat()}
            payload, hit = cache.get_or_fetch(f"eodhd:eod:{symbol}:{start_date}:{end_date}", "eodhd", request, lambda s=symbol: eodhd.get_eod(s, start_date, end_date))
            cache_hits += int(hit)
            cache_misses += int(not hit)
            split_payload, hit = cache.get_or_fetch(f"eodhd:splits:{symbol}:{start_date}:{end_date}", "eodhd", {"endpoint": f"/splits/{symbol}", "from": start_date.isoformat(), "to": end_date.isoformat()}, lambda s=symbol: eodhd.get_splits(s, start_date, end_date))
            cache_hits += int(hit)
            cache_misses += int(not hit)
            div_payload, hit = cache.get_or_fetch(f"eodhd:div:{symbol}:{start_date}:{end_date}", "eodhd", {"endpoint": f"/div/{symbol}", "from": start_date.isoformat(), "to": end_date.isoformat()}, lambda s=symbol: eodhd.get_dividends(s, start_date, end_date))
            cache_hits += int(hit)
            cache_misses += int(not hit)
            price_data[ticker] = {"bars": _bars(payload), "splits": _action_rows(split_payload), "dividends": _action_rows(div_payload)}
        except Exception as exc:  # noqa: BLE001 - one bad symbol must not abort the whole backtest
            excluded_tickers[ticker] = str(exc)
            warnings.append(f"{ticker}: excluded from backtest, EODHD price fetch failed ({exc})")
            logger.warning("Backtest price fetch failed ticker=%s symbol=%s error=%s", ticker, symbol, exc)
        report(phase="prices", current=index + 1, total=len(all_tickers), ticker=ticker, cache_hits=cache_hits, cache_misses=cache_misses, message=f"Loaded price history for {ticker}" if ticker not in excluded_tickers else f"Excluded {ticker} (price fetch failed)")

    benchmark_available = "SPY" in price_data
    if not benchmark_available:
        warnings.append("SPY benchmark was skipped; only absolute portfolio returns are available.")

    trades: list[dict] = []
    portfolio_returns: list[float] = []
    benchmark_returns: list[float] = []
    for index, selection in enumerate(selections[:-1]):
        entry_date = selection["entry_date"]
        exit_date = selections[index + 1]["entry_date"]
        if exit_date > end_date:
            continue
        stock_returns = []
        for row in selection["stocks"]:
            ticker = row["ticker"]
            if ticker not in price_data:
                continue  # already recorded as a warning when the price fetch failed
            result, trade_warnings = _total_return(price_data[ticker]["bars"], price_data[ticker]["splits"], price_data[ticker]["dividends"], entry_date, exit_date)
            if result is None:
                warnings.extend(f"{ticker}: {warning}" for warning in trade_warnings)
                continue
            stock_returns.append(result)
            trades.append({"ticker": ticker, "score_date": selection["score_date"].isoformat(), "entry_date": entry_date.isoformat(), "exit_date": exit_date.isoformat(), "ai_score": row.get("aiscore"), "return": result})
        benchmark = None
        if benchmark_available:
            benchmark, _benchmark_warnings = _total_return(price_data["SPY"]["bars"], price_data["SPY"]["splits"], price_data["SPY"]["dividends"], entry_date, exit_date)
        if stock_returns:
            portfolio = sum(stock_returns) / len(stock_returns)
            portfolio_returns.append(portfolio)
            if benchmark is not None:
                benchmark_returns.append(benchmark)

    def compound(values: list[float]) -> float:
        total = 1.0
        for value in values:
            total *= 1 + value
        return total - 1

    portfolio_return = compound(portfolio_returns)
    spy_return = compound(benchmark_returns) if benchmark_available and len(benchmark_returns) == len(portfolio_returns) else None
    result = {"run_id": str(uuid.uuid4()), "config": {"start_date": start_date.isoformat(), "end_date": end_date.isoformat(), "top_n": top_n, "rebalance": "monthly", "entry": "first session after score date", "selection": "top N AI Score from /ranking"}, "summary": {"rebalance_periods": len(portfolio_returns), "trades": len(trades), "portfolio_return": portfolio_return, "spy_return": spy_return, "excess_return": portfolio_return - spy_return if spy_return is not None else None}, "trades": trades, "warnings": sorted(set(warnings)), "cache": {"hits": cache_hits, "misses": cache_misses}}
    cache.save_run(result["run_id"], result["config"], result)
    report(phase="complete", current=1, total=1, cache_hits=cache_hits, cache_misses=cache_misses, message="Backtest complete")
    return result
