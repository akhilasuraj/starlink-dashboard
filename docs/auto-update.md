# In-app Windows updates

Tracked in [issue #16](https://github.com/akhilasuraj/starlink-dashboard/issues/16).

## Goal and scope

Installed Windows copies discover and install newer GitHub release installers without a browser download. This adapts [Plezy’s updater](auto-update-research.md) to the existing Electron/NSIS desktop. The bootstrap candidate is **1.3.0**. Version 1.2.0 and earlier need one manual installation of an updater-enabled release; they cannot discover this feature themselves. The historical uninstaller can clear start-on-sign-in during that manual bootstrap; check and re-enable the preference afterward if needed. Updater-enabled versions preserve it on subsequent updates.

## User flow

1. Check on launch after 15 seconds, every six hours while running, or from **Devices → App updates**.
2. Show an available version in Devices and a banner on every view.
3. **Download update** downloads the installer and shows progress. Monitoring continues.
4. **Restart and install** stops the owned collector, waits for its exit, then launches the installer. The normal NSIS wizard may appear. After installation the app starts again.

Downloads and restarts require separate explicit actions. Closing to tray, normal Quit, and Windows logoff never install an update. Check/download failures leave monitoring available and can be retried. Synchronous launch errors and asynchronous errors arriving before the updater’s queued quit restore monitoring and permit retry. An error after the process has exited requires reopening the app. No updater is active in development or on unsupported platforms.

The owner requested 1.3.0 as the latest stable release. The updater also includes GitHub prereleases with ordinary version tags and explains that policy in Devices. Downgrades are disabled. Publish increasing versions: the pinned GitHub provider uses release feed order rather than finding the greatest semantic version.

## Runtime ownership

`updater.js` owns discovery/download state and sanitized snapshots. `main.js` owns shutdown and installation ordering. `preload.js` exposes only `getState`, `check`, `download`, and `install`; validated IPC admits only the main window/main frame. The renderer cannot provide a feed, URL, file path or executable. `renderer/updates.js` renders snapshots and explicit actions. Polling snapshots every two seconds is local IPC, not repeated GitHub requests.

The production feed is fixed to `akhilasuraj/starlink-dashboard`. Pinned `electron-updater@6.8.9` handles NSIS downloads and SHA-512 verification. `autoDownload` and `autoInstallOnAppQuit` are disabled. Installer invocation happens only after collector close, including the existing forced-shutdown escalation. Collection restart and health timers stop during shutdown. Recovery vetoes only the pinned updater’s pending quit and resets its failed-install guard; a regression executes the actual pinned NSIS/base methods with a rejected spawn promise. Session ending takes precedence over update installation.

## Release contract

Builder embeds GitHub configuration and emits the canonical `Starlink.Dashboard.Setup.<version>.exe`, `latest.yml`, and `.exe.blockmap`. The gate verifies metadata version, filename, byte length and SHA-512 against the exact offline-tested installer, rejects web-installer metadata and multiple packages, and requires a nonempty matching blockmap. Draft-release publication uploads all three before exposing the release. Local builds never publish.

Stable publication of 1.3.0 requires both the explicit workflow choice and [the owner approval record](release-approval.json), matched to the package version. Hardware limitations remain acknowledged and included in release notes; the record stays partial. This approval does not bypass offline installation, installed-upgrade evidence, metadata validation or installer hashes. The default remains prerelease publication when hardware validation has limits.

The workflow also verifies a two-version installed transition on a disposable hosted Windows runner. Its lower-version bootstrap is built from this updater-enabled source; it does not pretend historical 1.2.0 has an updater. Test-only inspector configuration substitutes a loopback feed. The unattended test adapts installer invocation to silent mode after asserting production requests the interactive installer. The interactive wizard remains a manual release check. The gate binds upgrade evidence to the commit, run and tested target installer.

The existing unsigned build relies on HTTPS and GitHub repository permissions. SHA-512 protects byte integrity against the release metadata; it does not provide Plezy’s signed appcast publisher authenticity. Authenticode signing with an enforced publisher identity is a separate future change.

## Acceptance and evidence

- Fixed GitHub discovery includes the repository’s prerelease convention; no equal or older version is offered.
- Actual updater downloads accept correct SHA-512 bytes and reject corruption.
- No installer runs before explicit download and explicit restart, or before the collector exits.
- Foreign IPC senders cannot control updates; raw paths/errors do not reach the UI.
- Retry and installer-launch-failure paths preserve monitoring with one collector and one health loop.
- Actual Electron screens show available, progress, downloaded and error states at wide/compact sizes without horizontal clipping.
- Hosted CI verifies the final installer, feed metadata and installed upgrade, including retained fixture history and startup preference.

Behavioral tests use recorded dish responses and fake updater events where appropriate; the transport tests use the real updater against isolated HTTP bytes. Visual evidence uses the real development Electron/main/preload/renderer with an inert collector and fake update events. Neither is a live installed upgrade or a new hardware validation. See [release verification](release-verification.md) for inherited hardware limits and publication gates.
