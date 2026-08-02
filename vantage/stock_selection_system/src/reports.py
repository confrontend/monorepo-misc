"""
Simple readable report generator (implementation prompt deliverable 7):
renders one `reviews` row (joined with `episode_entries` if it exists yet, and
`recommendation_outcomes` if any horizons have resolved) into a human-readable
evidence summary.
"""
from __future__ import annotations

import sqlite3


def _fmt_score(score) -> str:
    if score is None:
        return "n/a"
    return f"{score:+d}"


def render_report(conn: sqlite3.Connection, episode_id: str) -> str:
    review = conn.execute("SELECT * FROM reviews WHERE episode_id = ?", (episode_id,)).fetchone()
    if review is None:
        raise ValueError(f"No reviews row found for episode_id={episode_id!r}")

    entry = conn.execute(
        "SELECT * FROM episode_entries WHERE episode_id = ?", (episode_id,)
    ).fetchone()
    outcomes = conn.execute(
        "SELECT * FROM recommendation_outcomes WHERE episode_id = ? ORDER BY horizon_days",
        (episode_id,),
    ).fetchall()

    lines = []
    lines.append(f"{review['ticker']}  (episode_id: {review['episode_id']})")
    lines.append(f"Decision: {review['decision'].upper() if review['decision'] else 'N/A'}")
    lines.append(f"Confidence: {review['confidence'].upper() if review['confidence'] else 'N/A'}")
    lines.append(f"Earnings score: {_fmt_score(review['earnings_score'])} ({review['earnings_fact'] or 'n/a'})")
    lines.append(f"Market score: {_fmt_score(review['market_score'])} ({review['market_fact'] or 'n/a'})")
    lines.append(f"Context score: {_fmt_score(review['context_score'])} ({review['context_fact'] or 'n/a'})")
    lines.append(f"Total score: {_fmt_score(review['total_score'])}")
    lines.append(f"Rule version: {review['rule_version']}  |  Trigger: {review['episode_trigger']}  |  Review date: {review['review_date']}")

    if review["explanation"]:
        lines.append(f"Reason: {review['explanation']}")

    if review["corrects_episode_id"]:
        lines.append(f"Corrects prior episode: {review['corrects_episode_id']}")
    if review["resolved_from_audit_id"]:
        lines.append(f"Resolved from insufficient-data case: audit_id={review['resolved_from_audit_id']}")

    if entry is not None:
        lines.append("")
        lines.append(
            f"Entry: {entry['entry_date']}  stock_open=${entry['stock_entry_open']:.2f}  "
            f"spy_open=${entry['spy_entry_open']:.2f}  "
            f"sector({entry['sector_benchmark_ticker']})_open=${entry['sector_entry_open']:.2f}"
        )
    else:
        lines.append("")
        lines.append("Entry: pending (applicable session has not yet opened, or entry data not yet available)")

    if outcomes:
        lines.append("")
        lines.append("Outcomes:")
        for o in outcomes:
            lines.append(
                f"  +{o['horizon_days']}d ({o['exit_date']}): "
                f"stock {o['stock_return']:+.2%}  spy {o['spy_return']:+.2%}  "
                f"sector {o['sector_return']:+.2%}  -- {o['recommendation_result']}"
            )

    return "\n".join(lines)
