# Starlink Dashboard

A Windows desktop monitor for dish-reported service state, observed traffic, latency, packet loss, outages, and obstruction context.

## Install and use

Use Windows 10/11 x64 and connect the PC to the Starlink LAN. The Windows installer bundles the collector, Python runtime, and dependencies. Installation does not download packages or require Python, pip, or a Python PATH entry.

Run the installer from `dist/` after building, then launch Starlink Dashboard. Closing the window keeps monitoring in the tray; **Quit** stops both the desktop and collector. Start on sign-in is opt-in under **Device** and can be turned off there.

The tray distinguishes online, reported impairment, reported offline service, dish unreachable, stale readings, and collector failure. Dish reachability does not prove service availability. Idle traffic is a measured zero, not a speed test.

Switch between 15-minute, 24-hour, and 7-day observed history. Missing collection time remains a gap. Longer views show observed coverage, and device fields that are absent or old say unavailable or stale. History remains in `%LOCALAPPDATA%\Starlink Dashboard\history.sqlite3` across app restarts. Router details are optional. Obstruction directional samples show reported signal context; there is no desktop camera scan.

Quality shows **Observed ping success** for the selected window, with valid sample count and observed span. It averages valid ping-loss fractions, weights longer-view buckets by sample count, and excludes uncollected time. Dish uptime measures time since reboot; the percentage does not establish continuous service uptime.

With bypass mode or a third-party router, a route to dish address `192.168.100.1` through the Starlink WAN interface may be needed. See [troubleshooting](TROUBLESHOOTING.md).

## Development

Build requirements: Windows x64, Python 3.12, Node.js 24, and npm. These tools are needed on the build machine only.

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt -r requirements-test.txt
npm ci
npm run install:runtime
npm start
```

The desktop owns the collector process in development too. Do not start a separate public API server. The collector binds an OS-selected loopback port and requires a per-process session secret. Only the main process holds the endpoint and secret; the preload exposes fixed status/history/log methods. The renderer cannot connect to the network.

### Verify and build

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s backend/tests
npm test
npm run build:win
npm run test:collector-package
npm run test:app-package
```

`build:win` creates a PyInstaller one-folder collector, packages it as an Electron resource, and produces the NSIS installer under `dist/`. Publishing is disabled in these commands. Runtime dependencies are pinned in `requirements-runtime-lock.txt`, build/test tools separately, and Node dependencies in `package-lock.json`.

The app packaging smoke uses a temporary data directory, strips Python environment entries, enables a local inspector only for the check, verifies the actual window/preload/chart library, duplicate-launch handling, and collector cleanup. It reads startup settings but never changes them.

The single [desktop workflow](.github/workflows/desktop-release.yml) runs behavioral tests, builds, packaging smokes, and offline installation on a disposable hosted Windows runner. Local builds never publish. Publication requires a separate manual request, the exact offline-tested installer bytes, and accepted live hardware evidence or explicit acknowledgment of its limitations. See [release verification](docs/release-verification.md).
