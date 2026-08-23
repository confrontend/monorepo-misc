import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixtures" / "synthetic.json"


class CliTests(unittest.TestCase):
    def test_cli_writes_project_local_json_report(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            result = subprocess.run([sys.executable, "-m", "shared_pattern_discovery.cli", "--project", "unusualwhales", "--input", str(FIXTURE), "--output", str(output), "--min-n", "4"], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["project"], "unusualwhales")
            self.assertEqual(report["isolation"]["shared_database_opened"], False)
            self.assertIn("status_counts", report)

    def test_cli_refuses_mismatched_project_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            bad = Path(directory) / "bad.json"
            bad.write_text(json.dumps({"metadata": {"project": "crypto", "outcome": "net_return_1d"}, "rows": []}))
            output = Path(directory) / "report.json"
            result = subprocess.run([sys.executable, "-m", "shared_pattern_discovery.cli", "--project", "unusualwhales", "--input", str(bad), "--output", str(output)], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("Project isolation violation", result.stderr)

    def test_cli_refuses_database_input(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "source.sqlite"
            db.write_bytes(b"not a database")
            result = subprocess.run([sys.executable, "-m", "shared_pattern_discovery.cli", "--project", "unusualwhales", "--input", str(db), "--output", str(Path(directory) / "report.json")], cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("normalized .json or .csv", result.stderr)
