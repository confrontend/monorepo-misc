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


if __name__ == "__main__":
    main()
