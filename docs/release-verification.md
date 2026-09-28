# Release verification

The revival candidate is **1.1.1**. Local builds and ordinary push/PR workflow runs never publish a release. The earlier 1.0.2 installer built during development is historical packaging evidence, not the final candidate artifact.

## One workflow

`.github/workflows/desktop-release.yml` replaces both legacy build/release workflows. Its Windows verification job installs pinned dependencies, runs fixture API, renderer, main-process and gate tests, builds the bundled collector/installer, and runs packaging smokes sequentially. Actions are pinned by commit; Node, Python, npm, runtime/build/test dependencies and the Node lockfile identify build inputs.

The offline installed-artifact check runs only on a **disposable GitHub-hosted Windows runner**. `build/offline-install-smoke.ps1` refuses ordinary local execution. It disables and verifies all initially Up network adapters, removes Python from PATH and clears Python environment variables, installs into an isolated temporary path with spaces, and runs the actual installed app and collector. It verifies startup remains opt-in. Its `finally` restores each adapter and waits up to 30 seconds for all originally Up adapters to return Up, restores environment variables, and uninstalls/cleans the temporary install. It records the tested commit, run, installer hash and results. Never use this check to interrupt an owner's network or install on their machine.

The job uploads the installer and machine-readable evidence. A failed check blocks publication. Offline installation has **not been executed on the owner's computer**; the hosted CI result is the required final evidence.

## Live compatibility record

`docs/hardware-validation.json` records the read-only session observed on 2026-09-28, using the owner's Standard 4 dish and Gen 3 router, with the PC on the Starlink router and no bypass or third-party router. Service plan is unknown.

Observed dish hardware/firmware: `rev4_catapult_proto1` / `2026.09.14.mr86848`. Router: `v3` / `2026.09.09.mr85833`. Status, 900 history samples, official dish/router diagnostics and obstruction-map requests succeeded. Collector and transport instances were recreated against the same sanitized local store, returning reachable with retained history.

The owner reported that the app works and authorized publication after verification. A subsequent isolated live desktop check passed against the same dish: 15-minute/24-hour/7-day switching, observed ping-success agreement with the API, chart units, missing-data presentation, and obstruction readings. Only the test app's collector was interrupted; it recovered fresh readings, retained history, and created no duplicate timestamps. Quitting and relaunching with the same test profile also retained history, resumed collection, and left no collector behind. Startup settings were unchanged.

[Desktop evidence](validation/desktop-2026-09-28.json) records these results, binary/source provenance, timestamps and screenshots. Live testing exposed distorted traffic charts at smaller window sizes and Statistics headings fixed to 15 minutes; both are corrected in 1.1.1. The packaged-app smoke now checks actual canvas drawing/display dimensions at two window sizes.

The live test used an isolated copy of the installed 1.1.0 Electron runtime and frozen collector with reviewed 1.1.1 source. It is not a live pass of a newly built 1.1.1 installer; hosted CI separately verifies that final artifact. No physical dish/service outage was induced. Reported-outage and longer disconnection cases remain fixture-tested, and the service plan remains unknown. The record stays partial and the release is a prerelease with these explicit limits.

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

The publication job consumes the installer from its own successful verification job. `build/release-gate.js` requires offline evidence for that exact commit/run and hashes the downloaded installer to ensure the published bytes are the tested bytes. It checks live hardware evidence and the saved capture hash. An accepted hardware record permits publication; any remaining limitations or pending owner acceptance require the explicit manual **acknowledge limitations** input. Partial or limited validation is published as a prerelease with its limitations in release notes.

No release is complete merely because local tests or a build passed. Offline CI must pass and the hardware evidence must be accepted or its recorded limitations explicitly acknowledged. Nothing in this implementation publishes a release by itself.

## Sources

- [GitHub runner variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables) identify hosted/disposable execution.
- [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) describe protected review gates.
- [Microsoft Disable-NetAdapter](https://learn.microsoft.com/en-us/powershell/module/netadapter/disable-netadapter?view=windowsserver2025-ps) and [NSIS command-line usage](https://nsis.sourceforge.io/Docs/Chapter3.html) inform the isolated offline check.
- [Starlink gRPC tools](https://github.com/sparky8512/starlink-grpc-tools/blob/main/README.md) defines observed ping-loss sample fractions. Observed ping success is derived from those valid samples; equivalence to the mobile app's uptime calculation is not established.
