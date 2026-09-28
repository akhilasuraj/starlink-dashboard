import asyncio
import hashlib
import json
from pathlib import Path
import tempfile
import subprocess
import sys
import unittest
from datetime import datetime

from fastapi.testclient import TestClient

from backend.history import HistoryStore
from backend.server import Collector, app


class CapturedTransport:
    def __init__(self, capture):
        self.capture = capture

    def read_status(self):
        return self.capture["status"]

    def read_history(self):
        return self.capture["history"]["general"], self.capture["history"]["bulk"]

    def read_dish_diagnostics(self):
        return self.capture["dish_diagnostics"]

    def read_router_diagnostics(self):
        return self.capture["router_diagnostics"]

    def read_obstruction_map(self):
        return self.capture["obstruction_map"]


class LiveCaptureApiTests(unittest.TestCase):
    def test_committed_capture_matches_hardware_evidence_hash_and_has_canonical_line_endings(self):
        root = Path(__file__).resolve().parents[2]
        record_path = root / "docs/hardware-validation.json"
        record = json.loads(record_path.read_text())
        data = (record_path.parent / record["capture"]["path"]).read_bytes()
        self.assertNotIn(b"\r", data)
        self.assertEqual(hashlib.sha256(data).hexdigest(), record["capture"]["sha256"])

    def test_capture_command_requires_new_explicit_paths_before_reading_hardware(self):
        root = Path(__file__).resolve().parents[2]
        command = [sys.executable, str(root / "build/capture-hardware.py")]
        missing = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(missing.returncode, 2)
        self.assertIn("--capture-output", missing.stderr)
        existing = subprocess.run(command + ["--capture-output", str(root / "backend/tests/fixtures/live-standard4-2026-09-28.json"),
                                             "--record-output", str(root / "docs/hardware-validation.json")],
                                  capture_output=True, text=True, timeout=10)
        self.assertEqual(existing.returncode, 2)
        self.assertIn("existing hardware evidence will not be overwritten", existing.stderr)

    def test_sanitized_standard4_capture_exercises_status_history_and_capabilities(self):
        capture = json.loads((Path(__file__).parent / "fixtures" / "live-standard4-2026-09-28.json").read_text())
        self.assertTrue(capture["sanitized"])
        clock = datetime.fromisoformat(capture["observed_at"].replace("Z", "+00:00"))
        with tempfile.TemporaryDirectory() as directory:
            collector = Collector(CapturedTransport(capture), now=lambda: clock,
                                  history_store=HistoryStore(Path(directory) / "history.sqlite3"))
            app.state.collector = collector
            app.state.session_token = "fixture-session-token"

            async def collect():
                await collector.poll_once()
                if collector.obstruction_map_task:
                    await collector.obstruction_map_task

            asyncio.run(collect())
            client = TestClient(app, headers={"Authorization": "Bearer fixture-session-token"})
            status = client.get("/api/status").json()
            self.assertEqual(status["collection_state"], "reachable")
            self.assertEqual(status["device"]["software"]["availability"], "available")
            self.assertEqual(status["metrics"]["latency_ms"]["unit"], "ms")
            self.assertEqual(status["metrics"]["drop_rate"]["unit"], "fraction")
            self.assertEqual(status["metrics"]["latency_ms"]["availability"], "available")
            self.assertEqual(status["device"]["id"]["availability"], "unavailable")
            history = client.get("/api/history").json()
            self.assertGreater(len(history["samples"]), 0)
            self.assertEqual(history["range"], "15m")
