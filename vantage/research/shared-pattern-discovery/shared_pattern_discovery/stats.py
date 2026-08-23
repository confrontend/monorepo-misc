from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np

try:  # Optional: pure-NumPy fallbacks keep the CLI usable in a small environment.
    from scipy import stats as scipy_stats  # type: ignore
except ImportError:  # pragma: no cover - exercised by the bundled runtime
    scipy_stats = None


def dependency_status() -> dict[str, bool]:
    status = {"numpy": True, "scipy": scipy_stats is not None, "statsmodels": False, "sklearn": False}
    try:
        import statsmodels  # type: ignore  # noqa: F401
        status["statsmodels"] = True
    except ImportError:
        pass
    try:
        import sklearn  # type: ignore  # noqa: F401
        status["sklearn"] = True
    except ImportError:
        pass
    return status


def _clean_xy(x: Sequence[float], y: Sequence[float]) -> tuple[np.ndarray, np.ndarray]:
    xa, ya = np.asarray(x, dtype=float), np.asarray(y, dtype=float)
    mask = np.isfinite(xa) & np.isfinite(ya)
    return xa[mask], ya[mask]


def rankdata(values: Sequence[float]) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(len(values), dtype=float)
    sorted_values = values[order]
    start = 0
    while start < len(values):
        end = start + 1
        while end < len(values) and sorted_values[end] == sorted_values[start]:
            end += 1
        ranks[order[start:end]] = (start + 1 + end) / 2.0
        start = end
    return ranks


def _normal_two_sided_p(z: float) -> float:
    return math.erfc(abs(float(z)) / math.sqrt(2.0))


def pearson(x: Sequence[float], y: Sequence[float]) -> dict[str, float | int | None]:
    xa, ya = _clean_xy(x, y)
    n = len(xa)
    if n < 3 or np.std(xa) == 0 or np.std(ya) == 0:
        return {"n": n, "coefficient": None, "p_value": None}
    if scipy_stats is not None:
        coefficient, p_value = scipy_stats.pearsonr(xa, ya)
    else:
        coefficient = float(np.corrcoef(xa, ya)[0, 1])
        t = coefficient * math.sqrt((n - 2) / max(1e-12, 1 - coefficient * coefficient))
        p_value = _normal_two_sided_p(t)
    return {"n": n, "coefficient": float(coefficient), "p_value": float(p_value)}


def spearman(x: Sequence[float], y: Sequence[float]) -> dict[str, float | int | None]:
    xa, ya = _clean_xy(x, y)
    result = pearson(rankdata(xa), rankdata(ya))
    return result


def benjamini_hochberg(p_values: Sequence[float], alpha: float = 0.05) -> dict[str, list[float] | list[bool]]:
    """Return BH-adjusted q-values and rejection flags in original order."""
    p = np.asarray(p_values, dtype=float)
    if np.any(~np.isfinite(p)) or np.any((p < 0) | (p > 1)):
        raise ValueError("p-values must be finite numbers in [0, 1]")
    m = len(p)
    if m == 0:
        return {"q_values": [], "reject": []}
    order = np.argsort(p, kind="mergesort")
    sorted_q = np.minimum.accumulate((p[order] * m / np.arange(1, m + 1))[::-1])[::-1]
    q = np.empty(m, dtype=float)
    q[order] = np.clip(sorted_q, 0, 1)
    return {"q_values": q.tolist(), "reject": (q <= alpha).tolist()}


def holm_bonferroni(p_values: Sequence[float], alpha: float = 0.05) -> dict[str, list[float] | list[bool]]:
    """Closed-form Holm step-down correction, retained for auditable comparisons."""
    p = np.asarray(p_values, dtype=float)
    if np.any(~np.isfinite(p)) or np.any((p < 0) | (p > 1)):
        raise ValueError("p-values must be finite numbers in [0, 1]")
    m = len(p)
    if not m:
        return {"adjusted_p_values": [], "reject": []}
    order = np.argsort(p, kind="mergesort")
    adjusted_sorted = np.maximum.accumulate((m - np.arange(m)) * p[order])
    adjusted = np.empty(m, dtype=float)
    adjusted[order] = np.clip(adjusted_sorted, 0, 1)
    reject_sorted = p[order] <= alpha / (m - np.arange(m))
    # Step-down rejection stops after the first failed ordered test.
    first_failure = np.where(~reject_sorted)[0]
    if len(first_failure):
        reject_sorted[first_failure[0] :] = False
    reject = np.empty(m, dtype=bool)
    reject[order] = reject_sorted
    return {"adjusted_p_values": adjusted.tolist(), "reject": reject.tolist()}


def quantile_bins(values: Sequence[float], buckets: int = 4) -> tuple[np.ndarray, np.ndarray]:
    values = np.asarray(values, dtype=float)
    if buckets < 2:
        raise ValueError("buckets must be at least 2")
    quantiles = np.linspace(0, 1, buckets + 1)
    edges = np.quantile(values, quantiles)
    edges = np.unique(edges)
    if len(edges) < 2:
        return edges, np.zeros(len(values), dtype=int)
    labels = np.searchsorted(edges[1:-1], values, side="right")
    return edges, labels


def mutual_information(x: Sequence[float], y: Sequence[float], buckets: int = 4) -> dict[str, float | int]:
    xa, ya = _clean_xy(x, y)
    n = len(xa)
    if n == 0:
        return {"n": 0, "mutual_information": 0.0}
    _, xb = quantile_bins(xa, buckets)
    _, yb = quantile_bins(ya, buckets)
    mi = 0.0
    for xi in np.unique(xb):
        for yi in np.unique(yb):
            joint = np.sum((xb == xi) & (yb == yi)) / n
            if joint == 0:
                continue
            px = np.sum(xb == xi) / n
            py = np.sum(yb == yi) / n
            mi += joint * math.log(joint / (px * py))
    return {"n": n, "mutual_information": float(mi)}


def mean_stats(values: Iterable[float]) -> dict[str, float | int | None]:
    array = np.asarray(list(values), dtype=float)
    array = array[np.isfinite(array)]
    if not len(array):
        return {"n": 0, "mean": None, "median": None, "std": None}
    return {"n": int(len(array)), "mean": float(np.mean(array)), "median": float(np.median(array)), "std": float(np.std(array, ddof=1)) if len(array) > 1 else 0.0}


def bootstrap_ci(values: Sequence[float], seed: int = 0, draws: int = 400) -> dict[str, float | int | None]:
    array = np.asarray(values, dtype=float)
    array = array[np.isfinite(array)]
    if len(array) < 2:
        return {"n": int(len(array)), "low": None, "high": None}
    rng = np.random.default_rng(seed)
    samples = rng.choice(array, size=(draws, len(array)), replace=True)
    medians = np.median(samples, axis=1)
    return {"n": int(len(array)), "low": float(np.quantile(medians, 0.025)), "high": float(np.quantile(medians, 0.975))}
