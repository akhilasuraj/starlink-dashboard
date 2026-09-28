# Starlink mobile UI reference for the desktop redesign

Inspected on **2026-09-28**. Images were visually inspected in a browser; this report does not infer layout from search-result descriptions.

## Which references are current?

The live [US Apple listing](https://apps.apple.com/us/app/starlink/id1537177988) shows **2026.24.0**, released **“2d ago”** at inspection, with 2026.23.0 dated September 16. This establishes the current listed iOS binary; it does **not** date the screenshots. Apple publishes no screenshot creation date or corresponding binary version. The five currently displayed SpaceX promotional images are therefore the **current storefront imagery**, not verified captures of 2026.24.0.

Google Play search results showed an older August 26 update date, so they were not used to override the live Apple release information. Avoid screenshots from 2021–2024 search results as the design baseline.

## Exact first-party image references

These assets were observed in the current Apple listing’s image sources/srcsets. They are promotional phone mockups supplied for the SpaceX app.

| Reference | Exact image | Visually observed |
| --- | --- | --- |
| Statistics | [Apple image 5, 600×1298](https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/e7/a3/13/e7a3138d-0461-499c-25a2-07bda983d77c/5.png/600x1300bb.webp) | Five stacked cards: Ping success, Latency, Power draw, Throughput, Events & outages. Fully inspected at native resolution. |
| Home | [Apple image 1, 600×1298](https://is1-ssl.mzstatic.com/image/thumb/PurpleSource211/v4/3c/b0/e1/3cb0e199-6288-d29f-6792-9f585b63a1e9/1.png/600x1300bb.webp) | Dish/router illustration, Online indicator, vertical menu rows for Statistics, Network, Subscription, Obstructions. Inspected in storefront and direct image. |
| Network | [Apple image 3](https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/d4/3d/cc/d43dcc7c-fb40-bb1f-22ab-c5412ebf3676/3.png/600x1300bb.webp) | In the storefront: white node illustration, Devices/Nodes switch, router and device rows. Detail text not inspected at native resolution. |
| Subscription | [Apple image 4](https://is1-ssl.mzstatic.com/image/thumb/PurpleSource211/v4/59/82/29/5982294f-2e1b-1b85-cb86-8c8ede72fa3e/4.png/600x1300bb.webp) | In the storefront: compact sections for nickname, service location, service plan and data usage. Cloud account surface. |

## Visual language to carry forward

**Statistics:** Pure black page, flat charcoal cards with restrained corners and small gaps. A centered sentence-case page title and back chevron sit above the content. Each metric has a small bold label and right chevron, a large white value with a smaller gray unit, a faint white sparkline, and gray context below. The examples say “last 15 minutes”; latency is a median and power an average. Events & outages is a count for the last day. These cards invite drill-down rather than presenting large annotated plots immediately. [Official Statistics image](https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/e7/a3/13/e7a3138d-0461-499c-25a2-07bda983d77c/5.png/600x1300bb.webp).

**Home and navigation:** A monochrome hardware illustration dominates the upper home screen. Online has a small green dot; the functional menu is a vertical list with understated icons and right chevrons. Network adds topology imagery above a list. The blue contour background and promotional captions surrounding the phones belong to the marketing composition, so they should not become the desktop dashboard background. [Official home](https://is1-ssl.mzstatic.com/image/thumb/PurpleSource211/v4/3c/b0/e1/3cb0e199-6288-d29f-6792-9f585b63a1e9/1.png/600x1300bb.webp), [official network](https://is1-ssl.mzstatic.com/image/thumb/PurpleSource221/v4/d4/3d/cc/d43dcc7c-fb40-bb1f-22ab-c5412ebf3676/3.png/600x1300bb.webp).

Font family and exact colors are not established by image inspection. Use a clean system sans-serif and visually similar neutral tones; do not claim pixel-exact branding.

## Recent real-device corroboration

[Drohnen.de’s hands-on review](https://www.drohnen.de/90566/starlink-im-test-erfahrungen/) is dated **23 September 2026** and identifies its photos/screenshots as its own September test. Its [Statistics capture](https://www.drohnen.de/wp-content/uploads/2026/09/starlink-mini-x-49-starlink-app-statistik-startphase.jpg) was visually inspected: the same vertical dark metric cards appear, with a startup/warmup notice above them and German labels. This is independent author-provided imagery, **not a SpaceX source**; the exact capture day and app version are unspecified. It supports the storefront hierarchy’s continued relevance but cannot prove the latest binary is identical.

## Mapping to this read-only desktop app

Design recommendations below are adaptations, not claims about mobile app behavior.

- Keep the mobile hierarchy: connection state first, then ping success, latency, power and traffic, with outages easy to reach. On desktop, arrange summary cards in a row/grid and use the remaining width for a selected detailed chart.
- Use black/charcoal, white numbers, gray labels and restrained green/amber/red state accents. Keep graph legends and time ranges explicit.
- Put Monitoring, History, Obstructions and Device diagnostics in persistent desktop navigation. Treat backend logs as diagnostics.
- Each value should state its source time/window. Show unavailable metrics honestly and distinguish connection traffic from a speed-test result.
- Home hardware imagery can anchor a compact status panel. It must not displace monitoring/history, the user’s priorities.
- Offer subscription/account and full network-control functions only when a verified adapter supports them. The current local monitor cannot promise everything pictured in the mobile app.

The redesign now has a current first-party visual basis, corroborated by a dated 2026 capture. Live interaction details, animations, theme variants and drill-down screens remain unverified.
