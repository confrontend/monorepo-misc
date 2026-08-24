from __future__ import annotations

import hashlib
import json
import math
import random
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

import numpy as np

from .stats import (
    benjamini_hochberg,
    bootstrap_ci,
    dependency_status,
    mean_stats,
    mutual_information,
    pearson,
    quantile_bins,
    spearman,
)
from .validation import ValidatedDataset


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) else None


def _feature_value(row: dict[str, Any], feature: str) -> Any:
    """Read an explicit feature view when present; never fall back to legacy row fields."""
    features = row.get("features")
    if isinstance(features, dict):
        return features.get(feature)
    return row.get(feature)


def _iso_sort_key(row: dict[str, Any]) -> str:
    return str(row["event_time"])


def _groups(rows: Iterable[dict[str, Any]]) -> int:
    return len({row["independence_group"] for row in rows})


def _wallet_key(row: dict[str, Any]) -> str:
    wallet = row.get("wallet_address")
    if isinstance(wallet, str) and wallet:
        return wallet
    group = str(row.get("independence_group", ""))
    return group.split(":entry:", 1)[0]


def _wallet_weights(rows: Iterable[dict[str, Any]]) -> list[float]:
    materialized = list(rows)
    counts: dict[str, int] = {}
    for row in materialized:
        key = _wallet_key(row)
        counts[key] = counts.get(key, 0) + 1
    return [1.0 / counts[_wallet_key(row)] for row in materialized]


def _weighted_mean(values: list[float], weights: list[float]) -> float:
    total = float(sum(weights))
    return float(sum(value * weight for value, weight in zip(values, weights)) / total) if total else 0.0


def _weighted_correlation(xs: list[float], ys: list[float], weights: list[float]) -> float | None:
    if len(xs) < 2 or len(xs) != len(ys) or len(xs) != len(weights):
        return None
    mean_x = _weighted_mean(xs, weights)
    mean_y = _weighted_mean(ys, weights)
    covariance = sum(weight * (x - mean_x) * (y - mean_y) for x, y, weight in zip(xs, ys, weights))
    variance_x = sum(weight * (x - mean_x) ** 2 for x, weight in zip(xs, weights))
    variance_y = sum(weight * (y - mean_y) ** 2 for y, weight in zip(ys, weights))
    denominator = math.sqrt(variance_x * variance_y)
    return float(covariance / denominator) if denominator > 0 else None


def _eligible(rows: Iterable[dict[str, Any]], outcome: str) -> list[dict[str, Any]]:
    return [row for row in rows if row["mature"] and row["usable"] and _number(row.get(outcome)) is not None]


def _feature_values(rows: Iterable[dict[str, Any]], feature: str) -> tuple[list[float], list[float], list[dict[str, Any]]]:
    xs: list[float] = []
    ys: list[float] = []
    kept: list[dict[str, Any]] = []
    for row in rows:
        x = _number(_feature_value(row, feature))
        if x is None:
            continue
        y = _number(row.get("__outcome"))
        if y is None:
            continue
        xs.append(x)
        ys.append(y)
        kept.append(row)
    return xs, ys, kept


def _p_value_for_difference(group: np.ndarray, baseline: np.ndarray) -> float:
    if len(group) < 2 or len(baseline) < 2:
        return 1.0
    pooled = math.sqrt(max(1e-18, float(np.var(group, ddof=1) / len(group) + np.var(baseline, ddof=1) / len(baseline))))
    if pooled == 0:
        return 0.0 if float(np.mean(group)) != float(np.mean(baseline)) else 1.0
    z = abs(float(np.mean(group) - np.mean(baseline))) / pooled
    return math.erfc(z / math.sqrt(2.0))


def _condition_mask(rows: list[dict[str, Any]], condition: dict[str, Any]) -> np.ndarray:
    feature = condition["feature"]
    values = np.asarray([_number(_feature_value(row, feature)) if _number(_feature_value(row, feature)) is not None else np.nan for row in rows], dtype=float)
    mask = np.isfinite(values)
    if "lower" in condition:
        mask &= values >= float(condition["lower"])
    if "upper" in condition:
        mask &= values <= float(condition["upper"])
    if condition.get("operator") == "<":
        mask &= values < float(condition["value"])
    if condition.get("operator") == "<=":
        mask &= values <= float(condition["value"])
    if condition.get("operator") == ">":
        mask &= values > float(condition["value"])
    if condition.get("operator") == ">=":
        mask &= values >= float(condition["value"])
    return mask


def _tree_discovery(rows: list[dict[str, Any]], feature_names: list[str], min_n: int, seed: int) -> tuple[list[dict[str, Any]], dict[str, float], str, dict[str, float]]:
    usable = [row for row in rows if _number(row.get("__outcome")) is not None]
    if len(usable) < min_n or not feature_names:
        return [], {}, "not_fitted_insufficient_data", {}
    x_rows: list[list[float]] = []
    y: list[float] = []
    model_rows: list[dict[str, Any]] = []
    feature_medians = {
        feature: float(np.median([_number(_feature_value(row, feature)) for row in usable if _number(_feature_value(row, feature)) is not None]))
        for feature in feature_names
        if any(_number(_feature_value(row, feature)) is not None for row in usable)
    }
    for row in usable:
        values = [_number(_feature_value(row, feature)) for feature in feature_names]
        if any(value is not None for value in values):
            # Model-only median imputation is computed from discovery rows. Missing outcomes
            # are never imputed, and the report retains missingness diagnostics separately.
            x_rows.append([float(value) if value is not None else feature_medians[feature] for feature, value in zip(feature_names, values)])
            y.append(float(row["__outcome"]))
            model_rows.append(row)
    if len(x_rows) < min_n:
        return [], {}, "not_fitted_insufficient_data", {}
    x = np.asarray(x_rows, dtype=float)
    ya = np.asarray(y, dtype=float)
    try:
        from sklearn.ensemble import RandomForestRegressor  # type: ignore
        from sklearn.inspection import permutation_importance  # type: ignore
        model = RandomForestRegressor(n_estimators=64, max_depth=4, random_state=seed, n_jobs=1)
        model.fit(x, ya, sample_weight=np.asarray(_wallet_weights(model_rows), dtype=float))
        importances = {feature: float(value) for feature, value in zip(feature_names, model.feature_importances_) if value > 0}
        perm = permutation_importance(model, x, ya, n_repeats=8, random_state=seed, scoring="neg_mean_squared_error", n_jobs=1)
        permutation = {feature: float(value) for feature, value in zip(feature_names, perm.importances_mean) if math.isfinite(float(value))}
        model_kind = "sklearn.RandomForestRegressor"
    except ImportError:
        # Deterministic fallback: a bootstrap ensemble of one-feature median stumps, with
        # the same train-vs-permuted MSE evidence that permutation_importance provides.
        rng = np.random.default_rng(seed)
        gains = np.zeros(len(feature_names), dtype=float)
        stumps: list[tuple[int, float, float, float]] = []
        for _ in range(64):
            sample = rng.integers(0, len(x), len(x))
            ys = ya[sample]
            parent = float(np.var(ys))
            best: tuple[float, int, float, float, float] | None = None
            for j in range(len(feature_names)):
                threshold = float(np.median(x[sample, j]))
                left, right = ys[x[sample, j] <= threshold], ys[x[sample, j] > threshold]
                if not len(left) or not len(right):
                    continue
                gain = parent - (len(left) * np.var(left) + len(right) * np.var(right)) / len(ys)
                gains[j] += max(0.0, float(gain))
                candidate = (float(gain), j, threshold, float(np.mean(left)), float(np.mean(right)))
                if best is None or candidate[0] > best[0]:
                    best = candidate
            if best is not None:
                stumps.append((best[1], best[2], best[3], best[4]))
        if gains.sum() > 0:
            gains /= gains.sum()
        importances = {feature: float(value) for feature, value in zip(feature_names, gains) if value > 0}
        model_kind = "numpy.bootstrap_median_stump_ensemble"

        def predict(values: np.ndarray) -> np.ndarray:
            if not stumps:
                return np.full(len(values), float(np.mean(ya)))
            predictions = []
            for feature_index, threshold, left_mean, right_mean in stumps:
                predictions.append(np.where(values[:, feature_index] <= threshold, left_mean, right_mean))
            return np.mean(np.asarray(predictions), axis=0)

        baseline_mse = float(np.mean((ya - predict(x)) ** 2))
        permutation = {}
        for index, feature in enumerate(feature_names):
            permuted = x.copy()
            permuted[:, index] = permuted[rng.permutation(len(permuted)), index]
            permutation[feature] = float(np.mean((ya - predict(permuted)) ** 2) - baseline_mse)

    rules: list[dict[str, Any]] = []
    for feature, importance in sorted(importances.items(), key=lambda item: item[1], reverse=True)[:5]:
        values = np.asarray([_number(_feature_value(row, feature)) for row in usable], dtype=float)
        values = values[np.isfinite(values)]
        if len(values) < min_n:
            continue
        threshold = float(np.median(values))
        rules.append({
            "source": "shallow_tree_rule",
            "conditions": [{"feature": feature, "operator": ">=", "value": threshold}],
            "feature": feature,
            "importance": importance,
            "discovery_sample_size": 0,
            "_tree_rule": True,
        })
    return rules, importances, model_kind, permutation


def _attach_outcome(rows: list[dict[str, Any]], outcome: str) -> list[dict[str, Any]]:
    return [dict(row, __outcome=row.get(outcome)) for row in rows]


def _effect_summary(rows: list[dict[str, Any]], condition: dict[str, Any], outcome: str) -> dict[str, Any]:
    eligible = _eligible(rows, outcome)
    masks = _condition_mask(eligible, condition)
    selected = [row for row, keep in zip(eligible, masks) if keep]
    values = [float(row[outcome]) for row in selected if _number(row.get(outcome)) is not None]
    all_values = [float(row[outcome]) for row in eligible if _number(row.get(outcome)) is not None]
    all_weights = _wallet_weights(eligible)
    selected_weights = [weight for row, weight, keep in zip(eligible, all_weights, masks) if keep]
    base = _weighted_mean(all_values, all_weights) if all_values else 0.0
    effect = _weighted_mean(values, selected_weights) - base if values else 0.0
    return {
        "sample_size": len(values),
        "independence_groups": _groups(selected),
        "mean_return": _weighted_mean(values, selected_weights) if values else None,
        "median_return": float(np.median(values)) if values else None,
        "effect_vs_all": effect,
        "top_3_effect_share": _top_effect_share(values, base),
        "wallets": len({_wallet_key(row) for row in selected}),
        "bootstrap_median_ci": bootstrap_ci(values),
    }


def _top_effect_share(values: list[float], baseline: float) -> float | None:
    contributions = np.sort(np.abs(np.asarray(values, dtype=float) - baseline))[::-1]
    total = float(np.sum(contributions))
    return float(np.sum(contributions[:3]) / total) if total > 0 else None


def _validation_for_pattern(pattern: dict[str, Any], rows: list[dict[str, Any]], outcome: str, min_n: int) -> tuple[bool, dict[str, Any]]:
    eligible = _eligible(rows, outcome)
    if pattern.get("kind") == "correlation":
        feature = pattern["feature"]
        xs = [_number(_feature_value(row, feature)) for row in eligible]
        ys = [_number(row.get(outcome)) for row in eligible]
        pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
        paired_rows = [row for row in eligible if _number(_feature_value(row, feature)) is not None]
        coefficient = _weighted_correlation([x for x, _ in pairs], [y for _, y in pairs], _wallet_weights(paired_rows))
        passed = len(pairs) >= min_n and coefficient is not None and float(coefficient) * float(pattern["effect"]) > 0
        return passed, {"sample_size": len(pairs), "independence_groups": _groups(paired_rows), "wallets": len({_wallet_key(row) for row in paired_rows}), "coefficient": coefficient, "weighting": "equal wallet total weight"}
    condition = pattern["conditions"][0]
    summary = _effect_summary(rows, condition, outcome)
    discovery_effect = float(pattern.get("effect", pattern.get("discovery_effect", 0.0)))
    validation_effect = float(summary["effect_vs_all"] or 0.0)
    passed = summary["sample_size"] >= min_n and validation_effect * discovery_effect > 0
    return passed, summary


def _feature_summary(rows: list[dict[str, Any]], feature: str) -> dict[str, Any]:
    present = [_feature_value(row, feature) for row in rows if _feature_value(row, feature) is not None]
    numeric = [_number(value) for value in present]
    numeric = [value for value in numeric if value is not None]
    result: dict[str, Any] = {"feature": feature, "rows": len(rows), "present": len(present), "missing": len(rows) - len(present), "missing_fraction": (len(rows) - len(present)) / len(rows)}
    if len(numeric) == len(present) and numeric:
        result["kind"] = "numeric"
        result["summary"] = mean_stats(numeric)
        result["quantiles"] = {str(q): float(np.quantile(numeric, q)) for q in (0.05, 0.25, 0.5, 0.75, 0.95)}
    else:
        counts: dict[str, int] = {}
        for value in present:
            key = str(value)
            counts[key] = counts.get(key, 0) + 1
        result["kind"] = "categorical"
        result["top_values"] = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:20]
    return result


def _missingness_check(rows: list[dict[str, Any]], feature: str, outcome: str) -> dict[str, Any]:
    with_outcome = [row for row in rows if row["mature"] and row["usable"] and _number(row.get(outcome)) is not None]
    without_outcome = [row for row in rows if row not in with_outcome]
    yes = [_number(_feature_value(row, feature)) for row in with_outcome]
    no = [_number(_feature_value(row, feature)) for row in without_outcome]
    yes = [value for value in yes if value is not None]
    no = [value for value in no if value is not None]
    difference = float(np.mean(yes) - np.mean(no)) if yes and no else None
    scale = float(np.std(yes + no)) if yes and no else None
    return {"feature": feature, "with_outcome_n": len(yes), "without_outcome_n": len(no), "with_outcome_mean": float(np.mean(yes)) if yes else None, "without_outcome_mean": float(np.mean(no)) if no else None, "mean_difference": difference, "standardized_difference": (difference / scale) if difference is not None and scale and scale > 0 else None, "flagged_material_difference": bool(difference is not None and scale and scale > 0 and abs(difference / scale) >= 0.5)}


def run_discovery(
    dataset: ValidatedDataset,
    config: dict[str, Any],
    *,
    project: str,
    min_n: int = 30,
    validation_fraction: float = 0.3,
    holdout_fraction: float = 0.0,
    buckets: int = 4,
    fdr_alpha: float = 0.05,
    seed: int = 0,
    input_path: str | None = None,
    output_path: str | None = None,
) -> dict[str, Any]:
    """Run V1 discovery on one validated export; no database or cross-project state is used."""
    if project != config.get("project") or project != dataset.metadata.get("project"):
        raise ValueError("Project isolation violation: dataset, config, and run project must match")
    if min_n < 2:
        raise ValueError("min_n must be at least 2")
    if not 0 <= validation_fraction < 1 or not 0 <= holdout_fraction < 1 or validation_fraction + holdout_fraction >= 1:
        raise ValueError("validation_fraction and holdout_fraction must be in [0,1) and leave discovery rows")
    rows = sorted(dataset.rows, key=_iso_sort_key)
    n = len(rows)
    discovery_end = max(1, int(n * (1 - validation_fraction - holdout_fraction)))
    validation_end = max(discovery_end, int(n * (1 - holdout_fraction)))
    discovery = _attach_outcome(rows[:discovery_end], dataset.outcome)
    validation = _attach_outcome(rows[discovery_end:validation_end], dataset.outcome)
    holdout = _attach_outcome(rows[validation_end:], dataset.outcome)
    allow_names = [item["name"] for item in dataset.allow_list]
    # Discovery-only operations must not inspect the final holdout, including feature
    # eligibility and descriptive summaries. Full-row counts remain safe metadata.
    numeric_features = [feature for feature in allow_names if any(_number(_feature_value(row, feature)) is not None for row in discovery)]
    feature_summaries = [_feature_summary(discovery, feature) for feature in allow_names if any(feature in row for row in discovery)]
    eligible_discovery = _eligible(discovery, dataset.outcome)
    eligible_validation = _eligible(validation, dataset.outcome)
    candidates: list[dict[str, Any]] = []
    corrected_entries: list[tuple[dict[str, Any], float]] = []

    if not numeric_features:
        candidates.append({
            "source": "feature_gate",
            "kind": "feature_gate",
            "feature": "pre_event_numeric_features",
            "conditions": [],
            "discovery_sample_size": len(eligible_discovery),
            "validationStatus": "insufficient data",
            "validation_status": "insufficient_data",
            "reason": "No numeric pre-event features remain after the project allow-list and explicit features-object gate",
        })

    for feature in numeric_features:
        xs = [_number(_feature_value(row, feature)) for row in eligible_discovery]
        ys = [_number(row.get(dataset.outcome)) for row in eligible_discovery]
        pairs = [(x, y) for x, y in zip(xs, ys) if x is not None and y is not None]
        if len(pairs) < min_n:
            candidates.append({"source": "pearson", "kind": "correlation", "feature": feature, "conditions": [{"feature": feature, "operator": "correlation", "value": "any"}], "discovery_sample_size": len(pairs), "validationStatus": "insufficient data", "validation_status": "insufficient_data", "reason": "discovery sample below minimum-N"})
            continue
        for method, result in (("pearson", pearson([p[0] for p in pairs], [p[1] for p in pairs])), ("spearman", spearman([p[0] for p in pairs], [p[1] for p in pairs]))):
            if result["coefficient"] is None:
                continue
            p_value = 1.0 if result["p_value"] is None else float(result["p_value"])
            paired_rows = [row for row in eligible_discovery if _number(_feature_value(row, feature)) is not None]
            balanced_effect = _weighted_correlation([p[0] for p in pairs], [p[1] for p in pairs], _wallet_weights(paired_rows))
            if balanced_effect is None:
                continue
            pattern = {"source": method, "kind": "correlation", "feature": feature, "conditions": [{"feature": feature, "operator": "correlation", "value": "positive" if balanced_effect >= 0 else "negative"}], "effect": float(balanced_effect), "p_value": p_value, "discovery_sample_size": len(pairs), "discovery_independence_groups": _groups(paired_rows), "discovery_wallets": len({_wallet_key(row) for row in paired_rows}), "weighting": "equal wallet total weight"}
            candidates.append(pattern)
            corrected_entries.append((pattern, p_value))

        paired_rows = [row for row in eligible_discovery if _number(_feature_value(row, feature)) is not None]
        paired_weights = _wallet_weights(paired_rows)
        edges, labels = quantile_bins(np.asarray([p[0] for p in pairs]), buckets)
        all_effect_values = [p[1] for p in pairs]
        all_effect_weights = paired_weights
        for label in sorted(set(labels.tolist())):
            group_values = [p[1] for p, bucket in zip(pairs, labels) if bucket == label]
            group_weights = [weight for weight, bucket in zip(paired_weights, labels) if bucket == label]
            if len(group_values) == 0:
                continue
            lower = float(edges[label])
            upper = float(edges[label + 1]) if label + 1 < len(edges) else float(edges[-1])
            condition = {"feature": feature, "lower": lower, "upper": upper}
            effect = float(_weighted_mean(group_values, group_weights) - _weighted_mean(all_effect_values, all_effect_weights))
            pattern = {"source": "quantile_bucket", "kind": "bucket", "feature": feature, "conditions": [condition], "effect": effect, "p_value": _p_value_for_difference(np.asarray(group_values, dtype=float), np.asarray([p[1] for p, b in zip(pairs, labels) if b != label], dtype=float)), "discovery_sample_size": int(len(group_values)), "discovery_independence_groups": _groups([row for row in eligible_discovery if _number(_feature_value(row, feature)) is not None and lower <= float(_feature_value(row, feature)) <= upper]), "discovery_wallets": len({_wallet_key(row) for row, bucket in zip(paired_rows, labels) if bucket == label}), "weighting": "equal wallet total weight"}
            candidates.append(pattern)
            corrected_entries.append((pattern, float(pattern["p_value"])))

        mi = mutual_information([p[0] for p in pairs], [p[1] for p in pairs], buckets)
        candidates.append({"source": "mutual_information", "kind": "mutual_information", "feature": feature, "conditions": [{"feature": feature, "operator": "information", "value": "quantile_binned"}], "effect": float(mi["mutual_information"]), "mutual_information": float(mi["mutual_information"]), "discovery_sample_size": len(pairs), "discovery_independence_groups": _groups([row for row in eligible_discovery if _number(_feature_value(row, feature)) is not None])})

    tree_rules, importances, tree_kind, permutation_importance = _tree_discovery(eligible_discovery, numeric_features, min_n, seed)
    for rule in tree_rules:
        summary = _effect_summary(eligible_discovery, rule["conditions"][0], dataset.outcome)
        rule["discovery_sample_size"] = summary["sample_size"]
        rule["discovery_independence_groups"] = summary["independence_groups"]
        rule["effect"] = summary["effect_vs_all"]
        candidates.append(rule)

    correction = benjamini_hochberg([p for _, p in corrected_entries], alpha=fdr_alpha)
    for (pattern, _), q_value, reject in zip(corrected_entries, correction["q_values"], correction["reject"]):
        pattern["q_value"] = float(q_value)
        pattern["multiple_testing_rejected"] = not bool(reject)
    finalized: list[dict[str, Any]] = []
    for pattern in candidates:
        if pattern.get("validationStatus") == "insufficient data":
            finalized.append(pattern)
            continue
        if pattern.get("multiple_testing_rejected"):
            pattern["validationStatus"] = "rejected"
            pattern["validation_status"] = "rejected"
            pattern["reason"] = "enumerated-search FDR correction failed"
            finalized.append(pattern)
            continue
        if pattern.get("kind") == "mutual_information" and float(pattern.get("effect", 0)) <= 0:
            pattern["validationStatus"] = "rejected"
            pattern["validation_status"] = "rejected"
            pattern["reason"] = "zero mutual information"
            finalized.append(pattern)
            continue
        if pattern.get("kind") in {"bucket", "shallow_tree_rule"}:
            pattern["discovery_effect_summary"] = _effect_summary(eligible_discovery, pattern["conditions"][0], dataset.outcome)
        passed, validation_summary = _validation_for_pattern(pattern, eligible_validation, dataset.outcome, min_n)
        pattern["validation"] = validation_summary
        if validation_summary.get("sample_size", 0) < min_n:
            pattern["validationStatus"] = "insufficient data"
            pattern["validation_status"] = "insufficient_data"
            pattern["reason"] = "validation sample below minimum-N"
        elif passed:
            pattern["validationStatus"] = "validation survivor"
            pattern["validation_status"] = "validation_survivor"
        else:
            pattern["validationStatus"] = "rejected"
            pattern["validation_status"] = "rejected"
            pattern["reason"] = "direction or effect did not survive chronological validation"
        finalized.append(pattern)

    for pattern in finalized:
        pattern.pop("_tree_rule", None)
    run_id = hashlib.sha256(f"{project}|{input_path}|{output_path}|{seed}".encode()).hexdigest()[:16]
    status_counts = {status: sum(pattern.get("validationStatus") == status for pattern in finalized) for status in ("discovered candidate", "validation survivor", "rejected", "insufficient data")}
    report = {
        "report_version": "shared-discovery-v1",
        "project": project,
        "run_id": run_id,
        "dependencies": dependency_status(),
        "isolation": {
            "project": project,
            "input_path": str(Path(input_path).resolve()) if input_path else None,
            "output_path": str(Path(output_path).resolve()) if output_path else None,
            "cache_path": str((Path(output_path).resolve().parent / ".cache" / project / run_id)) if output_path else None,
            "model_path": str((Path(output_path).resolve().parent / ".models" / project / run_id)) if output_path else None,
            "shared_database_opened": False,
            "cross_project_state": False,
            "model_reuse": False,
        },
        "input_contract": {
            "schema_version": dataset.metadata.get("schema_version"),
            "feature_allowlist_version": dataset.metadata.get("feature_allowlist_version"),
            "allow_list": dataset.allow_list,
            "examined_fields": dataset.examined_fields,
            "rejected_fields": dataset.rejected_fields,
            "reject_by_default": config.get("reject_by_default", []),
            "outcome": dataset.outcome,
        },
        "dataset_summary": {
            "rows": n,
            "eligible_outcome_rows": len(_eligible(rows, dataset.outcome)),
            "mature_rows": sum(row["mature"] for row in rows),
            "usable_rows": sum(row["usable"] for row in rows),
            "outcome_coverage": sum(row["usable"] for row in rows) / n,
            "independence_groups": _groups(rows),
            "time_start": rows[0]["event_time"],
            "time_end": rows[-1]["event_time"],
            "wallets": len({_wallet_key(row) for row in rows}),
            "weighting": "equal wallet total weight; each row weight is 1 / eligible rows for its wallet",
        },
        "missingness_checks": [_missingness_check(discovery, feature, dataset.outcome) for feature in numeric_features],
        "feature_summaries": feature_summaries,
        "split": {
            "method": "chronological",
            "discovery_uses_event_ids": [row["event_id"] for row in discovery],
            "validation_uses_event_ids": [row["event_id"] for row in validation],
            "discovery_rows": len(discovery),
            "discovery_eligible_rows": len(eligible_discovery),
            "validation_rows": len(validation),
            "validation_eligible_rows": len(eligible_validation),
            "untouched_holdout_rows": len(holdout),
            "untouched_holdout_eligible_rows": len(_eligible(holdout, dataset.outcome)),
            "validation_fraction": validation_fraction,
            "holdout_fraction": holdout_fraction,
            "holdout_policy": "untouched: excluded from feature summaries, candidate generation, model fitting, validation, correction, and status assignment; counts only are reported",
            "holdout_used_for_discovery": False,
            "holdout_used_for_validation": False,
            "holdout_used_for_model_fit": False,
            "holdout_used_for_multiple_testing": False,
            "wallet_aware": True,
        },
        "multiple_testing": {"method": "Benjamini-Hochberg FDR", "alpha": fdr_alpha, "enumerated_comparisons": len(corrected_entries), "tree_search_correction": "not applied; validation survival and untouched holdout are the protection"},
        "model": {"ensemble": tree_kind, "permutation_importance": permutation_importance, "permutation_importance_method": "sklearn.inspection.permutation_importance" if tree_kind.startswith("sklearn") else "deterministic NumPy train-vs-permuted MSE for bootstrap stump ensemble", "feature_importance": importances, "shallow_rule_count": len(tree_rules)},
        "minimum_n": min_n,
        "patterns": finalized,
        "status_counts": status_counts,
        "language": "ML and statistical findings are discovery evidence, not profitability claims; validation survivors require independent backtesting.",
    }
    return report
