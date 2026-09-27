"""Emit a fixture-backed public status response for the renderer smoke test."""

import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys
import tempfile

from fastapi.testclient import TestClient

from backend.history import HistoryStore
from backend.server import Collector, DishUnreachable, app


FIXTURES = Path(__file__).parent / "fixtures"


class FixtureTransport:
    def __init__(self, *responses, history=None):
        self.responses = iter(responses)
        self.history = history or ({"samples": 0, "end_counter": 0}, {})

    def read_status(self):
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response

    def read_history(self):
        return self.history


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def main(scenario, endpoint="status", range_name="15m"):
    clock = [datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)]
    readings = {
        "online-idle": [fixture("online-idle.json")],
        "service-offline": [fixture("service-offline.json")],
        "dish-unreachable": [DishUnreachable("connection timed out")],
        "stale": [fixture("online-idle.json")],
        "history-quality": [fixture("online-idle.json")],
        "reported-outage": [fixture("service-offline.json"), fixture("service-offline.json"), fixture("online-idle.json")],
        "outage-boundary": [fixture("service-offline.json"), fixture("online-idle.json")],
        "outage-recovery-in-window": [fixture("service-offline.json"), fixture("online-idle.json")],
        "range-views": [fixture("online-idle.json")],
    }
    if scenario not in readings:
        raise ValueError(f"Unknown fixture scenario: {scenario}")
    with tempfile.TemporaryDirectory() as temporary:
        history = fixture("history-quality.json") if scenario in ("history-quality", "reported-outage") else None
        app.state.collector = Collector(
            FixtureTransport(
                *readings[scenario],
                history=(history["general"], history["bulk"]) if history else None,
            ),
            now=lambda: clock[0],
            history_store=HistoryStore(Path(temporary) / "history.sqlite3"),
        )
        asyncio.run(app.state.collector.poll_once())
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
            asyncio.run(app.state.collector.poll_once())
            clock[0] += timedelta(seconds=2)
            asyncio.run(app.state.collector.poll_once())
        if scenario in ("outage-boundary", "outage-recovery-in-window"):
            clock[0] += timedelta(seconds=4)
            asyncio.run(app.state.collector.poll_once())
        if scenario == "outage-recovery-in-window":
            clock[0] += timedelta(minutes=14, seconds=58)
        if scenario == "stale":
            clock[0] += timedelta(seconds=10)
        params = {"range": range_name} if endpoint == "history" else None
        response = TestClient(app).get(f"/api/{endpoint}", params=params)
        response.raise_for_status()
        print(json.dumps(response.json()))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else "status",
         sys.argv[3] if len(sys.argv) > 3 else "15m")
