from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..config import PACKAGE_ROOT


PROJECT = "unusualwhales"
DEFAULT_HORIZON = "+1d"
PROJECT_HORIZONS = ("+5m", "+30m", "+1h", "+1d", "+3d")
OPTION_FEATURE_COLUMNS = (
    "volume_oi_ratio", "spread_pct", "moneyness_pct", "side_score",
)


class ExportError(ValueError):
    """Raised when a source or exporter contract is unsafe or malformed."""


def _normalize_horizon(value: str) -> str:
    normalized = value if value.startswith("+") else "+" + value
    if normalized not in PROJECT_HORIZONS:
        raise ExportError(f"Unsupported UW horizon {value!r}; choose one of {', '.join(PROJECT_HORIZONS)}")
    return normalized


def _finite(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _parse_time(value: Any, field: str, *, date_only_midnight: bool = False) -> datetime | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    if date_only_midnight and len(text) == 10:
        text += "T00:00:00+00:00"
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ExportError(f"UW source has invalid {field}: {value!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _json_value(value: Any) -> Any:
    if value is None:
        return []
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(str(value))
    except json.JSONDecodeError as exc:
        raise ExportError(f"UW source has malformed JSON label field: {value!r}") from exc


def _read_only_database(path: Path) -> sqlite3.Connection:
    if not path.exists() or not path.is_file():
        raise ExportError(f"UW database path does not exist or is not a file: {path}")
    if path.suffix.lower() not in {".sqlite", ".db"}:
        raise ExportError(f"UW database path must be a SQLite file, received: {path}")
    uri = f"file:{path.as_posix()}?mode=ro"
    try:
        database = sqlite3.connect(uri, uri=True)
        database.execute("PRAGMA query_only = ON")
        tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {"uw_option_trades", "uw_signal_outcomes"}
        missing = sorted(required - tables)
        if missing:
            database.close()
            raise ExportError(f"UW database is missing required tables: {', '.join(missing)}")
        return database
    except sqlite3.Error as exc:
        raise ExportError(f"Could not open UW database read-only: {path}: {exc}") from exc


def _validate_paths(database_path: Path, output_path: Path) -> None:
    database_path = database_path.resolve()
    output_path = output_path.resolve()
    if database_path == output_path:
        raise ExportError("Output path must differ from the source database path")
    # Never write inside the source project's tree. Package-local runs and external temp paths
    # are allowed; the source database and its WAL/SHM siblings remain outside the write scope.
    source_project_root = next((parent for parent in database_path.parents if parent.name == "unusualwhales"), None)
    if source_project_root and source_project_root == output_path or source_project_root and source_project_root in output_path.parents:
        raise ExportError(f"Output path must not be inside the source project tree: {output_path}")


def _event_row(row: sqlite3.Row, horizon: str, cost_bps: float) -> dict[str, Any]:
    executed_at = _parse_time(row["executed_at"], "executed_at")
    if executed_at is None:
        raise ExportError(f"UW option trade {row['trade_id']} has no executed_at; cannot form event_time")
    entity = row["underlying_symbol"]
    signal_type = row["signal_type"]
    if not isinstance(entity, str) or not entity.strip() or not isinstance(signal_type, str) or not signal_type.strip():
        raise ExportError(f"UW option trade {row['trade_id']} lacks entity or signal_type")

    expiry_time = _parse_time(row["expiry"], "expiry", date_only_midnight=True)
    dte_days = (expiry_time - executed_at).total_seconds() / 86400 if expiry_time else None
    outcome_at = _parse_time(row["outcome_at"], "outcome_at")
    gross_return = _finite(row["return_pct"])
    benchmark = _finite(row["spy_return_pct"])
    excess = _finite(row["excess_return_pct"])
    mature = outcome_at is not None and outcome_at >= executed_at
    usable = bool(mature and row["exclusion_reason"] is None and gross_return is not None and benchmark is not None and excess is not None)
    net_return = gross_return - (cost_bps / 100.0) if gross_return is not None else None

    features = {
        "signal_type": signal_type,
        "underlying_symbol": entity,
        "premium": _finite(row["premium"]),
        "size": row["size"],
        "open_interest": row["open_interest"],
        "volume": row["volume"],
        "nbbo_bid": _finite(row["nbbo_bid"]),
        "nbbo_ask": _finite(row["nbbo_ask"]),
        "strike": _finite(row["strike"]),
        "underlying_price": _finite(row["underlying_price"]),
        "expiry": row["expiry"],
        "executed_at": row["executed_at"],
        "dte_days": dte_days,
        "volume_oi_ratio": _finite(row["volume_oi_ratio"]),
        "spread_pct": _finite(row["spread_pct"]),
        "moneyness_pct": _finite(row["moneyness_pct"]),
        "side_score": _finite(row["side_score"]),
        "report_flags": _json_value(row["report_flags"]),
        "tags": _json_value(row["tags"]),
    }
    return {
        "event_id": f"uw-option-trade:{row['trade_id']}",
        "event_time": executed_at.isoformat().replace("+00:00", "Z"),
        "entity_id": entity,
        "signal_type": signal_type,
        **features,
        "outcome_horizon": horizon,
        "benchmark_return": benchmark,
        "excess_return": excess,
        "net_return_after_costs": net_return,
        "mature": mature,
        "usable": usable,
        "independence_group": entity,
        "outcome_at": outcome_at.isoformat().replace("+00:00", "Z") if outcome_at else None,
        "outcome_exclusion_reason": row["exclusion_reason"],
    }


def export_unusualwhales(
    database_path: str | Path,
    output_path: str | Path,
    *,
    project: str = PROJECT,
    horizon: str = DEFAULT_HORIZON,
    limit: int = 1000,
    cost_bps: float = 0.0,
) -> dict[str, Any]:
    """Export bounded UW rows using a read-only connection and write one normalized JSON file."""
    if project != PROJECT:
        raise ExportError(f"This exporter is project-specific and only accepts project={PROJECT!r}, received {project!r}")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise ExportError("limit must be a positive integer")
    if not math.isfinite(float(cost_bps)) or cost_bps < 0:
        raise ExportError("cost_bps must be a finite non-negative number")
    horizon = _normalize_horizon(horizon)
    database = Path(database_path).resolve()
    output = Path(output_path).resolve()
    _validate_paths(database, output)
    output.parent.mkdir(parents=True, exist_ok=True)
    connection = _read_only_database(database)
    connection.row_factory = sqlite3.Row
    query = """
        SELECT
          t.id AS trade_id, t.executed_at, t.signal_type, t.underlying_symbol,
          t.expiry, t.strike, t.premium, t.price, t.size, t.underlying_price,
          t.open_interest, t.volume, t.nbbo_bid, t.nbbo_ask, t.report_flags, t.tags,
          f.volume_oi_ratio, f.spread_pct, f.moneyness_pct, f.side_score,
          o.outcome_at, o.return_pct, o.spy_return_pct, o.excess_return_pct,
          o.exclusion_reason
        FROM uw_option_trades t
        LEFT JOIN uw_option_features f ON f.trade_id = t.id
        LEFT JOIN uw_signal_outcomes o ON o.id = (
          SELECT x.id FROM uw_signal_outcomes x
          WHERE x.trade_id = t.id AND x.horizon = ?
          ORDER BY x.id DESC LIMIT 1
        )
        WHERE t.executed_at IS NOT NULL
        ORDER BY t.executed_at ASC, t.id ASC
        LIMIT ?
    """
    try:
        source_rows = connection.execute(query, (horizon, limit)).fetchall()
        rows = [_event_row(row, horizon, float(cost_bps)) for row in source_rows]
    except sqlite3.Error as exc:
        raise ExportError(f"Read-only UW export query failed: {exc}") from exc
    finally:
        connection.close()
    metadata = {
        "project": PROJECT,
        "schema_version": "normalized-v1",
        "feature_allowlist_version": "uw-v1-event-time-allowlist",
        "outcome": "net_return_after_costs",
        "horizon": horizon,
        "horizons": list(PROJECT_HORIZONS),
        "source_table": "uw_option_trades",
        "outcome_table": "uw_signal_outcomes",
        "source_database": str(database),
        "source_access": "sqlite read-only URI mode=ro; PRAGMA query_only=ON",
        "source_filter": "executed_at IS NOT NULL; ordered by executed_at,id",
        "exported_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "limit": limit,
        "export_rows": len(rows),
        "mature_rows": sum(row["mature"] for row in rows),
        "usable_rows": sum(row["usable"] for row in rows),
        "cost_bps": float(cost_bps),
        "cost_model": "simple percentage-point subtraction from return_pct; 0 means no cost adjustment",
        "missing_outcomes_are_null": True,
        "dte_derivation": "expiry at UTC midnight minus executed_at, in days; never computed from now",
        "independence_group_derivation": "underlying_symbol",
        "output_path": str(output),
    }
    payload = {"metadata": metadata, "rows": rows}
    output.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only bounded Unusual Whales SQLite exporter.")
    parser.add_argument("--project", required=True, help="Must be unusualwhales; cross-project exports are refused.")
    parser.add_argument("--database", required=True, help="Unusual Whales SQLite database path.")
    parser.add_argument("--output", required=True, help="Normalized JSON output outside the source project tree.")
    parser.add_argument("--limit", type=int, default=1000, help="Maximum option-trade events to export.")
    parser.add_argument("--horizon", default=DEFAULT_HORIZON, help="Outcome horizon: 5m, 30m, 1h, 1d, or 3d.")
    parser.add_argument("--cost-bps", type=float, default=0.0, help="Simple cost adjustment in basis points; default 0.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = export_unusualwhales(args.database, args.output, project=args.project, horizon=args.horizon, limit=args.limit, cost_bps=args.cost_bps)
    except (ExportError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"project": PROJECT, "output": payload["metadata"]["output_path"], "export_rows": payload["metadata"]["export_rows"], "mature_rows": payload["metadata"]["mature_rows"], "usable_rows": payload["metadata"]["usable_rows"], "horizon": payload["metadata"]["horizon"]}, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
