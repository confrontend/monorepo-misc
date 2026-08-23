import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from shared_pattern_discovery.exporters.uw import ExportError, export_unusualwhales


def make_fixture(path: Path) -> None:
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE uw_option_trades (
          id INTEGER PRIMARY KEY, source_trade_id TEXT NOT NULL, executed_at TEXT,
          captured_at TEXT NOT NULL, signal_type TEXT NOT NULL, underlying_symbol TEXT,
          expiry TEXT, strike TEXT, premium TEXT, price TEXT, size INTEGER,
          underlying_price TEXT, open_interest INTEGER, volume INTEGER,
          nbbo_bid TEXT, nbbo_ask TEXT, report_flags TEXT NOT NULL, tags TEXT NOT NULL
        );
        CREATE TABLE uw_option_features (
          trade_id INTEGER PRIMARY KEY, volume_oi_ratio REAL, spread_pct REAL,
          moneyness_pct REAL, side_score REAL
        );
        CREATE TABLE uw_signal_outcomes (
          id INTEGER PRIMARY KEY, trade_id INTEGER NOT NULL, horizon TEXT NOT NULL,
          outcome_at TEXT, return_pct REAL, spy_return_pct REAL,
          excess_return_pct REAL, exclusion_reason TEXT
        );
        INSERT INTO uw_option_trades VALUES
          (1,'trade-1','2026-01-01T18:00:00Z','2026-01-01T18:01:00Z','call_sweep','TEST','2026-01-03','100','12.5','1.25',2,'101',50,100,'1.20','1.30','["flag"]','["tag"]'),
          (2,'trade-2','2026-01-02T18:00:00Z','2026-01-02T18:01:00Z','call_sweep','TEST','2026-01-04','101','13.5','1.35',3,'102',60,110,'1.30','1.40','[]','[]');
        INSERT INTO uw_option_features VALUES (1,2.0,0.1,0.2,1.0);
        INSERT INTO uw_signal_outcomes VALUES (1,1,'+1d','2026-01-02T18:00:00Z',5.0,2.0,3.0,NULL);
        """
    )
    db.commit()
    db.close()


class ExporterTests(unittest.TestCase):
    def test_read_only_export_derives_dte_and_preserves_missing_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fixture.sqlite"
            output = root / "export.json"
            make_fixture(source)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            payload = export_unusualwhales(source, output, project="unusualwhales", horizon="1d", limit=2, cost_bps=10)
            after = hashlib.sha256(source.read_bytes()).hexdigest()
            self.assertEqual(before, after)
            self.assertEqual(payload["metadata"]["horizon"], "+1d")
            self.assertEqual(payload["metadata"]["export_rows"], 2)
            self.assertEqual(payload["metadata"]["mature_rows"], 1)
            self.assertEqual(payload["metadata"]["usable_rows"], 1)
            first, second = payload["rows"]
            self.assertAlmostEqual(first["dte_days"], 1.25)
            self.assertAlmostEqual(first["net_return_after_costs"], 4.9)
            self.assertTrue(first["mature"])
            self.assertTrue(first["usable"])
            self.assertIsNone(second["net_return_after_costs"])
            self.assertFalse(second["mature"])
            self.assertFalse(second["usable"])
            self.assertIsNone(second["benchmark_return"])
            self.assertEqual(first["independence_group"], "TEST")

    def test_project_and_output_isolation_are_loud(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fixture.sqlite"
            make_fixture(source)
            with self.assertRaisesRegex(ExportError, "only accepts project"):
                export_unusualwhales(source, root / "out.json", project="crypto")
            with self.assertRaisesRegex(ExportError, "differ"):
                export_unusualwhales(source, source, project="unusualwhales")

    def test_limit_is_bounded_and_unknown_horizon_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fixture.sqlite"
            make_fixture(source)
            payload = export_unusualwhales(source, root / "out.json", project="unusualwhales", horizon="+5m", limit=1)
            self.assertEqual(len(payload["rows"]), 1)
            self.assertEqual(payload["metadata"]["horizon"], "+5m")
            with self.assertRaisesRegex(ExportError, "Unsupported UW horizon"):
                export_unusualwhales(source, root / "bad.json", project="unusualwhales", horizon="2d")
