# UI refresh verification

Validated on Windows with development Electron 44.4.5 on 2026-09-28. The [report](desktop-ui.json) records source hashes, layout and interaction observations, and all 20 captured screens. The behavioral suite passed 37 tests.

These are **fixture previews**, with a visible watermark. Recorded dish responses run through the public fixture API and the real Electron main/preload/renderer. Long identifiers, collector-error responses and diagnostic logs are explicitly synthetic. No live dish calls, real collector process, startup writes or changes to the installed app were made. Existing v1.1.1 live and installer evidence remains scoped to that release.

## Reproduce

After installing the project's Node dependencies, Electron runtime, and Python test dependencies into `.venv`, run on Windows:

```powershell
node tests/ui-visual-smoke.js
```

The check opens an isolated development window, writes a report and screenshots under the ignored `.tools/ui-validation/` directory, and normally quits its owned app. It checks all five views at 1120×800 and 600×750, keyboard activation, three history ranges, chart sizing, unavailable/error states, long text, console errors and cleanup. It uses a unique profile and makes no hardware calls. Normal desktop permissions are needed for Electron; a restricted process sandbox can prevent inspector startup. Forced cleanup is reported as a failure, rather than accepted as normal shutdown.

## Visual review

Reviewed the overview, statistics, obstruction, device and log screens, including compact collector-error and long-identifier cases. Labels, source/freshness explanations and uncertainty states remain readable. Long investigations scroll vertically. No horizontal page overflow, clipped navigation, chart distortion or renderer console errors were observed.

- [Overview](screenshots/fixture-online-network-1120x800.png)
- [Statistics](screenshots/fixture-online-statistics-1120x800.png)
- [Compact statistics](screenshots/fixture-online-statistics-600x750.png)
- [Obstructions](screenshots/fixture-online-obstruction-1120x800.png)
- [Devices](screenshots/fixture-online-device-600x750.png)
- [Collector error](screenshots/fixture-error-network-600x750.png)
