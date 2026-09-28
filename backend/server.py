"""Local API for the Starlink desktop monitor."""

import asyncio
from collections import deque
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import logging
import math
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

try:
    from backend.history import HistoryStore, STATUS_SOURCE, default_history_path, finite_number as number, utc_text
    from backend.official_device import SOURCE as DIAGNOSTICS_SOURCE
    from backend.telemetry import DishUnreachable, StarlinkTelemetry, TelemetryError
except ModuleNotFoundError:
    from history import HistoryStore, STATUS_SOURCE, default_history_path, finite_number as number, utc_text
    from official_device import SOURCE as DIAGNOSTICS_SOURCE
    from telemetry import DishUnreachable, StarlinkTelemetry, TelemetryError


logger = logging.getLogger(__name__)
POLL_INTERVAL = 2
STALE_AFTER_SECONDS = 6
SOURCE = STATUS_SOURCE
HISTORY_POLL_INTERVAL = 10
DIAGNOSTICS_POLL_INTERVAL = 60
DIAGNOSTICS_STALE_AFTER = 120
OBSTRUCTION_MAP_POLL_INTERVAL = 60
OBSTRUCTION_MAP_STALE_AFTER = 120
OBSTRUCTION_MAP_SOURCE = "starlink-grpc-core.obstruction_map"
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


class Collector:
    def __init__(self, telemetry, now=None, history_store=None):
        self.telemetry = telemetry
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.history_store = history_store
        self.last_history_attempt = None
        self.history_due_on_reconnect = True
        self.outage_continuity_lost = False
        self.last_status = None
        self.dish_diagnostics = None
        self.router_diagnostics = None
        self.dish_diagnostics_at = None
        self.router_diagnostics_at = None
        self.last_diagnostics_attempt = None
        self.last_obstruction_map_attempt = None
        self.obstruction_map_task = None
        self.obstruction_map = None
        self.obstruction_map_at = None
        self.observed_at = None
        self.collection_error = None
        self.collection_state = "collecting"
        self.logs = deque(maxlen=200)

    async def poll_once(self):
        try:
            if self.history_store is None:
                self.history_store = HistoryStore(default_history_path())
            if self.outage_continuity_lost:
                self.history_store.interrupt_outage()
                self.outage_continuity_lost = False
            status = await asyncio.to_thread(self.telemetry.read_status)
            if not isinstance(status, dict):
                raise TelemetryError("Unexpected status response")
            self.last_status = status
            self.observed_at = self.now()
            self.collection_state = "reachable"
            self.collection_error = None
            self.history_store.record_status(status, self.observed_at)
            dish_state = status.get("state")
            self.history_store.record_outage_state(
                status.get("id"), dish_state, self.observed_at,
                offline=dish_state in OFFLINE_DISH_STATES,
                continuity_seconds=STALE_AFTER_SECONDS,
            )
            await self._refresh_diagnostics()
            self._schedule_obstruction_map()
            if hasattr(self.telemetry, "read_history") and (
                self.last_history_attempt is None or
                (self.observed_at - self.last_history_attempt).total_seconds() >= HISTORY_POLL_INTERVAL or
                self.history_due_on_reconnect
            ):
                self.last_history_attempt = self.observed_at
                self.history_due_on_reconnect = False
                try:
                    history_poll_started_at = self.now()
                    general, bulk = await asyncio.to_thread(self.telemetry.read_history)
                except Exception as error:
                    self.logs.append(self._log("warning", "Dish history unavailable; using observed status polls"))
                    logger.warning("Dish history unavailable: %s", error)
                else:
                    self.history_store.ingest_dish_history(
                        general, bulk, history_poll_started_at, status.get("id"), status.get("uptime")
                    )
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
            self.logs.append(self._log("error", "Collector could not collect or save dish telemetry"))
            logger.exception("Collector could not collect or save dish telemetry")

    async def _refresh_diagnostics(self):
        if self.last_diagnostics_attempt is not None and (
            self.observed_at - self.last_diagnostics_attempt
        ).total_seconds() < DIAGNOSTICS_POLL_INTERVAL:
            return
        self.last_diagnostics_attempt = self.observed_at
        readers = [("dish", getattr(self.telemetry, "read_dish_diagnostics", None)),
                   ("router", getattr(self.telemetry, "read_router_diagnostics", None))]
        available = [(kind, reader) for kind, reader in readers if callable(reader)]
        if not available:
            return
        results = await asyncio.gather(
            *(asyncio.to_thread(reader) for _, reader in available), return_exceptions=True
        )
        for (kind, _), result in zip(available, results):
            if isinstance(result, Exception):
                logger.info("Optional %s diagnostics unavailable: %s", kind, result)
                continue
            if isinstance(result, dict):
                setattr(self, f"{kind}_diagnostics", result)
                setattr(self, f"{kind}_diagnostics_at", self.now())

    def _schedule_obstruction_map(self):
        reader = getattr(self.telemetry, "read_obstruction_map", None)
        if not callable(reader) or (
            self.obstruction_map_task is not None and not self.obstruction_map_task.done()
        ) or (
            self.last_obstruction_map_attempt is not None and
            (self.observed_at - self.last_obstruction_map_attempt).total_seconds() < OBSTRUCTION_MAP_POLL_INTERVAL
        ):
            return
        self.last_obstruction_map_attempt = self.observed_at
        self.obstruction_map_task = asyncio.create_task(self._read_obstruction_map(reader))

    async def _read_obstruction_map(self, reader):
        try:
            self.obstruction_map = await asyncio.to_thread(reader)
            self.obstruction_map_at = self.now()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.info("Optional obstruction SNR samples unavailable: %s", error)

    async def stop_optional_tasks(self):
        if self.obstruction_map_task is not None and not self.obstruction_map_task.done():
            self.obstruction_map_task.cancel()
            await asyncio.gather(self.obstruction_map_task, return_exceptions=True)

    def _log(self, level, message):
        return {"timestamp": utc_text(self.now()), "level": level.upper(), "message": message}

    def _record_gap(self):
        self.history_due_on_reconnect = True
        self.outage_continuity_lost = True
        if self.history_store is None:
            return
        try:
            self.history_store.interrupt_outage()
            self.history_store.record_gap(self.now())
            self.outage_continuity_lost = False
        except Exception as error:
            # A failed error-recording write must not terminate the polling loop.
            # Interrupt prior outage confirmation once storage becomes writable.
            self.collection_state = "collector_error"
            self.collection_error = f"Unable to save collection gap: {error}"
            logger.warning("Collection gap could not be saved: %s", error)

    def snapshot(self):
        now = self.now()
        age = None if self.observed_at is None else max(0, (now - self.observed_at).total_seconds())
        stale = self.observed_at is not None and (
            self.collection_state != "reachable" or age > STALE_AFTER_SECONDS
        )
        state = "stale" if self.collection_state == "reachable" and stale else self.collection_state
        raw = self.last_status or {}
        dish_state = raw.get("state") if isinstance(raw.get("state"), str) else None
        reported_loss = number(raw.get("pop_ping_drop_rate"))
        impairment_reasons = []
        if reported_loss is not None and 0 < reported_loss <= 1:
            impairment_reasons.append("Dish reports ping loss")
        if raw.get("currently_obstructed") is True:
            impairment_reasons.append("Dish reports current obstruction")
        last_known_service = (
            ("impaired" if impairment_reasons else "online") if dish_state == "CONNECTED" else
            "offline" if dish_state in OFFLINE_DISH_STATES else "unknown"
        )
        service_state = last_known_service if state == "reachable" else "unknown"
        observed_at = utc_text(self.observed_at) if self.observed_at else None
        def text_reading(value, source, captured_at, old=False):
            available = isinstance(value, str) and bool(value.strip()) and captured_at is not None
            return {
                "value": value if available else None,
                "source": source if available else None,
                "observed_at": utc_text(captured_at) if available else None,
                "availability": "unavailable" if not available else "stale" if stale or old else "available",
            }

        dish_details = self.dish_diagnostics if isinstance(self.dish_diagnostics, dict) else {}
        router_details = self.router_diagnostics if isinstance(self.router_diagnostics, dict) else {}
        dish_old = self.dish_diagnostics_at is None or (now - self.dish_diagnostics_at).total_seconds() > DIAGNOSTICS_STALE_AFTER
        router_old = self.router_diagnostics_at is None or (now - self.router_diagnostics_at).total_seconds() > DIAGNOSTICS_STALE_AFTER
        metrics = {}
        for name, (field, unit, divisor) in METRICS.items():
            value = number(raw.get(field), divisor)
            if name == "obstructed_pct" and value is not None and not 0 <= value <= 100:
                value = None
            metrics[name] = {
                "value": value,
                "unit": unit,
                "source": SOURCE if value is not None else None,
                "observed_at": observed_at if value is not None else None,
                "availability": "unavailable" if value is None else "stale" if stale else "available",
            }
        current = raw.get("currently_obstructed")
        current_available = isinstance(current, bool) and self.observed_at is not None
        map_cells = None
        valid_cells = 0
        if isinstance(self.obstruction_map, (tuple, list)) and 0 < len(self.obstruction_map) <= 128:
            try:
                rows = [list(row) for row in self.obstruction_map]
                columns = len(rows[0])
                if 0 < columns <= 128 and all(len(row) == columns for row in rows):
                    map_cells = []
                    for row in rows:
                        cells = []
                        for cell in row:
                            sample = float(cell) if not isinstance(cell, bool) else math.nan
                            value = sample if math.isfinite(sample) and 0 <= sample <= 1 else None
                            cells.append(value)
                            valid_cells += value is not None
                        map_cells.append(cells)
            except (TypeError, ValueError, OverflowError):
                map_cells = None
                valid_cells = 0
        map_available = valid_cells > 0 and self.obstruction_map_at is not None
        map_reported = map_cells is not None and self.obstruction_map_at is not None
        map_old = self.obstruction_map_at is None or (
            now - self.obstruction_map_at).total_seconds() > OBSTRUCTION_MAP_STALE_AFTER
        obstruction = {
            "currently_obstructed": {
                "value": current if current_available else None,
                "source": SOURCE if current_available else None,
                "observed_at": observed_at if current_available else None,
                "availability": "unavailable" if not current_available else "stale" if stale else "available",
            },
            "signal_map": {
                "cells": map_cells if map_available else None,
                "valid_cells": valid_cells if map_available else 0,
                "source": OBSTRUCTION_MAP_SOURCE if map_reported else None,
                "observed_at": utc_text(self.obstruction_map_at) if map_reported else None,
                "availability": "unavailable" if not map_available else
                                "stale" if stale or map_old else "available",
                "stale": bool(map_reported and (stale or map_old)),
                "reason": None if map_available else
                          "no_valid_samples" if map_reported else "not_reported",
            },
        }
        device = {}
        for name, field in DEVICE_FIELDS.items():
            official = text_reading(dish_details.get(field), DIAGNOSTICS_SOURCE, self.dish_diagnostics_at, dish_old)
            community = text_reading(raw.get(field), SOURCE, self.observed_at)
            device[name] = (official if official["availability"] == "available" else
                            community if community["availability"] != "unavailable" else official)
        router = {
            name: text_reading(router_details.get(field), DIAGNOSTICS_SOURCE,
                               self.router_diagnostics_at, router_old)
            for name, field in DEVICE_FIELDS.items()
        }
        official_alerts = dish_details.get("alerts")
        if not isinstance(official_alerts, dict):
            official_alerts = {}
        official_alerts = {key: value for key, value in official_alerts.items()
                           if isinstance(key, str) and isinstance(value, bool)}
        raw_alerts = raw.get("alert_details")
        if not isinstance(raw_alerts, dict):
            raw_alerts = {}
        community_alerts = {key.removeprefix("alert_"): value for key, value in raw_alerts.items()
                            if isinstance(key, str) and key.startswith("alert_") and isinstance(value, bool)}
        if not any(community_alerts.values()):
            community_alerts = {}
        if official_alerts and not dish_old:
            alert_values, alert_source, alert_at, alert_old = official_alerts, DIAGNOSTICS_SOURCE, self.dish_diagnostics_at, False
        elif community_alerts:
            alert_values, alert_source, alert_at, alert_old = community_alerts, SOURCE, self.observed_at, False
        elif official_alerts:
            alert_values, alert_source, alert_at, alert_old = official_alerts, DIAGNOSTICS_SOURCE, self.dish_diagnostics_at, True
        else:
            alert_values, alert_source, alert_at, alert_old = {}, None, None, False
        alert_time = utc_text(alert_at) if alert_at else None
        alert_availability = "unavailable" if not alert_values else "stale" if stale or alert_old else "available"
        alerts = {
            "availability": alert_availability,
            "source": alert_source,
            "observed_at": alert_time,
            "items": [{"code": code, "active": active, "source": alert_source,
                       "observed_at": alert_time, "availability": alert_availability}
                      for code, active in sorted(alert_values.items())],
        }
        dish_diagnostics_reported = bool(self.dish_diagnostics_at and (
            any(isinstance(dish_details.get(field), str) and dish_details[field].strip()
                for field in DEVICE_FIELDS.values()) or official_alerts))
        router_diagnostics_reported = bool(self.router_diagnostics_at and any(
            isinstance(router_details.get(field), str) and router_details[field].strip()
            for field in DEVICE_FIELDS.values()))
        capability_states = {
            "dish_diagnostics": "unavailable" if not dish_diagnostics_reported else
                                "stale" if stale or dish_old else "available",
            "router_diagnostics": "unavailable" if not router_diagnostics_reported else
                                  "stale" if stale or router_old else "available",
            "dish_alerts": alert_availability,
        }
        status_text = {
            "collecting": "Collecting",
            "dish_unreachable": "Dish unreachable",
            "collector_error": "Collector error",
            "stale": "Data stale",
            "reachable": "Service online" if service_state == "online" else
                         "Service impaired" if service_state == "impaired" else
                         "Service offline" if service_state == "offline" else "Service unknown",
        }[state]
        return {
            "collection_state": state,
            "service_state": service_state,
            "impairment_reasons": impairment_reasons if service_state == "impaired" else [],
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
            "capabilities": {
                **{name: metric["availability"] != "unavailable" for name, metric in metrics.items()},
                **{f"dish_{name}": value["availability"] != "unavailable" for name, value in device.items()},
                **{name: availability == "available" for name, availability in capability_states.items()},
            },
            "capability_states": capability_states,
            "metrics": metrics,
            "device": device,
            "router": router,
            "alerts": alerts,
            "obstruction": obstruction,
        }

    def history(self, range_name="15m"):
        if self.history_store is None:
            self.history_store = HistoryStore(default_history_path())
        return self.history_store.window(self.now(), range_name)


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
        await app.state.collector.stop_optional_tasks()
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
async def get_history(range: Literal["15m", "24h", "7d"] = "15m"):
    return await asyncio.to_thread(app.state.collector.history, range)


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
