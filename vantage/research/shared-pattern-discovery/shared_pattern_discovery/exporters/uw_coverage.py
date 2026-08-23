from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


PROJECT = "unusualwhales"
HORIZONS = ("+5m", "+30m", "+1h", "+1d", "+3d")


class CoverageDiagnosticError(ValueError):
    """Raised when a coverage diagnostic input or output boundary is unsafe."""


def _normalize_horizon(value: str) -> str:
    normalized = value if value.startswith("+") else "+" + value
    if normalized not in HORIZONS:
        raise CoverageDiagnosticError(f"Unsupported UW horizon {value!r}; choose one of {', '.join(HORIZONS)} or all")
    return normalized


def _number(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed if math.isfinite(parsed) else None


def _validate_paths(database_path: Path, output_path: Path) -> None:
    if not database_path.exists() or not database_path.is_file():
        raise CoverageDiagnosticError(f"UW database path does not exist or is not a file: {database_path}")
    if database_path.suffix.lower() not in {".sqlite", ".db"}:
        raise CoverageDiagnosticError(f"UW database path must be a SQLite file: {database_path}")
    if database_path == output_path:
        raise CoverageDiagnosticError("Diagnostic output must differ from the source database")
    source_root = next((parent for parent in database_path.parents if parent.name == "unusualwhales"), None)
    if source_root is not None and (output_path == source_root or source_root in output_path.parents):
        raise CoverageDiagnosticError(f"Diagnostic output must not be inside the source project tree: {output_path}")


def _open_read_only(database_path: Path) -> sqlite3.Connection:
    try:
        database = sqlite3.connect(f"file:{database_path.as_posix()}?mode=ro", uri=True)
        database.execute("PRAGMA query_only = ON")
        tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        required = {"uw_option_trades", "uw_signal_outcomes"}
        missing = sorted(required - tables)
        if missing:
            database.close()
            raise CoverageDiagnosticError(f"UW database is missing required tables: {', '.join(missing)}")
        return database
    except sqlite3.Error as exc:
        raise CoverageDiagnosticError(f"Could not open UW database read-only: {database_path}: {exc}") from exc


def _event_rows(database: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    database.row_factory = sqlite3.Row
    try:
        return database.execute(
            """
            SELECT id AS trade_id, executed_at, underlying_symbol, signal_type,
                   premium, size, open_interest
            FROM uw_option_trades
            WHERE executed_at IS NOT NULL
            ORDER BY executed_at ASC, id ASC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    except sqlite3.Error as exc:
        raise CoverageDiagnosticError(f"Could not read bounded UW event sample: {exc}") from exc


def _outcomes(database: sqlite3.Connection, trade_ids: list[int], horizon: str) -> dict[int, sqlite3.Row]:
    if not trade_ids:
        return {}
    placeholders = ",".join("?" for _ in trade_ids)
    query = f"""
        SELECT o.trade_id, o.outcome_at, o.return_pct, o.spy_return_pct,
               o.excess_return_pct, o.exclusion_reason
        FROM uw_signal_outcomes o
        WHERE o.horizon = ? AND o.trade_id IN ({placeholders})
          AND o.id = (
            SELECT x.id FROM uw_signal_outcomes x
            WHERE x.trade_id = o.trade_id AND x.horizon = o.horizon
            ORDER BY x.id DESC LIMIT 1
          )
    """
    try:
        return {int(row["trade_id"]): row for row in database.execute(query, [horizon, *trade_ids]).fetchall()}
    except sqlite3.Error as exc:
        raise CoverageDiagnosticError(f"Could not read bounded UW outcome sample: {exc}") from exc


def _usable(event: sqlite3.Row, outcome: sqlite3.Row | None) -> tuple[bool, bool]:
    if outcome is None or outcome["outcome_at"] is None:
        return False, False
    try:
        event_time = datetime.fromisoformat(str(event["executed_at"]).replace("Z", "+00:00"))
        outcome_time = datetime.fromisoformat(str(outcome["outcome_at"]).replace("Z", "+00:00"))
        mature = outcome_time >= event_time
    except ValueError:
        mature = False
    usable = bool(
        mature
        and outcome["exclusion_reason"] is None
        and _number(outcome["return_pct"]) is not None
        and _number(outcome["spy_return_pct"]) is not None
        and _number(outcome["excess_return_pct"]) is not None
    )
    return mature, usable


def _field_values(event: sqlite3.Row) -> dict[str, float | None]:
    premium = _number(event["premium"])
    size = _number(event["size"])
    return {
        "premium": premium,
        "size": size,
        "open_interest": _number(event["open_interest"]),
        "notional": premium * size if premium is not None and size is not None else None,
    }


def _missingness_comparison(records: list[dict[str, Any]], field: str) -> dict[str, Any]:
    usable = [_number(record["fields"].get(field)) for record in records if record["usable"]]
    nonusable = [_number(record["fields"].get(field)) for record in records if not record["usable"]]
    usable_present = [value for value in usable if value is not None]
    nonusable_present = [value for value in nonusable if value is not None]
    usable_mean = sum(usable_present) / len(usable_present) if usable_present else None
    nonusable_mean = sum(nonusable_present) / len(nonusable_present) if nonusable_present else None
    all_values = usable_present + nonusable_present
    mean_difference = usable_mean - nonusable_mean if usable_mean is not None and nonusable_mean is not None else None
    scale = math.sqrt(sum((value - (sum(all_values) / len(all_values))) ** 2 for value in all_values) / len(all_values)) if all_values else None
    standardized_difference = mean_difference / scale if mean_difference is not None and scale and scale > 0 else None
    return {
        "field": field,
        "usable_sample_size": len(usable),
        "nonusable_sample_size": len(nonusable),
        "usable_observed_n": len(usable_present),
        "usable_missing_n": len(usable) - len(usable_present),
        "nonusable_observed_n": len(nonusable_present),
        "nonusable_missing_n": len(nonusable) - len(nonusable_present),
        "usable_mean": usable_mean,
        "nonusable_mean": nonusable_mean,
        "mean_difference_usable_minus_nonusable": mean_difference,
        "standardized_mean_difference": standardized_difference,
        "material_difference_flag": bool(standardized_difference is not None and abs(standardized_difference) >= 0.5),
    }


def diagnose_unusualwhales(
    database_path: str | Path,
    output_path: str | Path,
    *,
    project: str = PROJECT,
    horizon: str = "all",
    limit: int = 1000,
    selection_boundary: str | None = None,
) -> dict[str, Any]:
    """Produce a bounded, read-only UW coverage and missingness diagnostic."""
    if project != PROJECT:
        raise CoverageDiagnosticError(f"This diagnostic only accepts project={PROJECT!r}, received {project!r}")
    if isinstance(limit, bool) or not isinstance(limit, int) or limit < 1:
        raise CoverageDiagnosticError("limit must be a positive integer")
    selected_horizons = list(HORIZONS) if horizon.lower() == "all" else [_normalize_horizon(horizon)]
    database_path = Path(database_path).resolve()
    output_path = Path(output_path).resolve()
    _validate_paths(database_path, output_path)
    database = _open_read_only(database_path)
    try:
        events = _event_rows(database, limit)
        event_ids = [int(event["trade_id"]) for event in events]
        per_horizon: dict[str, Any] = {}
        for selected in selected_horizons:
            outcomes = _outcomes(database, event_ids, selected)
            records: list[dict[str, Any]] = []
            for event in events:
                outcome = outcomes.get(int(event["trade_id"]))
                mature, usable = _usable(event, outcome)
                records.append({"fields": _field_values(event), "mature": mature, "usable": usable})
            mature_count = sum(record["mature"] for record in records)
            usable_count = sum(record["usable"] for record in records)
            comparisons = [_missingness_comparison(records, field) for field in ("premium", "size", "open_interest", "notional")]
            per_horizon[selected] = {
                "event_sample_size": len(records),
                "outcome_row_count": len(outcomes),
                "missing_outcome_row_count": len(records) - len(outcomes),
                "mature_count": mature_count,
                "usable_count": usable_count,
                "mature_coverage": mature_count / len(records) if records else 0.0,
                "usable_coverage": usable_count / len(records) if records else 0.0,
                "missingness_comparisons": comparisons,
            }
    finally:
        database.close()
    payload = {
        "metadata": {
            "project": PROJECT,
            "diagnostic_version": "uw-coverage-missingness-v1",
            "source_database": str(database_path),
            "source_access": "sqlite read-only URI mode=ro; PRAGMA query_only=ON",
            "source_event_table": "uw_option_trades",
            "source_outcome_table": "uw_signal_outcomes",
            "horizon_selection": selected_horizons,
            "limit": limit,
            "exported_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "selection_boundary": selection_boundary,
        },
        "survivorship": {
            "provable_from_current_database": False,
            "selection_boundary_supplied": bool(selection_boundary),
            "note": "Entity survivorship cannot be proven from the current database unless a selection boundary is supplied and independently verified; this diagnostic does not infer survivorship from observed rows.",
        },
        "horizons": per_horizon,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return payload


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Read-only bounded UW coverage and missingness diagnostic.")
    parser.add_argument("--project", required=True, help="Must be unusualwhales.")
    parser.add_argument("--database", required=True, help="Unusual Whales SQLite database path.")
    parser.add_argument("--output", required=True, help="Diagnostic JSON output outside the source project tree.")
    parser.add_argument("--horizon", default="all", help="5m, 30m, 1h, 1d, 3d, or all.")
    parser.add_argument("--limit", type=int, default=1000, help="Maximum event rows sampled.")
    parser.add_argument("--selection-boundary", help="Optional externally supplied entity-selection boundary; not verified by this tool.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = diagnose_unusualwhales(args.database, args.output, project=args.project, horizon=args.horizon, limit=args.limit, selection_boundary=args.selection_boundary)
    except (CoverageDiagnosticError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"project": PROJECT, "output": str(Path(args.output).resolve()), "horizons": {key: {field: value for field, value in report.items() if field.endswith("count") or field.endswith("coverage")} for key, report in payload["horizons"].items()}}, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
