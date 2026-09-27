"""Local API for the Starlink desktop monitor."""

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import logging
import math

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from backend.telemetry import DishUnreachable, StarlinkTelemetry, TelemetryError
except ModuleNotFoundError:
    from telemetry import DishUnreachable, StarlinkTelemetry, TelemetryError


logger = logging.getLogger(__name__)
POLL_INTERVAL = 2
STALE_AFTER_SECONDS = 6
SOURCE = "starlink-grpc-core.status_data"
ROUTE_GUIDANCE = (
    "Cannot reach the dish at 192.168.100.1:9200. Check that this PC is on "
    "the Starlink LAN. With bypass mode or a third-party router, add a static "
    "route to 192.168.100.1 through the Starlink WAN interface."
)

METRICS = {
    "download_mbps": ("downlink_throughput_bps", "Mbps", 1_000_000),
    "upload_mbps": ("uplink_throughput_bps", "Mbps", 1_000_000),
    "latency_ms": ("pop_ping_latency_ms", "ms", 1),
    "drop_rate": ("pop_ping_drop_rate", "fraction", 1),
    "obstructed_pct": ("fraction_obstructed", "%", 0.01),
    "dish_uptime_s": ("uptime", "s", 1),
    "gps_sats": ("gps_sats", "satellites", 1),
    "azimuth_deg": ("direction_azimuth", "°", 1),
    "elevation_deg": ("direction_elevation", "°", 1),
}
DEVICE_FIELDS = {"id": "id", "hardware": "hardware_version", "software": "software_version"}
OFFLINE_DISH_STATES = {
    "BOOTING", "SEARCHING", "STOWED", "THERMAL_SHUTDOWN", "NO_SATS",
    "OBSTRUCTED", "NO_DOWNLINK", "NO_PINGS",
}


def utc_text(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def number(value, divisor=1):
    if isinstance(value, bool) or not isinstance(value, (float, int)):
        return None
    if not math.isfinite(value):
        return None
    return value / divisor


class Collector:
    def __init__(self, telemetry, now=None):
        self.telemetry = telemetry
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.last_status = None
        self.observed_at = None
        self.collection_error = None
        self.collection_state = "collecting"
        self.samples = deque(maxlen=30)
        self.logs = deque(maxlen=200)

    async def poll_once(self):
        try:
            status = await asyncio.to_thread(self.telemetry.read_status)
            if not isinstance(status, dict):
                raise TelemetryError("Unexpected status response")
            self.last_status = status
            self.observed_at = self.now()
            self.collection_state = "reachable"
            self.collection_error = None
            self.samples.append({
                "observed_at": utc_text(self.observed_at),
                "source": SOURCE,
                "download_mbps": number(status.get("downlink_throughput_bps"), 1_000_000),
                "upload_mbps": number(status.get("uplink_throughput_bps"), 1_000_000),
            })
        except DishUnreachable as error:
            self.collection_state = "dish_unreachable"
            self.collection_error = str(error)
            self._record_gap()
            self.logs.append(self._log("warning", "Dish unreachable"))
            logger.warning("Dish unreachable: %s", error)
        except Exception as error:
            self.collection_state = "collector_error"
            self.collection_error = str(error)
            self._record_gap()
            self.logs.append(self._log("error", "Collector could not read dish status"))
            logger.exception("Collector could not read dish status")

    def _log(self, level, message):
        return {"timestamp": utc_text(self.now()), "level": level.upper(), "message": message}

    def _record_gap(self):
        self.samples.append({
            "observed_at": utc_text(self.now()),
            "source": None,
            "download_mbps": None,
            "upload_mbps": None,
        })

    def snapshot(self):
        now = self.now()
        age = None if self.observed_at is None else max(0, (now - self.observed_at).total_seconds())
        stale = self.observed_at is not None and (
            self.collection_state != "reachable" or age > STALE_AFTER_SECONDS
        )
        state = "stale" if self.collection_state == "reachable" and stale else self.collection_state
        raw = self.last_status or {}
        dish_state = raw.get("state") if isinstance(raw.get("state"), str) else None
        last_known_service = (
            "online" if dish_state == "CONNECTED" else
            "offline" if dish_state in OFFLINE_DISH_STATES else "unknown"
        )
        service_state = last_known_service if state == "reachable" else "unknown"
        observed_at = utc_text(self.observed_at) if self.observed_at else None
        metrics = {}
        for name, (field, unit, divisor) in METRICS.items():
            value = number(raw.get(field), divisor)
            metrics[name] = {
                "value": value,
                "unit": unit,
                "source": SOURCE if value is not None else None,
                "observed_at": observed_at if value is not None else None,
                "availability": "unavailable" if value is None else "stale" if stale else "available",
            }
        device = {}
        for name, field in DEVICE_FIELDS.items():
            value = raw.get(field)
            available = isinstance(value, str) and bool(value.strip())
            device[name] = {
                "value": value if available else None,
                "source": SOURCE if available else None,
                "observed_at": observed_at if available else None,
                "availability": "unavailable" if not available else "stale" if stale else "available",
            }
        status_text = {
            "collecting": "Collecting",
            "dish_unreachable": "Dish unreachable",
            "collector_error": "Collector error",
            "stale": "Data stale",
            "reachable": "Service online" if service_state == "online" else
                         "Service offline" if service_state == "offline" else "Service unknown",
        }[state]
        return {
            "collection_state": state,
            "service_state": service_state,
            "last_known_service_state": last_known_service,
            "dish_state": dish_state if state == "reachable" else None,
            "last_known_dish_state": dish_state,
            "status_text": status_text,
            "observed_at": observed_at,
            "source": SOURCE if observed_at else None,
            "age_seconds": age,
            "stale": stale,
            "guidance": ROUTE_GUIDANCE if state == "dish_unreachable" else None,
            "collection_error": self.collection_error,
            "capabilities": {name: metric["availability"] != "unavailable" for name, metric in metrics.items()},
            "metrics": metrics,
            "device": device,
        }

    def history(self):
        return {"samples": list(self.samples), "retention": "up to 30 polls; not durable"}


@asynccontextmanager
async def lifespan(app: FastAPI):
    async def poll_loop():
        while True:
            await app.state.collector.poll_once()
            await asyncio.sleep(POLL_INTERVAL)

    task = asyncio.create_task(poll_loop())
    try:
        yield
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        app.state.collector.telemetry.close()


app = FastAPI(lifespan=lifespan)
app.state.collector = Collector(StarlinkTelemetry())
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/status")
async def get_status():
    return app.state.collector.snapshot()


@app.get("/api/history")
async def get_history():
    return app.state.collector.history()


@app.get("/api/logs")
async def get_logs():
    return {"logs": list(app.state.collector.logs)}


@app.post("/api/logs/clear")
async def clear_logs():
    app.state.collector.logs.clear()
    return {"status": "ok"}


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
