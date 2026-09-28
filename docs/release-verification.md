# Release verification

The current release candidate is **1.3.0**, adding in-app updates. The mobile-inspired UI release was 1.2.0. The earlier revival release was 1.1.1. Local builds and ordinary push/PR workflow runs never publish a release. The earlier 1.0.2 installer built during development is historical packaging evidence, not the final candidate artifact.

## One workflow

`.github/workflows/desktop-release.yml` replaces both legacy build/release workflows. Its Windows verification job installs pinned dependencies, runs fixture API, renderer, main-process and gate tests, builds the bundled collector/installer, and runs packaging smokes sequentially. Actions are pinned by commit; Node, Python, npm, runtime/build/test dependencies and the Node lockfile identify build inputs.

The offline installed-artifact check runs only on a **disposable GitHub-hosted Windows runner**. `build/offline-install-smoke.ps1` refuses ordinary local execution. It disables and verifies all initially Up network adapters, removes Python from PATH and clears Python environment variables, installs into an isolated temporary path with spaces, and runs the actual installed app and collector. It verifies startup remains opt-in. Its `finally` restores each adapter and waits up to 30 seconds for all originally Up adapters to return Up, restores environment variables, and uninstalls/cleans the temporary install. It records the tested commit, run, installer hash and results. Never use this check to interrupt an owner's network or install on their machine.

The job uploads the installer and machine-readable evidence. A failed check blocks publication. Offline installation has **not been executed on the owner's computer**; the hosted CI result is the required final evidence.

## Live compatibility record

`docs/hardware-validation.json` records the read-only session observed on 2026-09-28, using the owner's Standard 4 dish and Gen 3 router, with the PC on the Starlink router and no bypass or third-party router. Service plan is unknown.

Observed dish hardware/firmware: `rev4_catapult_proto1` / `2026.09.14.mr86848`. Router: `v3` / `2026.09.09.mr85833`. Status, 900 history samples, official dish/router diagnostics and obstruction-map requests succeeded. Collector and transport instances were recreated against the same sanitized local store, returning reachable with retained history.

The owner reported that the app works and authorized publication after verification. A subsequent isolated live desktop check passed against the same dish: 15-minute/24-hour/7-day switching, observed ping-success agreement with the API, chart units, missing-data presentation, and obstruction readings. Only the test app's collector was interrupted; it recovered fresh readings, retained history, and created no duplicate timestamps. Quitting and relaunching with the same test profile also retained history, resumed collection, and left no collector behind. Startup settings were unchanged.

[Desktop evidence](validation/desktop-2026-09-28.json) records these results, binary/source provenance, timestamps and screenshots. Live testing exposed distorted traffic charts at smaller window sizes and Statistics headings fixed to 15 minutes; both are corrected in 1.1.1. The packaged-app smoke now checks actual canvas drawing/display dimensions at two window sizes.

The live test used an isolated copy of the installed 1.1.0 Electron runtime and frozen collector with reviewed 1.1.1 source. It is not a live pass of a newly built 1.1.1 installer; hosted CI separately verifies that final artifact. No physical dish/service outage was induced. Reported-outage and longer disconnection cases remain fixture-tested, and the service plan remains unknown. The record stays partial. Historical releases were prereleases with these explicit limits; the owner separately requested stable latest publication of 1.3.0.

The saved capture is allowlisted before persistence: IDs, serial/account information, location, MAC/IP addresses and unneeded nested fields are omitted. Its raw-byte hash is recorded and tested; captured fixtures use UTF-8/LF to preserve hash integrity across checkouts.

For a new read-only capture, choose new paths and supply current owner facts explicitly; omitted owner fields default to `unknown`:

```powershell
.\.venv\Scripts\python.exe build/capture-hardware.py `
  --capture-output backend/tests/fixtures/live-new-session.json `
  --record-output docs/hardware-new-session.json `
  --dish-model "Owner-supplied model" --router-model "Owner-supplied model" `
  --routing "Owner-supplied LAN/router/bypass description" --service-plan "unknown"
```

The command refuses existing output paths. Review the sanitized capture before committing it. No device setting changes or forced outages are part of capture.

## Publication gate

Configure required reviewers on the GitHub **release** environment. Run the manual workflow on the intended commit with publication enabled only after reviewing its evidence. The version tag (for example `v1.1.1`) must already point to that exact commit and match `package.json`; this workflow does not create tags.

The publication job consumes the installer from its own successful verification job. `build/release-gate.js` requires offline evidence for that exact commit/run and hashes the downloaded installer to ensure the published bytes are the tested bytes. It checks live hardware evidence and the saved capture hash. An accepted hardware record permits publication; any remaining limitations or pending owner acceptance require the explicit manual **acknowledge limitations** input. The default publishes partial or limited validation as a prerelease with its limitations in release notes.

For **1.3.0**, the owner explicitly requested a proper latest release rather than a prerelease after implementation. [The approval record](release-approval.json) binds that request to version 1.3.0 and records the existing owner acceptance and limitations acknowledgment. Select both **stable release** and **acknowledge limitations** for this release. The gate rejects absent, mismatched or incomplete approval, or pending hardware acceptance. Successful stable publication explicitly marks the release latest; prereleases are never marked latest. The partial hardware record and every existing artifact, offline, installed-upgrade and integrity gate remain in force. This version's approval cannot authorize later versions.

No release is complete merely because local tests or a build passed. Offline CI must pass and the hardware evidence must be accepted or its recorded limitations explicitly acknowledged. Nothing in this implementation publishes a release by itself.

## Sources

- [GitHub runner variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables) identify hosted/disposable execution.
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) describe protected review gates.
- [Microsoft Disable-NetAdapter](https://learn.microsoft.com/en-us/powershell/module/netadapter/disable-netadapter?view=windowsserver2025-ps) and [NSIS command-line usage](https://nsis.sourceforge.io/Docs/Chapter3.html) inform the isolated offline check.
- [Starlink gRPC tools](https://github.com/sparky8512/starlink-grpc-tools/blob/main/README.md) defines observed ping-loss sample fractions. Observed ping success is derived from those valid samples; equivalence to the mobile app's uptime calculation is not established.

## 1.2.0 UI release

PR #15 adapts the desktop to current official Starlink mobile imagery and adds an original generated icon. [Fixture UI evidence](validation/ui-refresh/README.md) covers all five views at wide and compact sizes, keyboard activation, history ranges, error/unavailable states, long values and actual chart sizing. All 37 behavioral tests and the 20-screenshot development Electron check passed before the version bump.

Telemetry, storage and private IPC contracts are unchanged. The historical live hardware evidence above remains scoped to its original runtime/source; it is not a live validation of the new UI installer. The new version must pass the full hosted workflow, including an offline install of its exact installer bytes, before publication. Existing acknowledged hardware limitations keep this release a prerelease. [Version notes](releases/v1.2.0.md) describe the changes and validation boundaries.

## 1.3.0 update release

[Update implementation](auto-update.md) and [Plezy research](auto-update-research.md) describe the interaction and release feed. The final installer must pass metadata validation and an installed two-version upgrade on a disposable hosted runner in addition to the existing offline installation gate. Publish the installer, matching blockmap and `latest.yml` in a draft release, then expose the completed release. The current version policy includes GitHub prereleases and forbids downgrades.

Existing 1.2.0 users need a manual bootstrap install. Historical hardware evidence retains its original scope; updater fixtures and hosted installer tests do not constitute new live dish validation. The unsigned release does not claim cryptographic publisher authentication. Interactive installer behavior requires a manual check; the hosted transition uses a test-only silent adaptation for unattended execution.

The owner chose stable latest publication of 1.3.0 with the retained historical limitations. Release classification changes distribution; it does not change telemetry semantics or validation claims.
