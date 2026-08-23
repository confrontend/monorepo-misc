# Shared pattern-discovery engine

This is a standalone Python package and CLI for one normalized project export at a time. It
never opens a project database and never merges `crypto` and `unusualwhales` rows, configs,
reports, caches, or fitted models. Project-specific event-time allow-lists live in `configs/`.

The V1 CLI performs descriptive summaries, Pearson/Spearman correlation, quantile buckets,
discretized mutual information, a tree-ensemble discovery pass, permutation/rule evidence when
the optional ML stack is installed, minimum-N filtering, chronological discovery/validation
splits, Benjamini-Hochberg correction for enumerable searches, and a JSON report with four
statuses: `discovered candidate`, `validation survivor`, `rejected`, and `insufficient data`.

Run from this directory:

```text
python -m shared_pattern_discovery.cli \
  --project unusualwhales \
  --input fixtures/synthetic.json \
  --output runs/unusualwhales/synthetic.json \
  --min-n 10
```

Base dependency: NumPy. Install `.[full]` to use SciPy and scikit-learn for their corresponding
implementations; deterministic NumPy fallbacks keep V1 runnable when those optional packages
are unavailable. `statsmodels` is not required because the auditable FDR correction is included
directly in the package. SHAP and interaction search are intentionally out of scope for V1.

The UW exporter is project-local and read-only:

```text
python -m shared_pattern_discovery.exporters.uw \
  --project unusualwhales \
  --database C:/path/to/unusual-whales.sqlite \
  --output runs/unusualwhales/uw-1d.json \
  --limit 100 --horizon 1d --cost-bps 10
```

It writes only outside the source project tree, derives `dte_days` from `expiry - executed_at`,
and leaves missing or excluded outcomes null with `mature=false`/`usable=false`.
