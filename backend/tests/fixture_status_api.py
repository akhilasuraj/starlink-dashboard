"""Emit a fixture-backed public status response for the renderer smoke test."""

import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

import starlink_grpc

from fastapi.testclient import TestClient

from backend.history import HistoryStore
from backend.server import Collector, DishUnreachable, app
from backend.telemetry import StarlinkTelemetry


FIXTURES = Path(__file__).parent / "fixtures"


class FixtureTransport:
    def __init__(self, *responses, history=None, dish_diagnostics=None, router_diagnostics=None,
                 obstruction_map=None):
        self.responses = iter(responses)
        self.history = history or ({"samples": 0, "end_counter": 0}, {})
        self.dish_diagnostics = iter(dish_diagnostics) if isinstance(dish_diagnostics, list) else dish_diagnostics
        self.router_diagnostics = iter(router_diagnostics) if isinstance(router_diagnostics, list) else router_diagnostics
        self.obstruction_map = iter(obstruction_map) if isinstance(obstruction_map, list) else obstruction_map

    def read_status(self):
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response

    def read_history(self):
        return self.history

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


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def core_status_fixture(groups):
    """Run a recorded core response through the real adapter before API collection."""
    with patch.object(starlink_grpc, "ChannelContext"), patch.object(
        starlink_grpc, "status_data", return_value=(
            groups["status"], groups["obstruction_detail"], groups["alert_detail"]
        ),
    ):
        telemetry = StarlinkTelemetry()
        try:
            return telemetry.read_status()
        finally:
            telemetry.close()


def main(scenario, endpoint="status", range_name="15m"):
    clock = [datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)]
    readings = {
        "online-idle": [fixture("online-idle.json")],
        "ping-unavailable": [{**fixture("online-idle.json"), "pop_ping_drop_rate": None}],
        "ping-total-loss": [{**fixture("online-idle.json"), "pop_ping_drop_rate": 1}],
        "service-impaired": [{**fixture("online-idle.json"), "pop_ping_drop_rate": 0.1}],
        "service-offline": [fixture("service-offline.json")],
        "dish-unreachable": [DishUnreachable("connection timed out")],
        "stale": [fixture("online-idle.json")],
        "history-quality": [fixture("online-idle.json")],
        "reported-outage": [fixture("service-offline.json"), fixture("service-offline.json"), fixture("online-idle.json")],
        "outage-boundary": [fixture("service-offline.json"), fixture("online-idle.json")],
        "outage-recovery-in-window": [fixture("service-offline.json"), fixture("online-idle.json")],
        "range-views": [fixture("online-idle.json")],
        "device-details": [{**fixture("online-idle.json"),
                            "alert_details": {"alert_motors_stuck": False,
                                              "alert_slow_ethernet_speeds": True}}],
        "router-unavailable": [{key: value for key, value in fixture("online-idle.json").items()
                                if key not in ("gps_sats", "hardware_version")}],
        "stale-diagnostics": [fixture("online-idle.json")] * 3,
        "community-alerts-all-clear": [{**fixture("online-idle.json"),
                                        "alert_details": {"alert_motors_stuck": False,
                                                          "alert_obstructed": False}}],
        "obstruction-supported": [{**fixture("online-idle.json"),
                                    "fraction_obstructed": 0.125,
                                    "currently_obstructed": False}],
        "obstruction-no-valid-samples": [fixture("online-idle.json")],
        "obstruction-stale": [fixture("online-idle.json")] * 3,
        "obstruction-unsupported": [{key: value for key, value in fixture("online-idle.json").items()
                                     if key not in ("fraction_obstructed", "currently_obstructed") }],
    }
    if scenario in ("obstruction-status-defaults", "obstruction-observed-zero"):
        groups = fixture("obstruction-defaults.json")
        if scenario == "obstruction-observed-zero":
            groups["obstruction_detail"]["valid_s"] = 3600.0
        readings[scenario] = [core_status_fixture(groups)]
    if scenario not in readings:
        raise ValueError(f"Unknown fixture scenario: {scenario}")
    with tempfile.TemporaryDirectory() as temporary:
        history = fixture("history-quality.json") if scenario in ("history-quality", "reported-outage") else None
        app.state.collector = Collector(
            FixtureTransport(
                *readings[scenario],
                history=(history["general"], history["bulk"]) if history else None,
                dish_diagnostics=(
                    [{"id": "ut-official", "hardware_version": "rev-official",
                      "alerts": {"motors_stuck": True}}, RuntimeError("timeout"), RuntimeError("timeout")]
                    if scenario == "stale-diagnostics" else
                    {"id": "ut-official", "hardware_version": "rev-official",
                     "software_version": "firmware-official",
                     "alerts": {"motors_stuck": False, "slow_ethernet_speeds": True}}
                    if scenario == "device-details" else
                    {"hardware_version": "rev-official"} if scenario == "router-unavailable" else None
                ),
                router_diagnostics=(
                    [{"id": "Router-fixture", "hardware_version": "router-rev"},
                     RuntimeError("timeout"), RuntimeError("timeout")]
                    if scenario == "stale-diagnostics" else
                    {"id": "Router-fixture", "hardware_version": "router-rev",
                     "software_version": "router-firmware"} if scenario == "device-details" else
                    RuntimeError("No Starlink router") if scenario == "router-unavailable" else None
                ),
                obstruction_map=(
                    ((0.0, 0.5, -1.0), (1.0, 0.75, 0.25)) if scenario == "obstruction-supported"
                    else ((-1.0, -1.0), (-1.0, -1.0)) if scenario == "obstruction-no-valid-samples"
                    else [((0.0, 0.5, -1.0), (1.0, 0.75, 0.25)),
                          RuntimeError("map request failed"), RuntimeError("map request failed")]
                    if scenario == "obstruction-stale"
                    else RuntimeError("Map unsupported") if scenario == "obstruction-unsupported" else None
                ),
            ),
            now=lambda: clock[0],
            history_store=HistoryStore(Path(temporary) / "history.sqlite3"),
        )
        async def poll_and_settle():
            await app.state.collector.poll_once()
            if app.state.collector.obstruction_map_task:
                await app.state.collector.obstruction_map_task

        asyncio.run(poll_and_settle())
        if scenario == "stale-diagnostics":
            clock[0] += timedelta(seconds=61)
            asyncio.run(poll_and_settle())
            clock[0] += timedelta(seconds=61)
            asyncio.run(poll_and_settle())
        if scenario == "obstruction-stale":
            clock[0] += timedelta(seconds=61)
            asyncio.run(poll_and_settle())
            clock[0] += timedelta(seconds=61)
            asyncio.run(poll_and_settle())
        if scenario == "range-views":
            store = app.state.collector.history_store
            old = clock[0] - timedelta(days=6)
            middle = clock[0] - timedelta(hours=12)
            store.record_status({**fixture("online-idle.json"), "downlink_throughput_bps": 1_000_000}, old)
            store.record_status({**fixture("online-idle.json"), "downlink_throughput_bps": 2_000_000}, middle)
            store.record_outage_state("ut-fixture", "NO_PINGS", middle, offline=True, continuity_seconds=6)
            store.record_outage_state("ut-fixture", "CONNECTED", middle + timedelta(seconds=2), offline=False, continuity_seconds=6)
        if scenario == "reported-outage":
            clock[0] += timedelta(seconds=2)
            asyncio.run(poll_and_settle())
            clock[0] += timedelta(seconds=2)
            asyncio.run(poll_and_settle())
        if scenario in ("outage-boundary", "outage-recovery-in-window"):
            clock[0] += timedelta(seconds=4)
            asyncio.run(poll_and_settle())
        if scenario == "outage-recovery-in-window":
            clock[0] += timedelta(minutes=14, seconds=58)
        if scenario == "stale":
            clock[0] += timedelta(seconds=10)
        app.state.session_token = "fixture-session-token"
        params = {"range": range_name} if endpoint == "history" else None
        response = TestClient(app, headers={"Authorization": "Bearer fixture-session-token"}).get(f"/api/{endpoint}", params=params)
        response.raise_for_status()
        print(json.dumps(response.json()))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "status",
         sys.argv[3] if len(sys.argv) > 3 else "15m")
