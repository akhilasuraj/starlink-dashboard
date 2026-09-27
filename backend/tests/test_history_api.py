import asyncio
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from backend.history import HistoryStore
from backend.server import Collector, DishUnreachable, app


ONLINE = {
    "state": "CONNECTED",
    "id": "ut-history-fixture",
    "uptime": 7200,
    "downlink_throughput_bps": 0,
    "uplink_throughput_bps": 0,
    "pop_ping_latency_ms": 41,
    "pop_ping_drop_rate": 0,
}
HISTORY = (
    {"samples": 4, "end_counter": 104},
    {
        "downlink_throughput_bps": [0, 1_000_000, 2_000_000, 3_000_000],
        "uplink_throughput_bps": [0, 100_000, 200_000, 300_000],
        "pop_ping_latency_ms": [35, None, 50, 40],
        "pop_ping_drop_rate": [0, 1, 0, 0.1],
    },
)


class FixtureTransport:
    def __init__(self, statuses, histories):
        self.statuses = iter(statuses)
        self.histories = iter(histories)

    def read_status(self):
        value = next(self.statuses)
        if isinstance(value, Exception):
            raise value
        return value

    def read_history(self):
        value = next(self.histories)
        if isinstance(value, Exception):
            raise value
        return value


class HistoryApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "history.sqlite3"
        self.clock = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)
        self.client = TestClient(app)

    def collector(self, statuses, histories, db=None):
        collector = Collector(
            FixtureTransport(statuses, histories),
            now=lambda: self.clock,
            history_store=HistoryStore(db or self.db),
        )
        app.state.collector = collector
        return collector

    def history(self):
        response = self.client.get("/api/history")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def observed(self, history):
        return [sample for sample in history["samples"] if sample["time_basis"] != "uncollected"]

    def test_dish_history_has_estimated_times_units_and_real_zero(self):
        collector = self.collector([ONLINE], [HISTORY])
        asyncio.run(collector.poll_once())
        history = self.history()
        samples = self.observed(history)
        self.assertEqual(history["window_seconds"], 900)
        self.assertEqual(len(samples), 4)
        self.assertEqual(samples[0]["at"], "2026-09-27T11:59:57Z")
        self.assertEqual(samples[0]["observed_at"], "2026-09-27T12:00:00Z")
        self.assertEqual(samples[0]["time_basis"], "estimated_from_poll")
        self.assertEqual(samples[0]["metrics"]["download_mbps"], {
            "value": 0.0, "unit": "Mbps", "availability": "available",
            "source": "starlink-grpc-core.history_bulk_data", "observed_at": "2026-09-27T12:00:00Z",
            "time_basis": "estimated_from_poll",
        })
        self.assertEqual(samples[1]["metrics"]["latency_ms"]["availability"], "unavailable")
        self.assertIsNone(samples[1]["metrics"]["latency_ms"]["value"])
        self.assertEqual(samples[1]["metrics"]["drop_rate"]["value"], 1)
        self.assertEqual(samples[-1]["metrics"]["upload_mbps"]["value"], 0.3)
        self.assertTrue(any(sample["time_basis"] == "uncollected" for sample in history["samples"]))

    def test_history_survives_restart_and_overlapping_counters_do_not_duplicate(self):
        collector = self.collector([ONLINE, ONLINE], [HISTORY, HISTORY])
        asyncio.run(collector.poll_once())
        self.clock += timedelta(seconds=10)
        asyncio.run(collector.poll_once())
        first = self.observed(self.history())
        self.assertEqual(len([sample for sample in first if sample["time_basis"] == "estimated_from_poll"]), 4)
        self.assertEqual(len([sample for sample in first if sample["time_basis"] == "observed_poll"]), 1)
        self.collector([], [], db=self.db)
        second = self.observed(self.history())
        self.assertEqual(second, first)

    def test_missing_history_fields_remain_unavailable_not_zero(self):
        partial = ({"samples": 3, "end_counter": 203}, {
            "pop_ping_drop_rate": [0, 0.2, 1],
            "downlink_throughput_bps": [0],
        })
        collector = self.collector([ONLINE], [partial])
        asyncio.run(collector.poll_once())
        samples = self.observed(self.history())
        self.assertEqual(len(samples), 3)
        self.assertEqual(samples[0]["metrics"]["download_mbps"]["value"], 0)
        self.assertEqual(samples[1]["metrics"]["download_mbps"]["availability"], "unavailable")
        self.assertIsNone(samples[1]["metrics"]["latency_ms"]["value"])
        self.assertEqual(samples[2]["metrics"]["latency_ms"]["value"], 41)

    def test_partial_dish_history_preserves_status_latency_and_loss_at_same_time(self):
        partial = ({"samples": 1, "end_counter": 301}, {
            "downlink_throughput_bps": [2_000_000],
            "uplink_throughput_bps": [100_000],
        })
        collector = self.collector([ONLINE], [partial])
        asyncio.run(collector.poll_once())
        at_capture = [sample for sample in self.observed(self.history())
                      if sample["at"] == "2026-09-27T12:00:00Z"]
        self.assertEqual(len(at_capture), 1)
        sample = at_capture[0]
        self.assertEqual(sample["metrics"]["download_mbps"]["value"], 2)
        self.assertEqual(sample["metrics"]["download_mbps"]["source"], "starlink-grpc-core.history_bulk_data")
        self.assertEqual(sample["metrics"]["latency_ms"]["value"], 41)
        self.assertEqual(sample["metrics"]["latency_ms"]["source"], "starlink-grpc-core.status_data")
        self.assertEqual(sample["metrics"]["latency_ms"]["time_basis"], "observed_poll")
        self.assertEqual(sample["metrics"]["drop_rate"]["value"], 0)

    def test_failed_poll_is_an_uncollected_gap(self):
        collector = self.collector([ONLINE, DishUnreachable("timed out")], [HISTORY])
        asyncio.run(collector.poll_once())
        self.clock += timedelta(seconds=4)
        asyncio.run(collector.poll_once())
        history = self.history()
        self.assertEqual(history["samples"][-1]["time_basis"], "uncollected")
        self.assertIsNone(history["samples"][-1]["metrics"]["download_mbps"]["value"])

    def test_counter_reset_after_reboot_keeps_new_samples(self):
        rebooted = {**ONLINE, "uptime": 5}
        new_history = ({"samples": 2, "end_counter": 2}, {
            "downlink_throughput_bps": [4_000_000, 5_000_000],
            "uplink_throughput_bps": [0, 0],
            "pop_ping_latency_ms": [42, 43],
            "pop_ping_drop_rate": [0, 0],
        })
        collector = self.collector([ONLINE, rebooted], [HISTORY, new_history])
        asyncio.run(collector.poll_once())
        self.clock += timedelta(seconds=10)
        asyncio.run(collector.poll_once())
        dish_samples = [sample for sample in self.observed(self.history())
                        if sample["time_basis"] == "estimated_from_poll"]
        self.assertEqual(len(dish_samples), 6)
        self.assertEqual(dish_samples[-1]["metrics"]["download_mbps"]["value"], 5)

    def test_history_rpc_failure_keeps_observed_status_sample(self):
        collector = self.collector([ONLINE], [RuntimeError("history unavailable")])
        asyncio.run(collector.poll_once())
        samples = self.observed(self.history())
        self.assertEqual(len(samples), 1)
        self.assertEqual(samples[0]["time_basis"], "observed_poll")
        self.assertEqual(samples[0]["metrics"]["download_mbps"]["value"], 0)
        self.assertEqual(self.client.get("/api/status").json()["service_state"], "online")


if __name__ == "__main__":
    unittest.main()
