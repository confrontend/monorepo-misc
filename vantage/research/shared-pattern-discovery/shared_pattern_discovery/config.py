from __future__ import annotations

import json
from pathlib import Path
from typing import Any


PACKAGE_ROOT = Path(__file__).resolve().parents[1]
CONFIG_ROOT = PACKAGE_ROOT / "configs"


class ConfigError(ValueError):
    """Raised when a project allow-list is malformed."""


def load_project_config(project: str, config_path: str | Path | None = None) -> dict[str, Any]:
    """Load exactly one project configuration and validate its allow-list."""
    path = Path(config_path).resolve() if config_path else CONFIG_ROOT / f"{project}.json"
    if not path.exists():
        raise ConfigError(f"No allow-list config exists for project {project!r}: {path}")
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ConfigError(f"Invalid JSON in allow-list config {path}: {exc}") from exc
    if config.get("project") != project:
        raise ConfigError(
            f"Config project {config.get('project')!r} does not match requested project {project!r}."
        )
    features = config.get("allow_list")
    if not isinstance(features, list) or not features:
        raise ConfigError(f"Config {path} must contain a non-empty allow_list.")
    names: set[str] = set()
    for item in features:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ConfigError(f"Every allow_list entry in {path} needs a string name and justification.")
        name = item["name"]
        justification = item.get("justification")
        if name in names:
            raise ConfigError(f"Duplicate allow-list feature {name!r} in {path}.")
        if not isinstance(justification, str) or not justification.strip():
            raise ConfigError(f"Allow-list feature {name!r} needs a one-line justification.")
        names.add(name)
    config["_path"] = str(path)
    config["_allow_names"] = sorted(names)
    return config
