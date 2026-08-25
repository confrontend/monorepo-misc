import json
import tempfile
import unittest
from pathlib import Path

from shared_pattern_discovery.exporters.gmgn import GmgnExportError, normalize_gmgn_export


def payload(project="crypto", coverage_scope="outcome_minimum_percent"):
    return {
        "metadata": {"project": project, "coverage_scope": coverage_scope, "minimum_coverage_percent": 90, "outcome": "net_return_after_costs"},
        "rows": [{
            "project": "crypto", "event_id": "e1", "event_time": "2026-08-01T00:00:00Z",
            "entity_id": "TOKEN", "signal_type": "gmgn_copy_round_trip", "independence_group": "WALLET",
            "wallet_address": "WALLET", "coverage_rate_percent": 95, "coverage_status": "partially_covered",
            "features": {
                "wallet_address": "WALLET", "token_symbol": "TOKEN", "token_address": "TOKEN",
                "chain": "sol", "signal_type": "gmgn_copy_round_trip",
                "prior_wallet_buy_count": 2, "prior_wallet_median_hold_seconds": 30,
            },
            "mature": True, "usable": True, "net_return_after_costs": 4.5,
        }],
    }


class GmgnExporterTests(unittest.TestCase):
    def test_json_only_adapter_preserves_normalized_rows_and_marks_database_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "export.json"
            output = root / "normalized.json"
            source.write_text(json.dumps(payload()), encoding="utf-8")
            result = normalize_gmgn_export(source, output)
            self.assertEqual(result["metadata"]["adapter"], "shared_pattern_discovery.exporters.gmgn")
            self.assertFalse(result["metadata"]["shared_engine_database_opened"])
            self.assertEqual(result["metadata"]["feature_source"], "features")
            self.assertEqual(result["metadata"]["feature_allowlist_version"], "gmgn-v4-historical-context")
            self.assertEqual(json.loads(output.read_text())["rows"][0]["event_id"], "e1")

    def test_adapter_refuses_cross_project_or_wrong_coverage_scope_input(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "export.json"
            source.write_text(json.dumps(payload(project="unusualwhales")), encoding="utf-8")
            with self.assertRaisesRegex(GmgnExportError, "Project isolation"):
                normalize_gmgn_export(source, root / "out.json")
            source.write_text(json.dumps(payload(coverage_scope="local_history_only")), encoding="utf-8")
            with self.assertRaisesRegex(GmgnExportError, "outcome_minimum_percent"):
                normalize_gmgn_export(source, root / "out.json")

    def test_adapter_rejects_leakage_inside_explicit_features_object(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "export.json"
            value = payload()
            value["rows"][0]["features"]["wallet_return_percent"] = 999
            source.write_text(json.dumps(value), encoding="utf-8")
            with self.assertRaisesRegex(GmgnExportError, "post-event or disallowed"):
                normalize_gmgn_export(source, root / "out.json")
