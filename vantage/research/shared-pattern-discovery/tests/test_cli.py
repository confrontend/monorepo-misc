import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from shared_pattern_discovery.cli import _write_progress_file


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "fixtures" / "synthetic.json"


class CliTests(unittest.TestCase):
    def test_progress_file_retries_transient_windows_replace_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            progress = Path(directory) / "progress.json"
            real_replace = os.replace
            attempts = 0

            def flaky_replace(source, destination):
                nonlocal attempts
                attempts += 1
                if attempts < 3:
                    error = PermissionError("destination is temporarily locked")
                    error.winerror = 5
                    raise error
                real_replace(source, destination)

            with patch("shared_pattern_discovery.cli.os.replace", side_effect=flaky_replace), patch(
                "shared_pattern_discovery.cli.time.sleep"
            ) as sleep:
                written = _write_progress_file(
                    progress, {"stage": "testing", "completed": 1}
                )

            self.assertTrue(written)
            self.assertEqual(attempts, 3)
            self.assertEqual(
                json.loads(progress.read_text()),
                {"stage": "testing", "completed": 1},
            )
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])
            self.assertEqual(sleep.call_count, 2)

    def test_progress_file_failure_is_non_fatal_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            progress = Path(directory) / "progress.json"
            error = PermissionError("destination remains locked")
            error.winerror = 5

            with patch(
                "shared_pattern_discovery.cli.os.replace", side_effect=error
            ), patch("shared_pattern_discovery.cli.time.sleep"):
                written = _write_progress_file(progress, {"stage": "testing"})

            self.assertFalse(written)
            self.assertFalse(progress.exists())
            self.assertEqual(list(Path(directory).glob("*.tmp")), [])

    def test_cli_writes_project_local_json_report(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "report.json"
            progress = Path(directory) / "progress.json"
            result = subprocess.run(
                [
                    sys.executable,
                    "-m",
                    "shared_pattern_discovery.cli",
                    "--project",
                    "unusualwhales",
                    "--input",
                    str(FIXTURE),
                    "--output",
                    str(output),
                    "--min-n",
                    "4",
                    "--progress-file",
                    str(progress),
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(output.read_text())
            self.assertEqual(report["project"], "unusualwhales")
            self.assertEqual(report["isolation"]["shared_database_opened"], False)
            self.assertIn("status_counts", report)
            self.assertIn("stage", json.loads(progress.read_text()))

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
