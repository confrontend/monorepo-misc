import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path

from shared_pattern_discovery.exporters.uw_coverage import CoverageDiagnosticError, diagnose_unusualwhales


def make_coverage_fixture(path: Path) -> None:
    db = sqlite3.connect(path)
    db.executescript(
        """
        CREATE TABLE uw_option_trades (
          id INTEGER PRIMARY KEY, executed_at TEXT, underlying_symbol TEXT,
          signal_type TEXT, premium TEXT, size INTEGER, open_interest INTEGER
        );
        CREATE TABLE uw_signal_outcomes (
          id INTEGER PRIMARY KEY, trade_id INTEGER, horizon TEXT, outcome_at TEXT,
          return_pct REAL, spy_return_pct REAL, excess_return_pct REAL,
          exclusion_reason TEXT
        );
        INSERT INTO uw_option_trades VALUES
          (1,'2026-01-01T00:00:00Z','AAA','call_sweep','100',2,10),
          (2,'2026-01-01T01:00:00Z','BBB','call_sweep','200',4,NULL),
          (3,'2026-01-01T02:00:00Z','CCC','put_sweep',NULL,6,30);
        INSERT INTO uw_signal_outcomes VALUES
          (1,1,'+1d','2026-01-02T00:00:00Z',10,2,8,NULL),
          (2,2,'+1d','2026-01-02T01:00:00Z',NULL,NULL,NULL,'missing_entry_price'),
          (3,1,'+5m','2026-01-01T00:05:00Z',4,1,3,NULL);
        """
    )
    db.commit()
    db.close()


class CoverageDiagnosticTests(unittest.TestCase):
    def test_diagnostic_reports_coverage_and_known_field_missingness_read_only(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fixture.sqlite"
            output = root / "diagnostic.json"
            make_coverage_fixture(source)
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            report = diagnose_unusualwhales(source, output, project="unusualwhales", horizon="1d", limit=3)
            after = hashlib.sha256(source.read_bytes()).hexdigest()
            horizon = report["horizons"]["+1d"]
            self.assertEqual(before, after)
            self.assertEqual(horizon["event_sample_size"], 3)
            self.assertEqual(horizon["outcome_row_count"], 2)
            self.assertEqual(horizon["missing_outcome_row_count"], 1)
            self.assertEqual(horizon["mature_count"], 2)
            self.assertEqual(horizon["usable_count"], 1)
            fields = {item["field"]: item for item in horizon["missingness_comparisons"]}
            self.assertEqual(fields["premium"]["usable_sample_size"], 1)
            self.assertEqual(fields["premium"]["nonusable_sample_size"], 2)
            self.assertEqual(fields["open_interest"]["nonusable_missing_n"], 1)
            self.assertFalse(report["survivorship"]["provable_from_current_database"])

    def test_all_horizons_and_isolation_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_root = root / "unusualwhales"
            source_root.mkdir()
            source = source_root / "fixture.sqlite"
            make_coverage_fixture(source)
            report = diagnose_unusualwhales(source, root / "all.json", project="unusualwhales", horizon="all", limit=2)
            self.assertEqual(set(report["horizons"]), {"+5m", "+30m", "+1h", "+1d", "+3d"})
            with self.assertRaisesRegex(CoverageDiagnosticError, "only accepts project"):
                diagnose_unusualwhales(source, root / "bad.json", project="crypto")
            with self.assertRaisesRegex(CoverageDiagnosticError, "must not be inside"):
                diagnose_unusualwhales(source, source_root / "bad.json", project="unusualwhales")
