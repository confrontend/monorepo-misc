"""Project-isolated descriptive pattern discovery.

The engine accepts normalized exports only. It never opens a project database and never
combines rows, configuration, models, or reports across projects.
"""

from .engine import run_discovery
from .validation import DatasetValidationError, load_dataset

__all__ = ["DatasetValidationError", "ExportError", "export_unusualwhales", "load_dataset", "run_discovery"]


def __getattr__(name: str):
    if name in {"ExportError", "export_unusualwhales"}:
        from .exporters.uw import ExportError, export_unusualwhales
        return {"ExportError": ExportError, "export_unusualwhales": export_unusualwhales}[name]
    raise AttributeError(name)
