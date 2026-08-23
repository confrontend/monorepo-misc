import json
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path

from shared_pattern_discovery.config import load_project_config
from shared_pattern_discovery.engine import run_discovery
from shared_pattern_discovery.validation import ValidatedDataset, load_dataset


ROOT = Path(__file__).resolve().parents[1]


class EngineTests(unittest.TestCase):
    def test_insufficient_and_rejected_are_distinct_end_to_end(self):
        config = load_project_config("unusualwhales")
        dataset = load_dataset(ROOT / "fixtures" / "synthetic.json", "unusualwhales", config)
        report = run_discovery(dataset, config, project="unusualwhales", min_n=4, validation_fraction=0.25, seed=3)
        statuses = {pattern["feature"]: pattern["validationStatus"] for pattern in report["patterns"] if pattern.get("feature")}
        self.assertIn("rejected", statuses.values())
        self.assertIn("insufficient data", statuses.values()) or self.assertIn("insufficient data", [p["validationStatus"] for p in report["patterns"]])
        self.assertEqual(report["project"], "unusualwhales")
        self.assertFalse(report["isolation"]["cross_project_state"])

    def test_allow_list_rejects_unlisted_fields_in_report(self):
        config = load_project_config("unusualwhales")
        payload = json.loads((ROOT / "fixtures" / "synthetic.json").read_text())
        payload["rows"][0]["future_leak"] = 999
        temporary = ROOT / "tests" / "_temporary_fixture.json"
        temporary.write_text(json.dumps(payload), encoding="utf-8")
        try:
            dataset = load_dataset(temporary, "unusualwhales", config)
            self.assertIn("future_leak", dataset.rejected_fields)
        finally:
            temporary.unlink()

    def test_validation_survivor_status_is_emitted_for_stable_signal(self):
        config = load_project_config("unusualwhales")
        dataset = load_dataset(ROOT / "fixtures" / "synthetic.json", "unusualwhales", config)
        report = run_discovery(dataset, config, project="unusualwhales", min_n=4, validation_fraction=0.25, holdout_fraction=0.125, seed=3)
        survivors = [pattern for pattern in report["patterns"] if pattern.get("validationStatus") == "validation survivor"]
        self.assertTrue(survivors)
        self.assertGreaterEqual(report["status_counts"]["validation survivor"], 1)

    def test_fallback_tree_and_permutation_evidence_is_deterministic(self):
        config = load_project_config("unusualwhales")
        dataset = load_dataset(ROOT / "fixtures" / "synthetic.json", "unusualwhales", config)
        first = run_discovery(dataset, config, project="unusualwhales", min_n=4, validation_fraction=0.25, holdout_fraction=0.125, seed=11)
        second = run_discovery(dataset, config, project="unusualwhales", min_n=4, validation_fraction=0.25, holdout_fraction=0.125, seed=11)
        self.assertIn("ensemble", first["model"])
        self.assertTrue(first["model"]["permutation_importance"])
        self.assertEqual(first["model"], second["model"])

    def test_holdout_is_not_used_by_discovery_or_validation(self):
        config = load_project_config("unusualwhales")
        dataset = load_dataset(ROOT / "fixtures" / "synthetic.json", "unusualwhales", config)
        changed_rows = deepcopy(dataset.rows)
        for row in changed_rows[-3:]:
            row["premium"] = 10_000_000
            row["size"] = -10_000_000
            row["net_return_1d"] = -10_000_000
        changed = ValidatedDataset(dataset.metadata, changed_rows, dataset.outcome, dataset.examined_fields, dataset.rejected_fields, dataset.allow_list)
        first = run_discovery(dataset, config, project="unusualwhales", min_n=4, validation_fraction=0.25, holdout_fraction=0.125, seed=3, input_path="same.json", output_path="same-report.json")
        second = run_discovery(changed, config, project="unusualwhales", min_n=4, validation_fraction=0.25, holdout_fraction=0.125, seed=3, input_path="same.json", output_path="same-report.json")
        self.assertEqual(first["patterns"], second["patterns"])
        self.assertEqual(first["model"], second["model"])
        self.assertEqual(first["feature_summaries"], second["feature_summaries"])
        self.assertFalse(first["split"]["holdout_used_for_discovery"])
        self.assertFalse(first["split"]["holdout_used_for_validation"])
        self.assertFalse(first["split"]["holdout_used_for_model_fit"])
        self.assertEqual(first["split"]["untouched_holdout_rows"], 3)

    def test_engine_refuses_a_cross_project_config(self):
        uw_config = load_project_config("unusualwhales")
        crypto_config = load_project_config("crypto")
        dataset = load_dataset(ROOT / "fixtures" / "synthetic.json", "unusualwhales", uw_config)
        with self.assertRaisesRegex(ValueError, "Project isolation"):
            run_discovery(dataset, crypto_config, project="crypto", min_n=4)

    def test_crypto_features_view_blocks_legacy_outcome_fields(self):
        config = load_project_config("crypto")
        rows = []
        for index in range(12):
            rows.append({
                "project": "crypto",
                "event_id": f"gmgn-{index}",
                "event_time": f"2026-08-01T00:{index:02d}:00Z",
                "entity_id": "TOKEN",
                "signal_type": "gmgn_copy_round_trip",
                "independence_group": f"WALLET-{index % 3}",
                "features": {},
                "wallet_return_percent": 1000 + index,
                "hold_seconds": 10 + index,
                "edge_kept_percent": 500 + index,
                "mature": True,
                "usable": True,
                "net_return_after_costs": float(index - 5),
            })
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "crypto.json"
            source.write_text(json.dumps({"metadata": {"project": "crypto", "outcome": "net_return_after_costs"}, "rows": rows}), encoding="utf-8")
            dataset = load_dataset(source, "crypto", config)
            report = run_discovery(dataset, config, project="crypto", min_n=2, validation_fraction=0.25, holdout_fraction=0.1)
        self.assertEqual(report["model"]["feature_importance"], {})
        self.assertEqual(report["status_counts"]["validation survivor"], 0)
        self.assertEqual(report["status_counts"]["insufficient data"], 1)
        self.assertIn("wallet_return_percent", report["input_contract"]["rejected_fields"])
        self.assertFalse(any(pattern.get("feature") in {"wallet_return_percent", "hold_seconds", "edge_kept_percent"} for pattern in report["patterns"]))
