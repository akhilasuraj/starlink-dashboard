# Spec: Restore trustworthy Starlink desktop monitoring and history

## Problem Statement

A Starlink user wants the desktop app to provide a dependable monitoring experience similar to the useful statistics in the Starlink mobile app. The current app can show a few live values, but its history disappears after one minute or an app restart, several charts contain invented values, and connection errors are presented as Starlink service outages. Installation also depends on a separately installed Python environment. As a result, the app cannot reliably answer when service failed, how long it failed, or whether a displayed metric is real and current.

## Solution

Deliver a local-first Windows desktop monitor for one Starlink installation. It will display current dish and service health, observed traffic, latency, packet loss, alerts, and supported device information. It will retain time-stamped metrics and outage events locally for 15-minute, 24-hour, and 7-day views, clearly showing periods when the app collected no data. Every value will identify its freshness and become unavailable when the device or firmware does not provide it.

The first release will keep the existing Electron shell while replacing the telemetry, storage, and presentation paths. It will use SpaceX's supported local diagnostics where available and an isolated community gRPC adapter for richer status and history. Installation will include the collector runtime and dependencies, so an end user does not have to install Python or run `pip`.

## User Stories

1. As a Starlink user, I want the app to find my locally reachable dish, so that I can start monitoring without entering protocol details.
2. As a Starlink user using a third-party router, I want clear guidance when the dish cannot be reached from my PC, so that I can correct the route instead of assuming Starlink service is down.
3. As a Starlink user, I want to see which dish and optional Starlink router the app found, including hardware and firmware versions, so that I know which equipment the data describes.
4. As a Starlink user, I want to see which monitoring capabilities my equipment supports, so that missing metrics do not look like zero readings.
5. As a Starlink user, I want distinct indications for collecting data, service online, service impaired, service offline, dish unreachable, and stale data, so that I can diagnose the right problem.
6. As a Starlink user, I want zero traffic to remain distinguishable from a service outage, so that idle time is not counted as downtime.
7. As a Starlink user, I want to see when each live reading was captured, so that I can tell whether it is current.
8. As a Starlink user, I want download and upload values labeled as current traffic, so that I do not mistake them for a speed test or available capacity.
9. As a Starlink user, I want latency and packet loss taken from actual dish readings, so that their charts help explain connection quality.
10. As a Starlink user, I want a useful uptime measure with its time window stated, so that the percentage has a clear meaning.
11. As a Starlink user, I want reported outage periods and their reasons when available, so that I can identify recurring problems.
12. As a Starlink user, I want outages shown on the same timeline as latency, loss, and traffic, so that I can see what changed around an interruption.
13. As a Starlink user, I want to switch between 15-minute, 24-hour, and 7-day views, so that I can investigate immediate issues and longer patterns.
14. As a Starlink user, I want my history to remain after closing and reopening the app, so that I do not lose evidence of past problems.
15. As a Starlink user, I want recent dish history to fill recoverable gaps after a short app interruption, so that a restart does not unnecessarily break the timeline.
16. As a Starlink user, I want longer gaps to remain visibly unmeasured, so that they are not falsely shown as healthy service or outages.
17. As a Starlink user, I want obstruction information and dish alerts when my equipment provides them, so that I can relate physical conditions to service quality.
18. As a Starlink user, I want power and alignment information only when measured values are available, so that placeholders are never presented as telemetry.
19. As a Starlink user, I want GPS satellite counts labeled as GPS reception, so that I do not mistake them for serving Starlink satellites.
20. As a Starlink user, I want unsupported metrics shown as unavailable with a short explanation, so that I understand the app's limits on my hardware.
21. As a Starlink user, I want the tray indicator to reflect the latest known health state, so that I can notice a problem without keeping the window open.
22. As a Starlink user, I want the app to recover when the dish or backend becomes reachable again, so that monitoring resumes without manual intervention.
23. As a Starlink user, I want the app to explain collector failures separately from dish failures, so that I know when to troubleshoot the desktop app.
24. As a Starlink user, I want to install and run the Windows app without installing Python or downloading Python packages during setup, so that setup is predictable.
25. As a Starlink user, I want start-on-login to be my choice, so that the app does not change startup behavior without asking.
26. As a Starlink user, I want the window and charts to remain usable when some fields are missing or malformed, so that one bad reading does not blank the dashboard.
27. As a maintainer, I want recorded and sanitized device responses to exercise the collector and API, so that firmware compatibility changes can be detected without requiring a live dish in every test run.
28. As a maintainer, I want one release workflow to verify the installer and the desktop's key monitoring states, so that a published installer is more likely to work on a clean Windows machine.

## Implementation Decisions

- Retain Electron for this release and modernize it to a supported version. Reassess Tauri or a native shell after telemetry and history are correct on actual hardware.
- Keep the initial product read-only and local-first for one installation. Do not use account cookies or enterprise cloud APIs as a residential fallback.
- Put all Starlink protocol calls behind one telemetry adapter. Prefer SpaceX's published diagnostics call for supported diagnostic fields. Evaluate and pin a compatible `starlink-grpc-core` release for community-discovered status and history calls. Detect capabilities at runtime rather than assuming fields exist.
- Give every normalized reading a UTC observation time, source, unit, and availability state. Missing, unsupported, stale, and actual numeric zero are distinct. The UI never synthesizes telemetry for presentation.
- Represent collection health and Starlink service health separately. A failed local RPC does not establish a service outage; a successful RPC does not alone establish healthy service. Dish-reported state and outage history take precedence over traffic-based inference.
- Run blocking gRPC work outside the async API event loop, reuse connections when practical, and apply bounded request timeouts and retry backoff. The desktop can display the latest valid snapshot while collection is temporarily failing, marked stale.
- Store observed metrics and outage records in SQLite. Ingest dish history on startup and reconnect, deduplicate overlapping samples, and retain enough local data for seven-day charts. Use appropriate rollups for longer views while preserving outage boundaries and data gaps.
- Expose a small local snapshot, history-range, capability, and diagnostics contract to the renderer. Replace the fixed, broadly CORS-enabled local API path with a constrained desktop bridge or a private loopback channel that accepts only the app's requests.
- Redesign the main view around health, outage timeline, latency/drop rate, current traffic, obstruction, and alerts. Move detailed device fields and collector logs to secondary views. Show only metrics confirmed available on the connected hardware.
- Bundle a self-contained collector runtime and its pinned dependencies in the Windows installer. Remove installer-time global `pip` changes. Make start-on-login opt-in and prevent duplicate app/collector instances.
- Use one CI release path with dependency locking, automated behavioral tests, and an installer smoke test. Do not publish a release from separate competing workflows.

## Testing Decisions

- Test external behavior at the highest practical seam: start the collector/API against sanitized, recorded dish responses supplied through a fixture-backed transport, then assert the public snapshot and history responses plus the persisted timeline. This exercises normalization, service/collection state, storage, and API behavior together without mirroring internal functions.
- Cover online, idle-but-online, dish-reported outage, dish unreachable, backend failure, stale snapshot, missing fields, short reconnect/backfill, duplicate history, long collection gap, app restart, and time-range aggregation. Verify that no unsupported metric is rendered as a real zero.
- Smoke-test the desktop UI against the fixture-backed API for status wording, chart units, unavailable states, time-range switching, and tray health. A malformed or partial response must not blank the entire view.
- Test the Windows installer on a clean environment without Python on PATH and without network access during setup. Verify app launch, bundled collector launch, single-instance behavior, quit cleanup, and opt-in startup behavior.
- Treat live hardware validation as a release gate: record dish/router model, firmware, service plan, LAN/bypass routing, available RPCs and fields, real history span, and behavior during a real or safely simulated interruption. Sanitize captured fixtures before committing them.
- The repository has no existing automated test suite, so there is no comparable local test pattern to reuse. Add only tests that verify meaningful user-visible contracts and packaging behavior.

## Out of Scope

- Rebooting, stowing, changing snow-melt or Wi-Fi settings, or other device write controls.
- Account management, support tickets, monthly billing/usage, enterprise cloud telemetry, and remote monitoring outside the local network.
- A phone-camera obstruction scan or a live map of serving satellites.
- A built-in internet speed test. Dish throughput is current traffic, not a capacity measurement.
- Multi-dish fleet management, cross-platform installers, cloud synchronization, and a Tauri/native shell rewrite for this release.

## Further Notes

### Implementation sequence

1. **Compatibility spike:** capture sanitized responses from the owner's dish and optional router; document reachability, firmware, supported diagnostics, status/history calls, and absent fields. This is a gate for promises about specific charts.
2. **Truthful live monitor:** replace the current dependency mismatch with the adapter, normalize data and health states, remove fabricated metrics, and show freshness and capability information through the desktop UI.
3. **Durable history:** ingest the dish's short history buffer, persist and deduplicate samples and outages, and implement the three time ranges with explicit gaps and rollups.
4. **Desktop experience:** redesign the main dashboard and tray around connection health and investigations, with device details and logs available on demand.
5. **Distribution and release:** bundle the runtime, restrict app-to-collector access, update Electron, consolidate CI, and validate the clean Windows installer.

### Release acceptance

- No metric shown as measured is fabricated; each reading has a source and observation time, and unavailable data is explicit.
- Idle traffic, dish-reported outages, dish unreachable, and stale collection are distinguishable in the UI and API.
- Reopening the app retains collected history; overlapping dish history does not create duplicate readings; unobserved periods remain visible as gaps.
- The 15-minute, 24-hour, and 7-day views report the time span actually collected rather than implying unavailable older data exists.
- The installer launches on a clean supported Windows machine with no separately installed Python and no installer-time package download.
- Fixture-based behavioral tests, desktop smoke tests, and a live test on the owner's Starlink hardware pass before release.

Research basis: [SpaceX local Device API](https://github.com/SpaceExplorationTechnologies/enterprise-api/blob/master/device-api/README.md), [`starlink-grpc-core`](https://pypi.org/project/starlink-grpc-core/), [Starlink's app statistics description](https://starlink.com/support/article/8d137188-3031-ab18-7789-edad95f1bb22), and the repository's revival assessment and source-linked research notes.
