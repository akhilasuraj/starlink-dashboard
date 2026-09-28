import asyncio
import json
import os
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend.history import HistoryStore
from backend.server import Collector, DishUnreachable, app
from backend.tests.fixture_status_api import core_status_fixture


FIXTURES = Path(__file__).parent / "fixtures"


class FixtureTransport:
    def __init__(self, *readings, dish_diagnostics=None, router_diagnostics=None, obstruction_map=None):
        self.readings = iter(readings)
        self.dish_diagnostics = iter(dish_diagnostics) if isinstance(dish_diagnostics, list) else dish_diagnostics
        self.router_diagnostics = iter(router_diagnostics) if isinstance(router_diagnostics, list) else router_diagnostics
        self.obstruction_map = iter(obstruction_map) if isinstance(obstruction_map, list) else obstruction_map

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

    def read_obstruction_map(self):
        value = next(self.obstruction_map) if hasattr(self.obstruction_map, "__next__") else self.obstruction_map
        if isinstance(value, Exception):
            raise value
        return value


class StatusApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        app.state.session_token = "fixture-session-token"
        self.client = TestClient(app, headers={"Authorization": "Bearer fixture-session-token"})
        self.clock = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)

    def fixture(self, name):
        return json.loads((FIXTURES / name).read_text(encoding="utf-8"))

    def collector(self, *readings, dish_diagnostics=None, router_diagnostics=None, obstruction_map=None):
        collector = Collector(
            FixtureTransport(*readings, dish_diagnostics=dish_diagnostics,
                             router_diagnostics=router_diagnostics, obstruction_map=obstruction_map), now=lambda: self.clock,
            history_store=HistoryStore(Path(self.temp.name) / "history.sqlite3"),
        )
        app.state.collector = collector
        return collector

    def test_obstruction_view_separates_observed_fraction_and_directional_snr_samples(self):
        reading = self.fixture("online-idle.json")
        reading["fraction_obstructed"] = 0.125
        reading["currently_obstructed"] = False
        collector = self.collector(reading, obstruction_map=((0.0, 0.5, -1.0), (1.0, 0.75, 0.25)))
        async def collect():
            await collector.poll_once()
            await collector.obstruction_map_task
        asyncio.run(collect())
        status = self.status()
        self.assertEqual(status["metrics"]["obstructed_pct"]["value"], 12.5)
        self.assertEqual(status["obstruction"]["currently_obstructed"]["value"], False)
        self.assertEqual(status["obstruction"]["currently_obstructed"]["availability"], "available")
        self.assertEqual(status["obstruction"]["signal_map"]["cells"],
                         [[0.0, 0.5, None], [1.0, 0.75, 0.25]])
        self.assertEqual(status["obstruction"]["signal_map"]["valid_cells"], 5)
        self.assertEqual(status["obstruction"]["signal_map"]["source"],
                         "starlink-grpc-core.obstruction_map")
        self.assertEqual(status["obstruction"]["signal_map"]["observed_at"], "2026-09-27T12:00:00Z")

    def test_absent_obstruction_message_defaults_stay_unavailable_in_public_status(self):
        collector = self.collector(core_status_fixture(self.fixture("obstruction-defaults.json")))
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["service_state"], "online")
        self.assertEqual(status["metrics"]["obstructed_pct"]["availability"], "unavailable")
        self.assertIsNone(status["metrics"]["obstructed_pct"]["source"])
        self.assertEqual(status["obstruction"]["currently_obstructed"]["availability"], "unavailable")

    def test_zero_obstruction_with_presence_evidence_is_a_real_public_reading(self):
        groups = self.fixture("obstruction-defaults.json")
        groups["obstruction_detail"]["valid_s"] = 3600.0
        collector = self.collector(core_status_fixture(groups))
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["metrics"]["obstructed_pct"]["value"], 0)
        self.assertEqual(status["metrics"]["obstructed_pct"]["availability"], "available")
        self.assertEqual(status["metrics"]["obstructed_pct"]["observed_at"], "2026-09-27T12:00:00Z")
        self.assertIs(status["obstruction"]["currently_obstructed"]["value"], False)

    def test_unsupported_obstruction_map_does_not_hide_reported_fraction(self):
        reading = self.fixture("online-idle.json")
        reading.pop("currently_obstructed", None)
        collector = self.collector(reading, obstruction_map=RuntimeError("unsupported RPC"))
        async def collect():
            await collector.poll_once()
            await collector.obstruction_map_task
        asyncio.run(collect())
        status = self.status()
        self.assertEqual(status["service_state"], "online")
        self.assertEqual(status["metrics"]["obstructed_pct"]["value"], 1)
        self.assertEqual(status["obstruction"]["currently_obstructed"]["availability"], "unavailable")
        self.assertEqual(status["obstruction"]["signal_map"]["availability"], "unavailable")
        self.assertEqual(status["obstruction"]["signal_map"]["reason"], "not_reported")

    def test_reported_obstruction_grid_with_no_valid_samples_retains_provenance(self):
        collector = self.collector(self.fixture("online-idle.json"),
                                   obstruction_map=((-1.0, -1.0), (-1.0, -1.0)))

        async def collect():
            await collector.poll_once()
            await collector.obstruction_map_task

        asyncio.run(collect())
        signal_map = self.status()["obstruction"]["signal_map"]
        self.assertEqual(signal_map["availability"], "unavailable")
        self.assertEqual(signal_map["reason"], "no_valid_samples")
        self.assertEqual(signal_map["valid_cells"], 0)
        self.assertIsNone(signal_map["cells"])
        self.assertEqual(signal_map["source"], "starlink-grpc-core.obstruction_map")
        self.assertEqual(signal_map["observed_at"], "2026-09-27T12:00:00Z")

    def test_old_signal_samples_are_stale_while_live_status_remains_reachable(self):
        reading = self.fixture("online-idle.json")
        collector = self.collector(
            reading, reading, reading,
            obstruction_map=[((0.2, 0.8),), RuntimeError("map request failed"),
                             RuntimeError("map request failed")],
        )
        async def collect():
            for index in range(3):
                if index:
                    self.clock += timedelta(seconds=61)
                await collector.poll_once()
                await collector.obstruction_map_task

        asyncio.run(collect())
        status = self.status()
        self.assertEqual(status["collection_state"], "reachable")
        self.assertEqual(status["obstruction"]["signal_map"]["availability"], "stale")
        self.assertEqual(status["obstruction"]["signal_map"]["observed_at"], "2026-09-27T12:00:00Z")
        self.assertEqual(status["obstruction"]["signal_map"]["cells"], [[0.2, 0.8]])

    def test_slow_optional_map_does_not_delay_fresh_status_polls(self):
        started = threading.Event()
        release = threading.Event()
        collector = self.collector(self.fixture("online-idle.json"), self.fixture("online-idle.json"))

        def slow_map():
            started.set()
            release.wait(timeout=3)
            return ((0.4,),)

        collector.telemetry.read_obstruction_map = slow_map

        async def collect():
            try:
                await asyncio.wait_for(collector.poll_once(), timeout=1)
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                self.clock += timedelta(seconds=2)
                await asyncio.wait_for(collector.poll_once(), timeout=1)
                status = self.status()
                self.assertEqual(status["collection_state"], "reachable")
                self.assertEqual(status["age_seconds"], 0)
                self.assertEqual(status["obstruction"]["signal_map"]["availability"], "unavailable")
            finally:
                release.set()
                if collector.obstruction_map_task:
                    await collector.obstruction_map_task

        asyncio.run(collect())

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

    def test_reported_ping_loss_is_impairment_without_confirming_an_outage(self):
        collector = self.collector({**self.fixture("online-idle.json"), "pop_ping_drop_rate": 0.1})
        asyncio.run(collector.poll_once())
        status = self.status()
        self.assertEqual(status["collection_state"], "reachable")
        self.assertEqual(status["service_state"], "impaired")
        self.assertEqual(status["status_text"], "Service impaired")
        self.assertEqual(self.client.get("/api/history").json()["outages"], [])

    def test_storage_initialization_failure_reports_error_and_next_poll_recovers(self):
        blocked_directory = Path(self.temp.name) / "data"
        blocked_directory.write_text("not a directory", encoding="utf-8")
        collector = Collector(FixtureTransport(self.fixture("online-idle.json")), now=lambda: self.clock)
        app.state.collector = collector
        with patch.dict(os.environ, {"STARLINK_DASHBOARD_DATA_DIR": str(blocked_directory)}):
            asyncio.run(collector.poll_once())
            self.assertEqual(self.status()["collection_state"], "collector_error")
            self.assertEqual(self.status()["service_state"], "unknown")
            blocked_directory.unlink()
            self.clock += timedelta(seconds=2)
            asyncio.run(collector.poll_once())
        self.assertEqual(self.status()["collection_state"], "reachable")
        samples = self.client.get("/api/history").json()["samples"]
        observed = [sample for sample in samples if sample["time_basis"] != "uncollected"]
        self.assertEqual([sample["at"] for sample in observed], ["2026-09-27T12:00:02Z"])

    def test_storage_write_and_gap_record_failure_do_not_stop_polling_or_invent_history(self):
        reading = self.fixture("online-idle.json")
        collector = self.collector(reading, reading, reading)
        asyncio.run(collector.poll_once())
        database = collector.history_store.path
        saved = database.with_suffix(".saved")
        database.rename(saved)
        database.mkdir()
        try:
            self.clock += timedelta(seconds=2)
            asyncio.run(collector.poll_once())
            self.assertEqual(self.status()["collection_state"], "collector_error")
            self.assertEqual(self.status()["service_state"], "unknown")
        finally:
            database.rmdir()
            saved.rename(database)
        self.clock += timedelta(seconds=2)
        asyncio.run(collector.poll_once())
        self.assertEqual(self.status()["collection_state"], "reachable")
        history = self.client.get("/api/history").json()
        observed = [sample for sample in history["samples"] if sample["time_basis"] != "uncollected"]
        self.assertEqual([sample["at"] for sample in observed],
                         ["2026-09-27T12:00:00Z", "2026-09-27T12:00:04Z"])
        self.assertTrue(any(sample["time_basis"] == "uncollected" and
                            "12:00:00" < sample["at"][11:19] < "12:00:04"
                            for sample in history["samples"]))
        self.assertEqual(history["outages"], [])

    def test_recovered_storage_does_not_bridge_outage_confirmation_across_failed_writes(self):
        offline = self.fixture("service-offline.json")
        collector = self.collector(offline, offline, offline)
        asyncio.run(collector.poll_once())
        database = collector.history_store.path
        saved = database.with_suffix(".saved")
        database.rename(saved)
        database.mkdir()
        try:
            self.clock += timedelta(seconds=2)
            asyncio.run(collector.poll_once())
        finally:
            database.rmdir()
            saved.rename(database)
        self.clock += timedelta(seconds=2)
        asyncio.run(collector.poll_once())
        outages = self.client.get("/api/history").json()["outages"]
        self.assertEqual(len(outages), 2)
        self.assertEqual(outages[0]["end_state"], "unobserved")
        self.assertEqual(outages[0]["last_confirmed_at"], "2026-09-27T12:00:00Z")
        self.assertEqual(outages[1]["first_observed_at"], "2026-09-27T12:00:04Z")

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
