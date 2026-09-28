# Troubleshooting

## Dish unreachable

Check that the PC is on the Starlink LAN and the dish is powered. Local dish telemetry uses `192.168.100.1:9200`. With bypass mode or a third-party router, configure a static route to `192.168.100.1` through the Starlink WAN interface. An unreachable dish means service state is unknown; it does not confirm an outage.

## Collector unavailable

The installed app includes its own Python runtime. Do not install Python or run pip to repair it. The app retries an exited collector automatically. Open the **Logs** tab for reported collection problems. If it remains unavailable, use **Quit** in the tray, relaunch, or reinstall the complete installer. Check whether antivirus quarantined `resources\collector\starlink-collector.exe` or files in its `_internal` folder.

The collector API is private to the running app. A fixed `localhost:8000` URL and manually launching `server.py` are not supported. A browser request without the app's session secret is rejected.

## Stale or missing readings

A stale value retains its last observation time and source. It does not represent the current service state. Unsupported telemetry says unavailable. Optional router diagnostics can fail while dish monitoring still works. No data before collection began is displayed as healthy service.

History is stored in `%LOCALAPPDATA%\Starlink Dashboard\history.sqlite3`. Keep that folder writable. For isolated development/testing, `STARLINK_DASHBOARD_DATA_DIR` selects a separate data folder. Do not delete history to diagnose a transient collection failure.

## Startup and closing

Closing the window hides it in the tray. **Quit** exits and stops the collector. A second app launch opens the existing window. Enable or disable **Start on sign-in** under **Device**; the installer does not enable it automatically.

## Build failures

Use Windows x64, Python 3.12, and Node.js 24. Create the project virtual environment and install the pinned build requirements, then run `npm ci` and `npm run install:runtime`. Build-time downloads need network; installing the resulting artifact does not. Run `npm run build:win` to build the collector before packaging. A missing collector bundle is a build error.

Report failures with the app version, collection state, relevant log text, and whether the PC uses a Starlink router or bypass mode. Do not share desktop session secrets.
