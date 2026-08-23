from __future__ import annotations

import csv
import json
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


STANDARD_COLUMNS = {
    "event_id", "event_time", "entity_id", "signal_type", "independence_group",
    "features", "mature", "usable", "project", "outcome", "outcome_horizon", "benchmark_return",
    "excess_return", "net_return_after_costs",
}


class DatasetValidationError(ValueError):
    """Raised when a normalized export violates the analytical input contract."""


@dataclass(frozen=True)
class ValidatedDataset:
    metadata: dict[str, Any]
    rows: list[dict[str, Any]]
    outcome: str
    examined_fields: list[str]
    rejected_fields: list[str]
    allow_list: list[dict[str, str]]


def _parse_event_time(value: Any, row_number: int) -> None:
    if not isinstance(value, str) or not value.strip():
        raise DatasetValidationError(f"row {row_number}: event_time must be a non-empty ISO-8601 string")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise DatasetValidationError(f"row {row_number}: event_time is not ISO-8601: {value!r}") from exc


def _strict_bool(value: Any, field: str, row_number: int) -> bool:
    if not isinstance(value, bool):
        raise DatasetValidationError(f"row {row_number}: {field} must be a JSON boolean, not {value!r}")
    return value


def _finite_number(value: Any, field: str, row_number: int) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise DatasetValidationError(f"row {row_number}: {field} must be a finite number or null")


def _read_rows(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not path.exists():
        raise DatasetValidationError(f"Input dataset does not exist: {path}")
    if path.suffix.lower() == ".csv":
        with path.open(newline="", encoding="utf-8-sig") as handle:
            return {}, [dict(row) for row in csv.DictReader(handle)]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise DatasetValidationError(f"Input must be valid JSON or CSV: {path}: {exc}") from exc
    if isinstance(payload, list):
        return {}, payload
    if not isinstance(payload, dict):
        raise DatasetValidationError("JSON input must be an object with metadata and rows, or a row array")
    rows = payload.get("rows", payload.get("data"))
    if not isinstance(rows, list):
        raise DatasetValidationError("JSON input must contain a list under 'rows' or 'data'")
    return payload.get("metadata", {}), rows


def load_dataset(path: str | Path, project: str, config: dict[str, Any], outcome: str | None = None) -> ValidatedDataset:
    """Load and loudly validate one project-owned normalized export."""
    source = Path(path).resolve()
    metadata, raw_rows = _read_rows(source)
    if not isinstance(metadata, dict):
        raise DatasetValidationError("metadata must be a JSON object")
    metadata = dict(metadata)
    declared_project = metadata.get("project", project)
    if declared_project != project:
        raise DatasetValidationError(
            f"Project isolation violation: input declares {declared_project!r}, CLI requested {project!r}"
        )
    metadata["project"] = project
    if not raw_rows:
        raise DatasetValidationError("Input dataset contains zero rows")
    if not all(isinstance(row, dict) for row in raw_rows):
        raise DatasetValidationError("Every input row must be a JSON object")

    selected_outcome = outcome or metadata.get("outcome")
    if not selected_outcome:
        candidates = sorted({key for row in raw_rows for key in row if key.startswith("net_return_")})
        if len(candidates) == 1:
            selected_outcome = candidates[0]
    if not isinstance(selected_outcome, str) or not selected_outcome:
        raise DatasetValidationError("Specify --outcome or metadata.outcome; outcome selection is never guessed across multiple columns")

    required = {"event_id", "event_time", "entity_id", "signal_type", "independence_group", "mature", "usable"}
    required.add(selected_outcome)
    allow_names = set(config["_allow_names"])
    seen_ids: set[str] = set()
    rows: list[dict[str, Any]] = []
    for row_number, original in enumerate(raw_rows, start=1):
        row = dict(original)
        missing = sorted(field for field in required if field not in row)
        if missing:
            raise DatasetValidationError(f"row {row_number}: missing required fields: {', '.join(missing)}")
        for field in ("event_id", "entity_id", "independence_group"):
            if not isinstance(row[field], str) or not row[field].strip():
                raise DatasetValidationError(f"row {row_number}: {field} must be a non-empty string")
        if row["event_id"] in seen_ids:
            raise DatasetValidationError(f"row {row_number}: duplicate event_id {row['event_id']!r}")
        seen_ids.add(row["event_id"])
        _parse_event_time(row["event_time"], row_number)
        row["mature"] = _strict_bool(row["mature"], "mature", row_number)
        row["usable"] = _strict_bool(row["usable"], "usable", row_number)
        if row[selected_outcome] is not None:
            _finite_number(row[selected_outcome], selected_outcome, row_number)
        if row["usable"] and (not row["mature"] or row[selected_outcome] is None):
            raise DatasetValidationError(f"row {row_number}: usable=true requires mature=true and a non-null {selected_outcome}")
        if isinstance(row.get("project"), str) and row["project"] != project:
            raise DatasetValidationError(f"row {row_number}: project {row['project']!r} crosses requested project {project!r}")
        if config.get("feature_source") == "features":
            feature_payload = row.get("features")
            if not isinstance(feature_payload, dict):
                raise DatasetValidationError(f"row {row_number}: features must be an explicit object for project {project!r}")
            unexpected_features = sorted(set(feature_payload) - allow_names)
            if unexpected_features:
                raise DatasetValidationError(f"row {row_number}: features contains disallowed fields: {', '.join(unexpected_features)}")
            # The engine consumes only configured allow-list names. Copying the explicit
            # feature object into those names prevents incidental top-level outcome fields
            # from becoming model inputs.
            for feature in allow_names:
                if feature in feature_payload:
                    row[feature] = feature_payload[feature]
        rows.append(row)

    examined = sorted({key for row in rows for key in row if key not in STANDARD_COLUMNS and key != selected_outcome})
    rejected = sorted(field for field in examined if field not in allow_names)
    metadata.setdefault("schema_version", "normalized-v1")
    metadata.setdefault("feature_allowlist_version", config.get("version", "unspecified"))
    metadata["source_file"] = str(source)
    return ValidatedDataset(
        metadata=metadata,
        rows=rows,
        outcome=selected_outcome,
        examined_fields=examined,
        rejected_fields=rejected,
        allow_list=[{"name": item["name"], "justification": item["justification"]} for item in config["allow_list"]],
    )
