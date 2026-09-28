"""Read-only hardware capture. Only allowlisted, sanitized fields reach disk."""

import asyncio
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from backend.history import HistoryStore
from backend.server import Collector
from backend.telemetry import StarlinkTelemetry

STATUS_FIELDS = ("hardware_version", "software_version", "state", "uptime",
                 "downlink_throughput_bps", "uplink_throughput_bps", "pop_ping_latency_ms",
                 "pop_ping_drop_rate", "fraction_obstructed", "currently_obstructed", "gps_sats")
BULK_FIELDS = ("downlink_throughput_bps", "uplink_throughput_bps", "pop_ping_latency_ms", "pop_ping_drop_rate")


def clean(value):
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [clean(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


class SanitizingTransport:
    def __init__(self):
        self.telemetry = StarlinkTelemetry()
        self.readings = {}
        self.results = {}
        self.reported_fields = []

    def read_status(self):
        raw = self.telemetry.read_status()
        self.reported_fields = [name for name in STATUS_FIELDS if raw.get(name) is not None]
        result = clean({name: raw.get(name) for name in STATUS_FIELDS})
        self.results["status"] = "success"
        self.readings["status"] = result
        return result

    def read_history(self):
        general, bulk = self.telemetry.read_history()
        result = clean(({name: general.get(name) for name in ("samples", "end_counter")},
                        {name: bulk.get(name, []) for name in BULK_FIELDS}))
        self.results["history"] = "success"
        self.readings["history"] = {"general": result[0], "bulk": result[1]}
        return result

    def diagnostics(self, kind):
        name = f"{kind}_diagnostics"
        try:
            raw = getattr(self.telemetry, f"read_{name}")()
            # Device identifiers and all unneeded nested data are discarded here.
            result = {field: raw.get(field) for field in ("hardware_version", "software_version")}
            if kind == "dish" and isinstance(raw.get("alerts"), dict):
                result["alerts"] = {key: value for key, value in raw["alerts"].items() if isinstance(value, bool)}
            self.results[name] = "success"
            self.readings[name] = result
            return result
        except Exception as error:
            self.results[name] = f"unavailable:{type(error).__name__}"
            self.readings[name] = None
            return None

    def read_dish_diagnostics(self):
        return self.diagnostics("dish")

    def read_router_diagnostics(self):
        return self.diagnostics("router")

    def read_obstruction_map(self):
        try:
            result = clean(self.telemetry.read_obstruction_map())
            self.results["obstruction_map"] = "success"
            self.readings["obstruction_map"] = result
            return result
        except Exception as error:
            self.results["obstruction_map"] = f"unavailable:{type(error).__name__}"
            self.readings["obstruction_map"] = None
            return None

    def close(self):
        self.telemetry.close()


async def capture(options):
    with tempfile.TemporaryDirectory() as temporary:
        store = HistoryStore(Path(temporary) / "history.sqlite3")
        first = SanitizingTransport()
        collector = Collector(first, history_store=store)
        await collector.poll_once()
        if collector.obstruction_map_task:
            await collector.obstruction_map_task
        if first.results.get("status") != "success" or first.results.get("history") != "success":
            raise SystemExit("Essential live status/history capture failed; no raw response saved")
        before = store.window(datetime.now(timezone.utc), "15m")
        first.close()
        # Recreate only our collector/transport; the dish and network stay untouched.
        second = SanitizingTransport()
        restarted = Collector(second, history_store=HistoryStore(store.path))
        await restarted.poll_once()
        if restarted.obstruction_map_task:
            await restarted.obstruction_map_task
        after = store.window(datetime.now(timezone.utc), "15m")
        second.close()
        readings = first.readings
        observed = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        payload = {"schema_version": 1, "sanitized": True, "observed_at": observed,
                   **readings, "sanitization": "Allowlisted telemetry; device identifiers, location, network addresses, and other nested fields omitted"}
        target = options.capture_output.resolve()
        record_target = options.record_output.resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        record_target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8", newline="\n")
        dish = readings.get("dish_diagnostics") or readings["status"]
        router = readings.get("router_diagnostics") or {}
        history = readings["history"]["general"]
        record = {"schema_version": 1, "status": "partial", "owner_acceptance": "pending", "observed_at": observed,
            "owner_reported": {"dish_model": options.dish_model, "router_model": options.router_model,
                               "routing": options.routing, "service_plan": options.service_plan},
            "dish": {"hardware": dish.get("hardware_version"), "firmware": dish.get("software_version")},
            "router": {"hardware": router.get("hardware_version"), "firmware": router.get("software_version")},
            "rpc_results": first.results, "reported_status_fields": first.reported_fields,
            "history": {"requested_samples": 900, "observed_samples": history.get("samples"),
                        "estimated_span_seconds": history.get("samples"), "time_provenance": "One-second sample counter anchored to local capture time; no dish-provided UTC timestamps"},
            "collector_recreation": {"collection_state": restarted.snapshot()["collection_state"],
                                     "persisted_samples_before": len(before["samples"]), "persisted_samples_after": len(after["samples"]),
                                     "scope": "Live collector and transport instances recreated with the same sanitized SQLite store; no desktop/dish restart"},
            "capture": {"path": Path(os.path.relpath(target, record_target.parent)).as_posix(),
                        "sha256": hashlib.sha256(target.read_bytes()).hexdigest()},
            "limitations": ["Owner acceptance of this hardware record remains pending",
                            *[f"Owner {field.replace('_', ' ')} was not supplied" for field in
                              ("dish_model", "router_model", "routing", "service_plan") if getattr(options, field) == "unknown"],
                            "No dish/service interruption was induced; reported-outage and long-disconnection behavior remain fixture-tested",
                            "Collector-instance recreation was observed; this is not a live desktop-process restart test"]}
        record_target.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8", newline="\n")
        print(json.dumps({"rpc_results": first.results, "history_samples": history.get("samples"),
                          "collector_recreated_state": restarted.snapshot()["collection_state"], "sanitized": True}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture-output", type=Path, required=True)
    parser.add_argument("--record-output", type=Path, required=True)
    for field in ("dish_model", "router_model", "routing", "service_plan"):
        parser.add_argument("--" + field.replace("_", "-"), default="unknown")
    options = parser.parse_args()
    if options.capture_output.resolve() == options.record_output.resolve():
        parser.error("Capture and record output paths must differ")
    if options.capture_output.exists() or options.record_output.exists():
        parser.error("Choose new output paths; existing hardware evidence will not be overwritten")
    asyncio.run(capture(options))
