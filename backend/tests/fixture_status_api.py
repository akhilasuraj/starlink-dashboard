"""Emit a fixture-backed public status response for the renderer smoke test."""

import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import sys

from fastapi.testclient import TestClient

from backend.server import Collector, DishUnreachable, app


FIXTURES = Path(__file__).parent / "fixtures"


class FixtureTransport:
    def __init__(self, *responses):
        self.responses = iter(responses)

    def read_status(self):
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def main(scenario):
    clock = [datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)]
    readings = {
        "online-idle": [fixture("online-idle.json")],
        "service-offline": [fixture("service-offline.json")],
        "dish-unreachable": [DishUnreachable("connection timed out")],
        "stale": [fixture("online-idle.json")],
    }
    if scenario not in readings:
        raise ValueError(f"Unknown fixture scenario: {scenario}")
    app.state.collector = Collector(FixtureTransport(*readings[scenario]), now=lambda: clock[0])
    asyncio.run(app.state.collector.poll_once())
    if scenario == "stale":
        clock[0] += timedelta(seconds=10)
    response = TestClient(app).get("/api/status")
    response.raise_for_status()
    print(json.dumps(response.json()))


if __name__ == "__main__":
    main(sys.argv[1])
