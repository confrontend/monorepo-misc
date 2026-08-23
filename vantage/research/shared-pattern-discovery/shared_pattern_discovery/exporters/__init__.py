"""Project-local read-only exporters.

Only modules in this package may open a source project database. The shared discovery engine
consumes the resulting normalized JSON and has no database dependency. Exporter modules are not
eagerly imported so ``python -m shared_pattern_discovery.exporters.uw`` remains warning-free.
"""

__all__: list[str] = []
