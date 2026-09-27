import asyncio
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi.testclient import TestClient

from backend.history import HistoryStore
from backend.server import Collector, DishUnreachable, app


FIXTURES = Path(__file__).parent / "fixtures"


class FixtureTransport:
    def __init__(self, *readings, dish_diagnostics=None, router_diagnostics=None):
        self.readings = iter(readings)
        self.dish_diagnostics = iter(dish_diagnostics) if isinstance(dish_diagnostics, list) else dish_diagnostics
        self.router_diagnostics = iter(router_diagnostics) if isinstance(router_diagnostics, list) else router_diagnostics

    def read_status(self):
        reading = next(self.readings)
        if isinstance(reading, Exception):
            raise reading
        return reading

    def read_dish_diagnostics(self):
        value = next(self.dish_diagnostics) if hasattr(self.dish_diagnostics, "__next__") else self.dish_diagnostics
        if isinstance(value, Exception):
            raise value
        return value

    def read_router_diagnostics(self):
        value = next(self.router_diagnostics) if hasattr(self.router_diagnostics, "__next__") else self.router_diagnostics
        if isinstance(value, Exception):
            raise value
        return value


class StatusApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.client = TestClient(app)
        self.clock = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)

    def fixture(self, name):
        return json.loads((FIXTURES / name).read_text(encoding="utf-8"))

    def collector(self, *readings, dish_diagnostics=None, router_diagnostics=None):
        collector = Collector(
            FixtureTransport(*readings, dish_diagnostics=dish_diagnostics,
                             router_diagnostics=router_diagnostics), now=lambda: self.clock,
            history_store=HistoryStore(Path(self.temp.name) / "history.sqlite3"),
        )
        app.state.collector = collector
        return collector

    def test_supported_diagnostics_identify_dish_and_optional_router(self):
        reading = self.fixture("online-idle.json")
        reading["alert_details"] = {"alert_motors_stuck": False, "alert_slow_ethernet_speeds": True}
        collector = self.collector(
            reading,
            dish_diagnostics={"id": "ut-official", "hardware_version": "rev-official",
                              "software_version": "firmware-official",
                              "alerts": {"motors_stuck": False, "slow_ethernet_speeds": True}},
            router_diagnostics={"id": "Router-fixture", "hardware_version": "router-rev",
                                "software_version": "router-firmware"},
        )
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["device"]["hardware"]["value"], "rev-official")
        self.assertEqual(status["device"]["hardware"]["source"], "SpaceX Device API GetDiagnostics")
        self.assertEqual(status["router"]["id"]["value"], "Router-fixture")
        self.assertEqual(status["router"]["software"]["value"], "router-firmware")
        self.assertEqual(status["alerts"]["availability"], "available")
        self.assertEqual(status["alerts"]["source"], "SpaceX Device API GetDiagnostics")
        self.assertEqual([item["code"] for item in status["alerts"]["items"] if item["active"]],
                         ["slow_ethernet_speeds"])
        self.assertTrue(status["capabilities"]["router_diagnostics"])
        self.assertTrue(status["capabilities"]["dish_alerts"])

    def test_router_failure_and_partial_diagnostics_leave_dish_available(self):
        reading = self.fixture("online-idle.json")
        reading.pop("hardware_version")
        reading.pop("gps_sats")
        collector = self.collector(
            reading,
            dish_diagnostics={"id": "ut-official", "hardware_version": "rev-official"},
            router_diagnostics=RuntimeError("router not present"),
        )
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["collection_state"], "reachable")
        self.assertEqual(status["service_state"], "online")
        self.assertEqual(status["device"]["hardware"]["value"], "rev-official")
        self.assertEqual(status["device"]["software"]["value"], "firmware-fixture")
        self.assertEqual(status["device"]["software"]["source"], "starlink-grpc-core.status_data")
        self.assertEqual(status["router"]["id"]["availability"], "unavailable")
        self.assertEqual(status["alerts"]["availability"], "unavailable")
        self.assertEqual(status["metrics"]["gps_sats"]["availability"], "unavailable")
        self.assertFalse(status["capabilities"]["gps_sats"])
        self.assertFalse(status["capabilities"]["router_diagnostics"])

    def test_empty_diagnostics_response_does_not_claim_device_fields(self):
        collector = self.collector(self.fixture("online-idle.json"),
                                   dish_diagnostics={}, router_diagnostics={})
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["device"]["hardware"]["value"], "rev4")
        self.assertEqual(status["device"]["hardware"]["source"], "starlink-grpc-core.status_data")
        self.assertFalse(status["capabilities"]["dish_diagnostics"])
        self.assertFalse(status["capabilities"]["router_diagnostics"])
        self.assertEqual(status["alerts"]["availability"], "unavailable")

    def test_diagnostics_capabilities_become_stale_after_repeated_failures(self):
        reading = self.fixture("online-idle.json")
        collector = self.collector(
            reading, reading, reading,
            dish_diagnostics=[
                {"id": "ut-official", "hardware_version": "rev-official",
                 "alerts": {"motors_stuck": True}},
                RuntimeError("diagnostics timeout"), RuntimeError("diagnostics timeout"),
            ],
            router_diagnostics=[
                {"id": "Router-fixture", "hardware_version": "router-rev"},
                RuntimeError("router timeout"), RuntimeError("router timeout"),
            ],
        )
        asyncio.run(collector.poll_once())
        self.clock += timedelta(seconds=61)
        asyncio.run(collector.poll_once())
        self.clock += timedelta(seconds=61)
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["collection_state"], "reachable")
        self.assertEqual(status["router"]["id"]["value"], "Router-fixture")
        self.assertEqual(status["router"]["id"]["availability"], "stale")
        self.assertEqual(status["alerts"]["availability"], "stale")
        self.assertEqual(status["capability_states"]["dish_diagnostics"], "stale")
        self.assertEqual(status["capability_states"]["router_diagnostics"], "stale")
        self.assertEqual(status["capability_states"]["dish_alerts"], "stale")
        self.assertFalse(status["capabilities"]["dish_diagnostics"])
        self.assertFalse(status["capabilities"]["router_diagnostics"])
        self.assertFalse(status["capabilities"]["dish_alerts"])

    def test_all_false_community_alerts_without_official_confirmation_are_unavailable(self):
        reading = self.fixture("online-idle.json")
        reading["alert_details"] = {"alert_motors_stuck": False,
                                    "alert_obstructed": False}
        collector = self.collector(reading, dish_diagnostics=RuntimeError("not supported"))
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["service_state"], "online")
        self.assertEqual(status["alerts"]["availability"], "unavailable")
        self.assertFalse(status["capabilities"]["dish_alerts"])

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
        samples = [sample for sample in response.json()["samples"]
                   if sample["at"] >= "2026-09-27T12:00:00Z"]
        self.assertEqual(samples[0]["metrics"]["download_mbps"]["value"], 0)
        self.assertIsNone(samples[1]["metrics"]["download_mbps"]["value"])
        self.assertIsNone(samples[1]["metrics"]["upload_mbps"]["value"])
        self.assertEqual(samples[1]["time_basis"], "uncollected")


if __name__ == "__main__":
    unittest.main()
