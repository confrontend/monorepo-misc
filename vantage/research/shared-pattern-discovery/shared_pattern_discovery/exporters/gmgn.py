from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


PROJECT = "crypto"
OUTCOME = "net_return_after_costs"
PRE_EVENT_FEATURES = {"wallet_address", "token_symbol", "token_address", "chain", "signal_type"}


class GmgnExportError(ValueError):
    """Raised when a crypto Pattern Discovery export violates the adapter contract."""


def _read_payload(path: Path) -> dict[str, Any]:
    if not path.exists() or not path.is_file():
        raise GmgnExportError(f"GMGN export input does not exist or is not a file: {path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise GmgnExportError(f"GMGN export must be valid JSON: {path}: {exc}") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("metadata"), dict) or not isinstance(payload.get("rows"), list):
        raise GmgnExportError("GMGN export must be an object with metadata and rows")
    return payload


def normalize_gmgn_export(input_path: str | Path, output_path: str | Path, *, project: str = PROJECT) -> dict[str, Any]:
    """Validate and copy the crypto adapter's normalized JSON without opening SQLite."""
    if project != PROJECT:
        raise GmgnExportError(f"This adapter is project-specific and only accepts project={PROJECT!r}")
    source = Path(input_path).resolve()
    output = Path(output_path).resolve()
    if source == output:
        raise GmgnExportError("Adapter output must differ from its JSON input")
    payload = _read_payload(source)
    metadata = dict(payload["metadata"])
    if metadata.get("project") != PROJECT:
        raise GmgnExportError(f"Project isolation violation: input declares {metadata.get('project')!r}, requested {PROJECT!r}")
    if metadata.get("coverage_scope") != "outcome_exact_100_percent":
        raise GmgnExportError("GMGN export must declare outcome_exact_100_percent coverage scope")
    rows = payload["rows"]
    for number, row in enumerate(rows, start=1):
        if not isinstance(row, dict):
            raise GmgnExportError(f"row {number}: expected an object")
        if row.get("project", PROJECT) != PROJECT:
            raise GmgnExportError(f"row {number}: project crosses the crypto adapter boundary")
        if row.get("coverage_rate_percent") != 100 or row.get("coverage_status") != "fully_covered":
            raise GmgnExportError(f"row {number}: outcome coverage must be exactly 100% and fully_covered")
        if row.get("mature") is not True or row.get("usable") is not True:
            raise GmgnExportError(f"row {number}: exact-coverage export rows must be mature and usable")
        if row.get(OUTCOME) is None:
            raise GmgnExportError(f"row {number}: {OUTCOME} must be present for the exact-coverage export")
        features = row.get("features")
        if not isinstance(features, dict):
            raise GmgnExportError(f"row {number}: features must be an explicit pre-event object")
        unexpected_features = sorted(set(features) - PRE_EVENT_FEATURES)
        if unexpected_features:
            raise GmgnExportError(f"row {number}: features contains post-event or disallowed fields: {', '.join(unexpected_features)}")
    metadata["project"] = PROJECT
    metadata["outcome"] = OUTCOME
    metadata["feature_allowlist_version"] = "gmgn-v2-pre-event-only"
    metadata["feature_source"] = "features"
    metadata["adapter"] = "shared_pattern_discovery.exporters.gmgn"
    metadata["adapter_input"] = str(source)
    metadata["shared_engine_database_opened"] = False
    normalized = {"metadata": metadata, "rows": rows}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(normalized, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return normalized


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Validate a crypto GMGN Pattern Discovery JSON export without opening SQLite.")
    parser.add_argument("--project", required=True, help="Must be crypto.")
    parser.add_argument("--input", required=True, help="JSON returned by /api/copytrade/pattern-discovery/export.")
    parser.add_argument("--output", required=True, help="Normalized JSON output for the shared engine.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        payload = normalize_gmgn_export(args.input, args.output, project=args.project)
    except (GmgnExportError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps({"project": PROJECT, "output": str(Path(args.output).resolve()), "rows": len(payload["rows"]), "outcome": OUTCOME}, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
