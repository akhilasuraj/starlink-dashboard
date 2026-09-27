import asyncio
import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from backend.server import Collector, DishUnreachable, app


FIXTURES = Path(__file__).parent / "fixtures"


class FixtureTransport:
    def __init__(self, *readings):
        self.readings = iter(readings)

    def read_status(self):
        reading = next(self.readings)
        if isinstance(reading, Exception):
            raise reading
        return reading


class StatusApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app)
        self.clock = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)

    def fixture(self, name):
        return json.loads((FIXTURES / name).read_text(encoding="utf-8"))

    def collector(self, *readings):
        collector = Collector(FixtureTransport(*readings), now=lambda: self.clock)
        app.state.collector = collector
        return collector

    def status(self):
        response = self.client.get("/api/status")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def test_idle_traffic_is_still_online_when_dish_reports_connected(self):
        collector = self.collector(self.fixture("online-idle.json"))
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["collection_state"], "reachable")
        self.assertEqual(status["service_state"], "online")
        self.assertEqual(status["metrics"]["download_mbps"]["value"], 0)
        self.assertEqual(status["metrics"]["download_mbps"]["availability"], "available")
        self.assertEqual(status["metrics"]["download_mbps"]["source"], "starlink-grpc-core.status_data")
        self.assertEqual(status["metrics"]["download_mbps"]["observed_at"], "2026-09-27T12:00:00Z")
        self.assertEqual(status["source"], "starlink-grpc-core.status_data")
        self.assertIsNone(status["metrics"]["azimuth_deg"]["value"])
        self.assertEqual(status["metrics"]["azimuth_deg"]["availability"], "unavailable")
        self.assertTrue(status["capabilities"]["download_mbps"])
        self.assertFalse(status["capabilities"]["azimuth_deg"])

    def test_dish_reported_outage_is_offline_despite_successful_poll(self):
        collector = self.collector(self.fixture("service-offline.json"))
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["collection_state"], "reachable")
        self.assertEqual(status["service_state"], "offline")
        self.assertEqual(status["dish_state"], "NO_PINGS")

    def test_unrecognized_dish_state_is_unknown_not_assumed_offline(self):
        reading = self.fixture("online-idle.json")
        reading["state"] = "NEW_FIRMWARE_STATE"
        collector = self.collector(reading)
        asyncio.run(collector.poll_once())
        self.assertEqual(self.status()["service_state"], "unknown")

    def test_unreachable_dish_has_route_guidance_not_service_outage(self):
        collector = self.collector(DishUnreachable("connection timed out"))
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["collection_state"], "dish_unreachable")
        self.assertEqual(status["service_state"], "unknown")
        self.assertIn("192.168.100.1", status["guidance"])
        self.assertIn("third-party router", status["guidance"])

    def test_failed_refresh_keeps_last_values_but_marks_them_stale(self):
        collector = self.collector(self.fixture("online-idle.json"), DishUnreachable("timed out"))
        asyncio.run(collector.poll_once())
        self.clock += timedelta(seconds=10)
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["collection_state"], "dish_unreachable")
        self.assertTrue(status["stale"])
        self.assertEqual(status["service_state"], "unknown")
        self.assertEqual(status["metrics"]["download_mbps"]["availability"], "stale")
        self.assertEqual(status["metrics"]["download_mbps"]["value"], 0)
        self.assertEqual(status["last_known_service_state"], "online")

    def test_old_successful_reading_becomes_stale_without_new_poll(self):
        collector = self.collector(self.fixture("online-idle.json"))
        asyncio.run(collector.poll_once())
        self.clock += timedelta(seconds=10)
        status = self.status()
        self.assertEqual(status["collection_state"], "stale")
        self.assertEqual(status["service_state"], "unknown")

    def test_failed_poll_is_a_chart_gap_not_zero_traffic(self):
        collector = self.collector(self.fixture("online-idle.json"), DishUnreachable("timed out"))
        asyncio.run(collector.poll_once())
        self.clock += timedelta(seconds=2)
        asyncio.run(collector.poll_once())
        response = self.client.get("/api/history")
        self.assertEqual(response.status_code, 200)
        samples = response.json()["samples"]
        self.assertEqual(samples[0]["download_mbps"], 0)
        self.assertIsNone(samples[1]["download_mbps"])
        self.assertIsNone(samples[1]["upload_mbps"])
        self.assertIsNone(samples[1]["source"])


if __name__ == "__main__":
    unittest.main()
