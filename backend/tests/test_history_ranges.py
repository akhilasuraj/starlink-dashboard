import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from backend.history import HistoryStore
from backend.server import Collector, app


NOW = datetime(2026, 9, 27, 12, tzinfo=timezone.utc)
STATUS = {"state": "CONNECTED", "id": "ut-range", "downlink_throughput_bps": 0,
          "uplink_throughput_bps": 0, "pop_ping_latency_ms": 40, "pop_ping_drop_rate": 0}


class NoTransport:
    pass


class HistoryRangeApiTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = HistoryStore(Path(temporary.name) / "history.sqlite3")
        app.state.collector = Collector(NoTransport(), now=lambda: NOW, history_store=self.store)
        self.client = TestClient(app)

    def history(self, range_name):
        response = self.client.get("/api/history", params={"range": range_name})
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_three_ranges_are_bounded_and_report_actual_coverage(self):
        old = NOW - timedelta(days=6)
        middle = NOW - timedelta(hours=12)
        recent = NOW - timedelta(minutes=1)
        for at in (old, middle, recent):
            self.store.record_status(STATUS, at)
        expected = {
            "15m": (900, recent),
            "24h": (86400, middle),
            "7d": (604800, old),
        }
        for range_name, (seconds, first) in expected.items():
            with self.subTest(range_name=range_name):
                result = self.history(range_name)
                self.assertEqual(result["range"], range_name)
                self.assertEqual(result["window_seconds"], seconds)
                self.assertEqual(result["window_start"], (NOW - timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z"))
                self.assertEqual(result["window_end"], "2026-09-27T12:00:00Z")
                self.assertEqual(result["coverage_start"], first.isoformat().replace("+00:00", "Z"))
                self.assertEqual(result["coverage_end"], recent.isoformat().replace("+00:00", "Z"))
                self.assertTrue(any(sample["time_basis"] == "uncollected" for sample in result["samples"]))
                self.assertFalse(any(sample["metrics"]["download_mbps"]["value"] is not None and
                                     sample["at"] < result["coverage_start"] for sample in result["samples"]))

    def test_24_hour_rollup_exposes_sparse_coverage_and_real_zero(self):
        at = NOW - timedelta(hours=1, minutes=3)
        self.store.record_status(STATUS, at)
        self.store.record_status({**STATUS, "downlink_throughput_bps": 4_000_000}, at + timedelta(seconds=2))
        result = self.history("24h")
        measured = [sample for sample in result["samples"] if sample["time_basis"] == "rollup"]
        self.assertEqual(result["bucket_seconds"], 300)
        self.assertEqual(len(measured), 1)
        self.assertEqual(measured[0]["sample_count"], 2)
        self.assertEqual(measured[0]["metrics"]["download_mbps"]["value"], 2)
        self.assertEqual(measured[0]["metrics"]["upload_mbps"]["value"], 0)
        self.assertEqual(measured[0]["observed_start"], at.isoformat().replace("+00:00", "Z"))
        self.assertEqual(measured[0]["observed_end"], (at + timedelta(seconds=2)).isoformat().replace("+00:00", "Z"))
        self.assertEqual(measured[0]["metrics"]["download_mbps"]["availability"], "available")
        self.assertGreater(len([sample for sample in result["samples"] if sample["time_basis"] == "uncollected"]), 200)

    def test_7_day_rollup_keeps_outage_boundaries_and_does_not_fill_older_time(self):
        at = NOW - timedelta(days=3)
        self.store.record_status(STATUS, at)
        self.store.record_outage_state("ut-range", "NO_PINGS", at, offline=True, continuity_seconds=6)
        self.store.record_outage_state("ut-range", "CONNECTED", at + timedelta(seconds=4), offline=False, continuity_seconds=6)
        result = self.history("7d")
        self.assertEqual(result["bucket_seconds"], 1800)
        self.assertEqual(len(result["outages"]), 1)
        self.assertEqual(result["outages"][0]["first_observed_at"], at.isoformat().replace("+00:00", "Z"))
        self.assertEqual(result["outages"][0]["recovery_observed_at"], (at + timedelta(seconds=4)).isoformat().replace("+00:00", "Z"))
        self.assertEqual(result["coverage_start"], at.isoformat().replace("+00:00", "Z"))

    def test_rollup_prefers_dish_history_per_metric_and_preserves_status_fallback(self):
        at = NOW - timedelta(hours=2)
        self.store.record_status({**STATUS, "downlink_throughput_bps": 7_000_000}, at)
        self.store.ingest_dish_history(
            {"samples": 1, "end_counter": 1},
            {"downlink_throughput_bps": [2_000_000], "uplink_throughput_bps": [None],
             "pop_ping_latency_ms": [None], "pop_ping_drop_rate": [None]},
            at + timedelta(seconds=1), "ut-range", 100,
        )
        measured = [sample for sample in self.history("24h")["samples"]
                    if sample["time_basis"] == "rollup"]
        self.assertEqual(len(measured), 1)
        self.assertEqual(measured[0]["sample_count"], 1)
        self.assertEqual(measured[0]["metrics"]["download_mbps"]["value"], 2)
        self.assertIn("history_bulk_data", measured[0]["metrics"]["download_mbps"]["source"])
        self.assertEqual(measured[0]["metrics"]["latency_ms"]["value"], 40)
        self.assertIn("status_data", measured[0]["metrics"]["latency_ms"]["source"])

    def test_duplicate_history_timestamp_keeps_value_and_provenance_from_one_row(self):
        at = NOW - timedelta(hours=2)
        self.store.record_status({**STATUS, "downlink_throughput_bps": 7_000_000}, at)
        self.store.ingest_dish_history(
            {"samples": 1, "end_counter": 100},
            {"downlink_throughput_bps": [9_000_000]}, at + timedelta(seconds=1), "ut-range", 100,
        )
        self.store.ingest_dish_history(
            {"samples": 2, "end_counter": 2},
            {"downlink_throughput_bps": [5_000_000, None]},
            at + timedelta(seconds=2), "ut-range", 5,
        )
        measured = [sample for sample in self.history("24h")["samples"]
                    if sample["time_basis"] == "rollup"]
        self.assertEqual(len(measured), 1)
        download = measured[0]["metrics"]["download_mbps"]
        self.assertEqual(download["value"], 5)
        self.assertEqual(download["sample_count"], 1)
        self.assertEqual(download["observed_at"], (at + timedelta(seconds=2)).isoformat().replace("+00:00", "Z"))
        self.assertIn("history_bulk_data", download["source"])

    def test_invalid_range_is_rejected(self):
        self.assertEqual(self.client.get("/api/history?range=30d").status_code, 422)


if __name__ == "__main__":
    unittest.main()
