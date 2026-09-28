# Update UI fixture evidence

2026-09-28: real development Electron/main/preload/renderer, isolated profile, recorded API responses and inert collector. The updater seam supplies fake events and candidate version 1.3.0. No hardware requests, installer execution or startup writes.

32 captures passed overall; the 12 update captures retained here show available (Devices/Overview), 43% downloading, downloaded/restart, controller error and current at 1120×800 and 600×750. No horizontal overflow or renderer errors; one collector stub and clean owned desktop exit. Compact downloaded and wide progress captures were visually inspected. [Report](desktop-fixture.json) binds evidence to source hashes.

This validates UI/state/IPC behavior, not an installed NSIS upgrade. Hosted installed-transition evidence is required separately. Run `node tests/ui-visual-smoke.js` for new evidence; its fixture instance does not affect an installed copy.
