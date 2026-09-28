# Starlink Dashboard revival assessment

_27 September 2026. Scope: code inspection and current public documentation; no Starlink hardware was available for a live compatibility test._

## What this project does today

The app is a Windows Electron shell (`main.js`) around a local Python FastAPI process (`backend/server.py`). The backend polls the dish at `192.168.100.1:9200` every two seconds and exposes status, one minute of download/upload samples, and process logs over `127.0.0.1:8000`. The renderer is plain HTML/CSS/JavaScript with Chart.js. The installer is built with electron-builder/NSIS and asks the user to install Python packages into their own Python environment.

The current UI has four tabs: network throughput and latency, statistics, device details, and backend logs. It is a useful prototype, but it does not yet offer the mobile app's monitoring experience. Starlink lists speed, uptime, latency, outages, and alerts as core statistics in the [Starlink app](https://starlink.com/ta-lk/support/article/8d137188-3031-ab18-7789-edad95f1bb22). This app has no durable history or outage timeline.

## Findings from the code

| Priority | Finding | Evidence and effect |
| --- | --- | --- |
| Critical | Several statistics are invented or mislabeled. | `renderer/app.js:249-289` defaults ping success to 100%, power to 42 W, and generates sinusoidal latency and power charts. The labels claim 15-minute and median/average views, although the backend stores only 30 samples at two seconds each (`backend/server.py:36-59`). These can mislead a user diagnosing a real outage. |
| High | The documented Python support and dependency provenance disagree with the implementation. | `requirements.txt` installs `starlink-client`, a separate project from the `starlink-grpc-tools` named in `README.md`. The [published package](https://pypi.org/project/starlink-client/) requires Python 3.9+, while the README/installer promise 3.7+. The current package is unpinned. |
| High | Distribution depends on the user's Python installation and live `pip` access. | `main.js:12-29` spawns `python` from PATH; the NSIS script prompts for a package installation during setup. Python dependencies installed in CI are not bundled into the installer (`package.json:49-68`). A desktop installer should work offline without changing the user's global Python environment. |
| High | Dish reachability and telemetry failures are conflated. | A gRPC error sets `online=false` and shows “Disconnected” (`backend/server.py:116-123`), even when only the PC-to-dish route or backend is down. A successful RPC sets `online=true` (`backend/server.py:82-108`) even if the dish reports a service outage. |
| High | The local API is exposed with broad CORS and no authentication. | `backend/server.py:137-176` accepts every origin and exposes status and a mutation on a fixed port. A bounded IPC bridge or a private random local port would reduce accidental access and port collisions. |
| Medium | The polling path is fragile. | `backend/server.py:61-67` constructs a client and makes a synchronous gRPC call inside the async event loop on every cycle. A stalled call can delay API responses, and there is no explicit sample timestamp, age, timeout, or backoff. |
| Medium | The app has no persisted metrics. | History lives only in two 30-item deques (`backend/server.py:58-59`), so closing the app loses all observations. Logs are also in memory. |
| Medium | The frontend assumes fields are present and numeric. | `renderer/app.js:210-246` calls `.toFixed()` and `.split()` directly. A missing field can fail the whole render update. Failed HTTP responses are parsed without checking `response.ok`. |
| Medium | Release quality gates are weak. | There is no test script, fixture data, dependency lockfile, or installer smoke test. Two tag workflows create a GitHub release (`.github/workflows/build-installer.yml` and `release.yml`). |

## Current ecosystem and choices

SpaceX now publishes an [officially supported local gRPC diagnostics API](https://github.com/SpaceExplorationTechnologies/enterprise-api/blob/master/device-api/README.md) for dish and router identity, alerts, and related diagnostics. Its [published schema](https://github.com/SpaceExplorationTechnologies/enterprise-api/blob/master/device-api/device.proto) does not cover the throughput and history data needed for this product. The maintained [`starlink-grpc-tools`](https://github.com/sparky8512/starlink-grpc-tools) project uses richer community-discovered calls and states that most Statistics-page data comes from dish history. Its maintainer now publishes [`starlink-grpc-core`](https://pypi.org/project/starlink-grpc-core/) as a callable Python module designed for other applications. The richer calls can change with firmware; a compatibility layer and recorded fixtures are essential.

For a usable dashboard immediately, [Home Assistant's Starlink integration](https://www.home-assistant.io/integrations/starlink) already exposes ping, drop rate, throughput, power, and diagnostic sensors, with a route requirement in bypass mode. For a monitoring stack, [`starlink-grpc-tools`](https://github.com/sparky8512/starlink-grpc-tools) can write SQLite, InfluxDB, or Prometheus output, and [`starlink_exporter`](https://github.com/joshuasing/starlink_exporter) is another Prometheus option. These are useful baselines and reference implementations, though neither produces this project's self-contained desktop experience.

### Recommendation

Keep the Electron shell for the first revival release, and replace the data path. The biggest user-facing improvement is trustworthy history, not a framework change. Use SpaceX diagnostics as the supported baseline and wrap `starlink-grpc-core` behind a small adapter for richer status and history. The dish's history buffer is only about 15 minutes, so store time-stamped records in SQLite and render honest 15-minute, 24-hour, and 7-day views. Bundle the runtime in the installer and make every metric report its source and freshness. Upgrade Electron and review its [security checklist](https://www.electronjs.org/docs/latest/tutorial/security) as part of that work.

Reconsider a full shell rewrite only after a working data adapter has been tested against the owner's dish. A Tauri or native Windows shell could reduce packaging overhead, but it will not by itself solve firmware changes, missing history, or misleading metrics. The existing renderer can also be redesigned without changing the shell.

## Proposed first release

1. **Validate live data:** identify dish/router model, firmware, LAN route, and which status/history fields are actually available. Save sanitized response fixtures for offline development. Show “dish unreachable,” “service offline,” and “data stale” as different states.
2. **Build a robust collector:** isolate the gRPC library, set timeouts/backoff, timestamp and validate every sample, and use `null` for missing values. Use dish-reported outages and history where available instead of inferring availability from traffic.
3. **Add durable history:** persist metrics and outage events in SQLite, expose bounded time-range queries, and let the user select 15 minutes, 24 hours, and 7 days. Handle gaps explicitly.
4. **Redesign the dashboard:** lead with current connection health, outage timeline, latency/drop rate, throughput, obstruction and alerts. Put detailed hardware data and diagnostics behind secondary views. Remove fabricated charts and call throughput “current traffic,” not “speed test.” Starlink's [speed test](https://starlink.com/es/support/article/a72d6157-210d-d5f4-76d8-27c932dc4457) measures a different thing.
5. **Ship a dependable desktop build:** bundle Python or move the collector to a single native executable, use a single-instance guard, avoid the fixed unauthenticated HTTP API, add fixture-based tests and an installer smoke test, and make start-on-login opt-in.

The phone-camera obstruction scanner and account/support flows need different capabilities from local dish monitoring. They should be considered separately if feature parity becomes a later goal.

## Verification performed

`node --check` passed for `main.js` and `renderer/app.js`. Runtime behavior and package compatibility were not tested: this checkout has no installed Node packages, Python executable, or reachable Starlink hardware in the current environment.

Detailed source research: [starlink-research.md](starlink-research.md).
