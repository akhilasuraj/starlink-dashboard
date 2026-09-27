"""Durable observations for bounded quality and outage investigation windows."""

from contextlib import closing
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sqlite3
import math


HISTORY_SOURCE = "starlink-grpc-core.history_bulk_data"
STATUS_SOURCE = "starlink-grpc-core.status_data"
UNITS = {
    "download_mbps": "Mbps",
    "upload_mbps": "Mbps",
    "latency_ms": "ms",
    "drop_rate": "fraction",
}
RANGES = {"15m": (900, None), "24h": (86400, 300), "7d": (604800, 1800)}


def utc_text(value):
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def from_utc_text(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def finite_number(value, divisor=1):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value):
        return None
    return value / divisor


def default_history_path():
    base = os.environ.get("STARLINK_DASHBOARD_DATA_DIR")
    if base:
        return Path(base) / "history.sqlite3"
    local = os.environ.get("LOCALAPPDATA")
    if local:
        return Path(local) / "Starlink Dashboard" / "history.sqlite3"
    return Path.home() / ".local" / "share" / "starlink-dashboard" / "history.sqlite3"


class HistoryStore:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute("""CREATE TABLE IF NOT EXISTS samples (
                sample_key TEXT PRIMARY KEY,
                at TEXT NOT NULL,
                observed_at TEXT,
                time_basis TEXT NOT NULL,
                source TEXT,
                download_mbps REAL,
                upload_mbps REAL,
                latency_ms REAL,
                drop_rate REAL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS samples_at ON samples(at)")
            db.execute("""CREATE TABLE IF NOT EXISTS streams (
                device_id TEXT PRIMARY KEY,
                epoch INTEGER NOT NULL,
                end_counter INTEGER,
                boot_at TEXT
            )""")
            db.execute("""CREATE TABLE IF NOT EXISTS outages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                device_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                first_observed_at TEXT NOT NULL,
                last_confirmed_at TEXT NOT NULL,
                recovery_observed_at TEXT,
                end_state TEXT NOT NULL,
                source TEXT NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS outages_window ON outages(first_observed_at, last_confirmed_at)")
            # A process restart leaves the actual end of a previously open outage unknown.
            db.execute("UPDATE outages SET end_state='unobserved' WHERE end_state='open'")
            db.commit()

    def _connect(self):
        db = sqlite3.connect(self.path)
        db.row_factory = sqlite3.Row
        return db

    def record_status(self, status, observed_at):
        at = utc_text(observed_at)
        values = (
            f"status:{at}", at, at, "observed_poll", STATUS_SOURCE,
            finite_number(status.get("downlink_throughput_bps"), 1_000_000),
            finite_number(status.get("uplink_throughput_bps"), 1_000_000),
            finite_number(status.get("pop_ping_latency_ms")),
            finite_number(status.get("pop_ping_drop_rate")),
        )
        with closing(self._connect()) as db:
            db.execute("INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?,?,?)", values)
            db.commit()

    def record_gap(self, at):
        timestamp = utc_text(at)
        with closing(self._connect()) as db:
            db.execute(
                "INSERT OR REPLACE INTO samples VALUES (?,?,?,?,?,?,?,?,?)",
                (f"gap:{timestamp}", timestamp, None, "uncollected", None,
                 None, None, None, None),
            )
            db.commit()

    def record_outage_state(self, device_id, reason, observed_at, *, offline, continuity_seconds):
        """Record only dish-reported offline states; observation gaps never imply an outage."""
        device_id = device_id if isinstance(device_id, str) and device_id else "unknown"
        at = utc_text(observed_at)
        with closing(self._connect()) as db:
            db.execute(
                "UPDATE outages SET end_state='unobserved' WHERE end_state='open' AND device_id<>?",
                (device_id,),
            )
            open_event = db.execute(
                "SELECT * FROM outages WHERE device_id=? AND end_state='open' ORDER BY id DESC LIMIT 1",
                (device_id,),
            ).fetchone()
            if open_event is not None:
                continuous = (observed_at - from_utc_text(open_event["last_confirmed_at"])).total_seconds() <= continuity_seconds
                if offline and continuous and reason == open_event["reason"]:
                    db.execute("UPDATE outages SET last_confirmed_at=? WHERE id=?", (at, open_event["id"]))
                    db.commit()
                    return
                if not offline and reason == "CONNECTED" and continuous:
                    db.execute(
                        "UPDATE outages SET recovery_observed_at=?, end_state='recovered' WHERE id=?",
                        (at, open_event["id"]),
                    )
                else:
                    db.execute("UPDATE outages SET end_state='unobserved' WHERE id=?", (open_event["id"],))
            if offline and isinstance(reason, str) and reason:
                db.execute(
                    "INSERT INTO outages(device_id,reason,first_observed_at,last_confirmed_at,end_state,source) "
                    "VALUES (?,?,?,?,'open',?)",
                    (device_id, reason, at, at, STATUS_SOURCE),
                )
            db.commit()

    def interrupt_outage(self):
        with closing(self._connect()) as db:
            db.execute("UPDATE outages SET end_state='unobserved' WHERE end_state='open'")
            db.commit()

    def ingest_dish_history(self, general, bulk, captured_at, device_id, uptime):
        """Map one-second counter samples to estimated local times and deduplicate."""
        if not isinstance(general, dict) or not isinstance(bulk, dict):
            return 0
        count = general.get("samples")
        end_counter = general.get("end_counter")
        if not isinstance(count, int) or not isinstance(end_counter, int) or count <= 0:
            return 0
        if count > 3600 or end_counter < 0:
            return 0
        device_id = device_id if isinstance(device_id, str) and device_id else "unknown"
        boot_estimate = None
        if finite_number(uptime) is not None:
            boot_estimate = utc_text(captured_at - timedelta(seconds=uptime))
        captured_text = utc_text(captured_at)

        def at_index(field, index, divisor=1):
            values = bulk.get(field)
            if not isinstance(values, (list, tuple)) or index >= len(values):
                return None
            return finite_number(values[index], divisor)

        with closing(self._connect()) as db:
            previous = db.execute(
                "SELECT epoch, end_counter, boot_at FROM streams WHERE device_id=?",
                (device_id,),
            ).fetchone()
            epoch = 0 if previous is None else previous["epoch"]
            rebooted = previous is not None and previous["end_counter"] is not None and end_counter < previous["end_counter"]
            if previous is not None and previous["boot_at"] and boot_estimate:
                boot_shift = abs((from_utc_text(boot_estimate) - from_utc_text(previous["boot_at"])).total_seconds())
                rebooted = rebooted or boot_shift > 120
            if rebooted:
                epoch += 1
            saved_end = end_counter if rebooted or previous is None else max(end_counter, previous["end_counter"] or 0)
            saved_boot = boot_estimate if rebooted or previous is None else previous["boot_at"] or boot_estimate
            db.execute(
                "INSERT OR REPLACE INTO streams VALUES (?,?,?,?)",
                (device_id, epoch, saved_end, saved_boot),
            )
            inserted_times = []
            for index in range(count):
                counter = end_counter - count + index + 1
                estimated_at = utc_text(captured_at - timedelta(seconds=count - index))
                values = (
                    f"history:{device_id}:{epoch}:{counter}", estimated_at,
                    captured_text, "estimated_from_poll", HISTORY_SOURCE,
                    at_index("downlink_throughput_bps", index, 1_000_000),
                    at_index("uplink_throughput_bps", index, 1_000_000),
                    at_index("pop_ping_latency_ms", index),
                    at_index("pop_ping_drop_rate", index),
                )
                cursor = db.execute("INSERT OR IGNORE INTO samples VALUES (?,?,?,?,?,?,?,?,?)", values)
                if cursor.rowcount:
                    inserted_times.append(estimated_at)
            if inserted_times:
                db.execute(
                    "DELETE FROM samples WHERE time_basis='uncollected' AND at>=? AND at<=?",
                    (min(inserted_times), max(inserted_times)),
                )
            db.commit()
            return len(inserted_times)

    def window(self, now, range_name="15m"):
        seconds, bucket_seconds = RANGES[range_name]
        start = now - timedelta(seconds=seconds)
        start_text, end_text = utc_text(start), utc_text(now)
        with closing(self._connect()) as db:
            if bucket_seconds is None:
                rows = db.execute(
                    "SELECT * FROM samples WHERE at>=? AND at<=? ORDER BY at, time_basis",
                    (start_text, end_text),
                ).fetchall()
                samples, observed_times = self._raw_samples(rows, start, now)
            else:
                samples, observed_times = self._rollup_samples(
                    db, start, now, bucket_seconds, seconds
                )
            outages = db.execute(
                "SELECT * FROM outages WHERE first_observed_at<=? AND "
                "COALESCE(recovery_observed_at,last_confirmed_at)>=? ORDER BY first_observed_at",
                (end_text, start_text),
            ).fetchall()
        return {
            "range": range_name,
            "window_seconds": seconds,
            "bucket_seconds": bucket_seconds,
            "window_start": start_text,
            "window_end": end_text,
            "coverage_start": min(observed_times) if observed_times else None,
            "coverage_end": max(observed_times) if observed_times else None,
            "time_note": (
                "Dish history sample times are estimated from the local poll time; the dish does not provide UTC timestamps. "
                + ("Long-range averages use observed samples only; empty buckets are uncollected, and sparse buckets do not prove continuous service."
                   if bucket_seconds else "")
            ),
            "samples": samples,
            "outages": [{
                "id": event["id"],
                "device_id": event["device_id"],
                "reason": event["reason"],
                "first_observed_at": event["first_observed_at"],
                "last_confirmed_at": event["last_confirmed_at"],
                "recovery_observed_at": event["recovery_observed_at"],
                "end_state": event["end_state"],
                "source": event["source"],
            } for event in outages],
        }

    def _raw_samples(self, rows, start, now):
        grouped = []
        for row in rows:
            if not grouped or grouped[-1][0]["at"] != row["at"]:
                grouped.append([row])
            else:
                grouped[-1].append(row)
        samples = []
        last_at = start
        observed_times = []
        for group in grouped:
            current_at = from_utc_text(group[0]["at"])
            if (current_at - last_at).total_seconds() > 2.5:
                samples.append(self._gap(utc_text(last_at + timedelta(seconds=1))))
            sample = self._merged_sample(group)
            samples.append(sample)
            if sample["time_basis"] != "uncollected":
                observed_times.append(sample["at"])
            last_at = current_at
        if not grouped or (now - last_at).total_seconds() > 2.5:
            samples.append(self._gap(utc_text(now)))
        return samples, observed_times

    def _rollup_samples(self, db, start, now, bucket_seconds, seconds):
        bins = [None] * (seconds // bucket_seconds)
        picked_fields = []
        moment_fields = []
        rollup_fields = []
        for name in UNITS:
            packed = f"{name}_picked"
            # The chosen value, capture time, and source travel together in one JSON tuple.
            # Prefixing priority and capture time makes MAX choose the same latest
            # preferred row for all three fields, even across counter-reset overlap.
            picked_fields.append(
                f"MAX(CASE WHEN time_basis!='uncollected' AND {name} IS NOT NULL "
                f"AND observed_at IS NOT NULL AND source IS NOT NULL THEN "
                f"printf('%d%s%s', CASE WHEN time_basis='estimated_from_poll' THEN 1 ELSE 0 END, "
                f"observed_at, json_array({name}, observed_at, source)) END) AS {packed}"
            )
            moment_fields.extend((
                f"json_extract(substr({packed}, 22), '$[0]') AS {name}",
                f"json_extract(substr({packed}, 22), '$[1]') AS {name}_observed_at",
                f"json_extract(substr({packed}, 22), '$[2]') AS {name}_source",
            ))
            rollup_fields.extend((
                f"AVG({name}) AS {name}",
                f"COUNT({name}) AS {name}_count",
                f"MAX({name}_observed_at) AS {name}_observed_at",
                f"GROUP_CONCAT(DISTINCT {name}_source) AS {name}_sources",
            ))
        query = (
            "WITH picked AS (SELECT at, " + ", ".join(picked_fields) +
            " FROM samples WHERE at>=? AND at<=? GROUP BY at "
            "HAVING MAX(CASE WHEN time_basis!='uncollected' THEN 1 ELSE 0 END)=1), "
            "moments AS (SELECT at, " + ", ".join(moment_fields) + " FROM picked) "
            "SELECT min(?, CAST((strftime('%s', at) - ?) / ? AS INTEGER)) AS bucket_index, "
            "MIN(at) AS first_at, MAX(at) AS last_at, COUNT(*) AS sample_count, " +
            ", ".join(rollup_fields) + " FROM moments GROUP BY bucket_index ORDER BY bucket_index"
        )
        for row in db.execute(
            query, (utc_text(start), utc_text(now), len(bins) - 1, int(start.timestamp()), bucket_seconds)
        ):
            bins[row["bucket_index"]] = row

        samples, observed_times = [], []
        for index, bucket in enumerate(bins):
            bucket_start = utc_text(start + timedelta(seconds=index * bucket_seconds))
            bucket_end = utc_text(start + timedelta(seconds=(index + 1) * bucket_seconds))
            if bucket is None:
                gap = self._gap(bucket_start)
                gap.update({"bucket_start": bucket_start, "bucket_end": bucket_end, "sample_count": 0})
                samples.append(gap)
                continue
            observed_times.extend((bucket["first_at"], bucket["last_at"]))
            metrics = {}
            for name, unit in UNITS.items():
                has_value = bucket[f"{name}_count"] > 0
                sources = bucket[f"{name}_sources"]
                metrics[name] = {
                    "value": bucket[name] if has_value else None,
                    "unit": unit,
                    "availability": "available" if has_value else "unavailable",
                    "source": f"local SQLite average of {sources.replace(',', ', ')}" if has_value else None,
                    "observed_at": bucket[f"{name}_observed_at"],
                    "time_basis": "rollup" if has_value else None,
                    "sample_count": bucket[f"{name}_count"],
                }
            samples.append({
                "at": bucket["last_at"],
                "observed_at": bucket["last_at"],
                "time_basis": "rollup",
                "source": "local SQLite rollup",
                "bucket_start": bucket_start,
                "bucket_end": bucket_end,
                "observed_start": bucket["first_at"],
                "observed_end": bucket["last_at"],
                "sample_count": bucket["sample_count"],
                "metrics": metrics,
            })
        return samples, observed_times

    @staticmethod
    def _merged_sample(rows):
        observed = [row for row in rows if row["time_basis"] != "uncollected"]
        if not observed:
            return HistoryStore._gap(rows[0]["at"])
        observed.sort(key=lambda row: row["time_basis"] != "estimated_from_poll")
        metrics = {}
        chosen_rows = []
        for name, unit in UNITS.items():
            chosen = next((row for row in observed if row[name] is not None), None)
            value = chosen[name] if chosen is not None else None
            if chosen is not None:
                chosen_rows.append(chosen)
            metrics[name] = {
                "value": value,
                "unit": unit,
                "availability": "available" if value is not None else "unavailable",
                "source": chosen["source"] if chosen is not None else None,
                "observed_at": chosen["observed_at"] if chosen is not None else None,
                "time_basis": chosen["time_basis"] if chosen is not None else None,
            }
        used = chosen_rows or observed[:1]
        bases = {row["time_basis"] for row in used}
        sources = {row["source"] for row in used}
        return {
            "at": observed[0]["at"],
            "observed_at": max(row["observed_at"] for row in used),
            "time_basis": next(iter(bases)) if len(bases) == 1 else "mixed",
            "source": next(iter(sources)) if len(sources) == 1 else "mixed",
            "metrics": metrics,
        }

    @staticmethod
    def _gap(at):
        return {
            "at": at,
            "observed_at": None,
            "time_basis": "uncollected",
            "source": None,
            "metrics": {
                name: {"value": None, "unit": unit, "availability": "uncollected",
                       "source": None, "observed_at": None, "time_basis": "uncollected"}
                for name, unit in UNITS.items()
            },
        }
