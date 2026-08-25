from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .config import ConfigError, load_project_config
from .engine import run_discovery
from .validation import DatasetValidationError, load_dataset


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run isolated V1 descriptive pattern discovery on one normalized project export.")
    parser.add_argument("--input", required=True, help="Normalized JSON or CSV export; databases are not accepted.")
    parser.add_argument("--project", required=True, choices=("unusualwhales", "crypto"), help="Exactly one project identity.")
    parser.add_argument("--output", required=True, help="Project-local JSON report path.")
    parser.add_argument("--outcome", help="Outcome column; required when metadata does not declare exactly one.")
    parser.add_argument("--config", help="Optional project allow-list JSON; must declare the same project.")
    parser.add_argument("--min-n", type=int, default=30, help="Minimum discovery and validation sample size (default: 30).")
    parser.add_argument("--validation-fraction", type=float, default=0.3, help="Chronological validation fraction (default: 0.3).")
    parser.add_argument("--holdout-fraction", type=float, default=0.0, help="Untouched final holdout fraction (default: 0).")
    parser.add_argument("--buckets", type=int, default=4, help="Quantile bucket count (default: 4).")
    parser.add_argument("--fdr-alpha", type=float, default=0.05, help="Benjamini-Hochberg alpha (default: 0.05).")
    parser.add_argument("--seed", type=int, default=0, help="Deterministic model/bootstrap seed.")
    parser.add_argument("--progress-file", help="Optional JSON heartbeat file for long-running callers.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    input_path = Path(args.input).resolve()
    output_path = Path(args.output).resolve()
    if input_path.suffix.lower() not in {".json", ".csv"}:
        print("ERROR: --input must be a normalized .json or .csv export; source databases are out of scope.", file=sys.stderr)
        return 2
    if input_path == output_path:
        print("ERROR: --output must differ from --input.", file=sys.stderr)
        return 2
    try:
        config = load_project_config(args.project, args.config)
        dataset = load_dataset(input_path, args.project, config, args.outcome)
        progress_path = Path(args.progress_file).resolve() if args.progress_file else None

        def progress(update: dict[str, object]) -> None:
            if progress_path is None:
                return
            progress_path.parent.mkdir(parents=True, exist_ok=True)
            temporary_progress_path = progress_path.with_suffix(progress_path.suffix + ".tmp")
            temporary_progress_path.write_text(
                json.dumps(update, ensure_ascii=False), encoding="utf-8"
            )
            temporary_progress_path.replace(progress_path)

        report = run_discovery(
            dataset,
            config,
            project=args.project,
            min_n=args.min_n,
            validation_fraction=args.validation_fraction,
            holdout_fraction=args.holdout_fraction,
            buckets=args.buckets,
            fdr_alpha=args.fdr_alpha,
            seed=args.seed,
            input_path=str(input_path),
            output_path=str(output_path),
            progress_callback=progress if progress_path else None,
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    except (ConfigError, DatasetValidationError, ValueError, OSError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    counts = report["status_counts"]
    print(json.dumps({"project": args.project, "output": str(output_path), "status_counts": counts, "patterns": len(report["patterns"])}, indent=2))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
