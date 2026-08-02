#!/usr/bin/env python3
"""
Command-line entry point.

  python cli.py init-db [--db PATH]
      Creates schema.sql's tables/triggers (idempotent).

  python cli.py demo-ati [--db PATH] [--as-of YYYY-MM-DD] [--seed N]
      Runs the required first end-to-end test case on synthetic ATI data
      (no API keys needed) and prints the resulting report.

  python cli.py report --db PATH --episode-id ID
      Prints the human-readable report for an existing episode.

  python cli.py fetch-trade-ideas --db PATH --as-of YYYY-MM-DD [--market us]
                                   [--direction long] [--asset-type stock]
                                   [--limit 100]
      PRIMARY candidate discovery -- no tickers needed. Calls Danelfin
      Trade Ideas (GET /v3/trade-ideas) to discover eligible tickers on its
      own and upserts them into `candidates` (source='danelfin_trade_ideas').
      Requires DANELFIN_API_KEY. Danelfin is eligibility-only: this never
      touches Earnings/Market/Context/total scoring. Runs once,
      synchronously, only when you run this command -- no scheduler.

  python cli.py select-candidates --db PATH --tickers ATI,MSFT --as-of YYYY-MM-DD
      Evaluates ALREADY-KNOWN tickers against Danelfin's per-ticker ranking
      -- does not discover anything on its own (use fetch-trade-ideas for
      that). Upserts into `candidates`. Requires DANELFIN_API_KEY.
      Danelfin is eligibility-only: this never touches Earnings/Market/
      Context/total scoring. Runs once, synchronously, only when you run
      this command -- no scheduler.

  python cli.py add-manual-candidate --db PATH --tickers ATI,MSFT --as-of YYYY-MM-DD
      Manual fallback -- adds the given tickers straight into `candidates`
      with source='manual', no Danelfin call, no API key needed. Same table,
      same idempotent upsert, same downstream tracking pipeline as
      select-candidates/fetch-trade-ideas above.

Real ingestion (Alpha Vantage / Danelfin, requiring API keys in the
environment) and the daily/live pipeline (src/pipeline.py:run_daily_cycle)
are meant to be wired up into your own scheduler; see README.md.
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, datetime

sys.path.insert(0, ".")

from src.db import init_db
from src.pipeline import run_ati_demo
from src.reports import render_report


def main() -> None:
    parser = argparse.ArgumentParser(description="Stock-Selection Candidate Validation & Tracking System")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init-db")
    p_init.add_argument("--db", default="stock_selection.db")

    p_demo = sub.add_parser("demo-ati")
    p_demo.add_argument("--db", default="stock_selection.db")
    p_demo.add_argument("--as-of", default=None, help="YYYY-MM-DD, must be a trading day. Defaults to today.")
    p_demo.add_argument("--seed", type=int, default=42)

    p_report = sub.add_parser("report")
    p_report.add_argument("--db", required=True)
    p_report.add_argument("--episode-id", required=True)

    p_select = sub.add_parser("select-candidates")
    p_select.add_argument("--db", default="stock_selection.db")
    p_select.add_argument("--tickers", required=True, help="Comma-separated, e.g. ATI,MSFT")
    p_select.add_argument("--as-of", required=True, help="YYYY-MM-DD")

    p_manual = sub.add_parser("add-manual-candidate")
    p_manual.add_argument("--db", default="stock_selection.db")
    p_manual.add_argument("--tickers", required=True, help="Comma-separated, e.g. ATI,MSFT")
    p_manual.add_argument("--as-of", required=True, help="YYYY-MM-DD")

    p_trade_ideas = sub.add_parser("fetch-trade-ideas")
    p_trade_ideas.add_argument("--db", default="stock_selection.db")
    p_trade_ideas.add_argument("--as-of", required=True, help="YYYY-MM-DD")
    p_trade_ideas.add_argument("--market", default=None)
    p_trade_ideas.add_argument("--direction", default=None, help="e.g. long/short")
    p_trade_ideas.add_argument("--asset-type", default=None)
    p_trade_ideas.add_argument("--aiscore", type=float, default=None)
    p_trade_ideas.add_argument("--fundamental", type=float, default=None)
    p_trade_ideas.add_argument("--technical", type=float, default=None)
    p_trade_ideas.add_argument("--sentiment", type=float, default=None)
    p_trade_ideas.add_argument("--sector", default=None)
    p_trade_ideas.add_argument("--industry", default=None)
    p_trade_ideas.add_argument("--market-cap", default=None)
    p_trade_ideas.add_argument("--limit", type=int, default=None)
    p_trade_ideas.add_argument("--offset", type=int, default=None)

    args = parser.parse_args()

    if args.command == "init-db":
        init_db(args.db)
        print(f"Initialized schema at {args.db}")
        return

    if args.command == "demo-ati":
        conn = init_db(args.db)
        as_of = date.fromisoformat(args.as_of) if args.as_of else date.today()
        result = run_ati_demo(conn, as_of, seed=args.seed)
        if result["episode_id"] is None:
            print("Insufficient data -- no review written. Open audit cases:")
            for case in result["insufficient_data_cases"]:
                print(f"  audit_id={case['audit_id']} ticker={case['ticker']}")
            return
        print(result["report"])
        return

    if args.command == "report":
        conn = init_db(args.db)
        print(render_report(conn, args.episode_id))
        return

    if args.command == "select-candidates":
        from src.ingestion.candidate_selection import select_candidates
        from src.ingestion.danelfin import DanelfinClient

        conn = init_db(args.db)
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        if not tickers:
            print("Error: --tickers must contain at least one ticker.")
            sys.exit(1)
        as_of = date.fromisoformat(args.as_of)

        try:
            danelfin = DanelfinClient()
        except RuntimeError as exc:
            print(f"Error: {exc}")
            sys.exit(1)

        result = select_candidates(conn, tickers, as_of, danelfin)
        print(
            f"Requested {len(result.requested)}: "
            f"{result.successful_count} successful, "
            f"{result.skipped_count} skipped, "
            f"{result.failed_count} failed."
        )
        if result.successful:
            print(f"  Successful: {', '.join(result.successful)}")
        if result.skipped:
            print(f"  Skipped (no Danelfin data today): {', '.join(result.skipped)}")
        if result.failed:
            print("  Failed:")
            for ticker, err in result.failed.items():
                print(f"    {ticker}: {err}")
        return

    if args.command == "add-manual-candidate":
        from src.ingestion.candidate_selection import add_manual_candidates

        conn = init_db(args.db)
        tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
        if not tickers:
            print("Error: --tickers must contain at least one ticker.")
            sys.exit(1)
        as_of = date.fromisoformat(args.as_of)

        result = add_manual_candidates(conn, tickers, as_of)
        print(f"Requested {len(result.requested)}: {result.added_count} added, {result.failed_count} failed.")
        if result.added:
            print(f"  Added (source=manual): {', '.join(result.added)}")
        if result.failed:
            print("  Failed:")
            for ticker, err in result.failed.items():
                print(f"    {ticker}: {err}")
        return

    if args.command == "fetch-trade-ideas":
        from src.ingestion.candidate_selection import fetch_trade_ideas_candidates
        from src.ingestion.danelfin import DanelfinClient

        conn = init_db(args.db)
        as_of = date.fromisoformat(args.as_of)

        try:
            danelfin = DanelfinClient()
        except RuntimeError as exc:
            print(f"Error: {exc}")
            sys.exit(1)

        result = fetch_trade_ideas_candidates(
            conn, as_of, danelfin,
            market=args.market, direction=args.direction, asset_type=args.asset_type,
            aiscore=args.aiscore, fundamental=args.fundamental, technical=args.technical,
            sentiment=args.sentiment, sector=args.sector, industry=args.industry,
            market_cap=args.market_cap, limit=args.limit, offset=args.offset,
        )
        print(f"Filters: {result.filters or '(none)'}")
        print(
            f"Fetched {result.total_ideas} idea(s): "
            f"{result.successful_count} successful, "
            f"{result.skipped_count} skipped, "
            f"{result.failed_count} failed."
        )
        if result.warnings:
            print("  Warnings:")
            for w in result.warnings:
                print(f"    {w}")
        if result.successful:
            print(f"  Successful: {', '.join(result.successful)}")
        if result.skipped:
            print(f"  Skipped: {len(result.skipped)} record(s) with no recognizable ticker")
        if result.failed:
            print("  Failed:")
            for entry in result.failed:
                print(f"    index={entry['index']} ticker={entry.get('ticker')}: {entry['reason']}")
        return


if __name__ == "__main__":
    main()
