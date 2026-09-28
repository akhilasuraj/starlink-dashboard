# Mobile-inspired desktop UI

Issue: [#14](https://github.com/akhilasuraj/starlink-dashboard/issues/14).

## Reference and design

Use the current official Starlink storefront imagery and recent dated app captures documented in [UI research](starlink-ui-research.md). Storefront version dates do not establish the binary version used for promotional screenshots.

The visual direction is deliberately monochrome: black canvas (`#000000`), quiet surface (`#161616`), elevated controls (`#262626`), white foreground (`#f5f5f5`) and readable secondary text (`#a0a0a0`). Download and upload use restrained blue (`#4da6ff`) and mint (`#54cfac`); green, amber and red communicate health. Use the locally available Segoe UI Variable/Segoe UI family, sentence-case headings and tabular readings. Avoid decorative motion and downloaded artwork.

```text
Wide desktop
┌─────────────────┬─────────────────────────────────────────┐
│ Identity        │ Service + collection health    Range    │
│ Overview        ├─────────────────────────────────────────┤
│ Statistics      │ Selected investigation                  │
│ Obstructions    │ Readings / charts / observed span       │
│ Devices         │ Sources, freshness and gaps             │
│ Collector logs  │                                         │
└─────────────────┴─────────────────────────────────────────┘

Compact desktop
Identity / health
Horizontal navigation
Range controls
Single-column investigation with scrolling
```

The official mobile design uses restrained dark cards and thin charts. Retain that hierarchy while using desktop width for side-by-side investigations. The overview's original dish/router/PC line drawing describes the local monitoring path; it does not report an unmeasured network topology. Metric source and observation time remain accessible, and coverage/gaps remain visible.

## View responsibilities

- **Overview:** collection/service state, observed traffic and current latency, local monitoring path and traffic history.
- **Statistics:** observed ping success, latency/drop-rate history, dish uptime, alerts and reported outages. Observed ping success excludes uncollected time.
- **Obstructions:** measured obstructed fraction, current obstruction state and directional SNR samples. No camera scan or invented globe.
- **Devices:** available dish/router details, alignment readings and opt-in desktop startup, with wrapping long values.
- **Collector logs:** readable scrolling logs and an explicit clear action.

Power, speed tests, client counts and device write controls are not inferred from the mobile reference. Existing capability/availability checks govern every measured value.

## Icon

The original generated dish-and-signal mark lives at [assets/app-icon.png](../assets/app-icon.png), with transparent corners and multiple Windows ICO sizes. [Asset notes](../assets/README.md) record the built-in imagegen prompt and conversion. The same identity is used for the window, navigation and installer. Tray health symbols remain distinct.

## Verification boundary

Retain the approved fixture-backed API/renderer behavioral checks. Inspect actual Electron rendering at wide and compact sizes, including all navigation views, selected ranges, keyboard activation, unavailable and error states, long values, chart drawing/display dimensions and cleanup. Fixture screenshots are design/interaction evidence, not new live hardware validation. Historical v1.1.1 hardware and installer evidence remains scoped to that release.
