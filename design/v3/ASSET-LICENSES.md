# Relay — asset provenance and licences

Recorded 2026-07-29. Design pass: Relay identity, logo system, custom assets,
page designs, handoff. Branch `design/relay-identity`.

## Fonts

| Font                            | Licence                   | Source                                                                                                                 | Use                                     |
| ------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Plus Jakarta Sans (400/500/700) | SIL Open Font License 1.1 | Self-hosted in the ZafTech parent repo (`public/fonts/`), mirrored in the bound design system at `_ds/…/assets/fonts/` | Headings, body, wordmark                |
| JetBrains Mono (400/500/700)    | SIL Open Font License 1.1 | Same                                                                                                                   | Labels, metadata, code, version numbers |

Both fonts are inherited from ZafTech; no new licence is required. No font file
is embedded in any exported SVG — the outlined wordmark
(`brand/relay-wordmark.svg`) is stroke geometry, not text.

## Logo system — all original

| File                                | Original? | Notes                                              |
| ----------------------------------- | --------- | -------------------------------------------------- |
| `brand/relay-mark.svg`              | Yes       | Ledger slab stack, 32-unit grid, 4 slabs           |
| `brand/relay-mark-mono.svg`         | Yes       | Single `currentColor`                              |
| `brand/relay-mark-reverse.svg`      | Yes       | Light ramp for dark backgrounds                    |
| `brand/relay-wordmark.svg`          | Yes       | Stroke-built uppercase `RELAY`, no font dependency |
| `brand/relay-by-zaftech-lockup.svg` | Yes       | Mark + stroke wordmark + stroke "BY ZAFTECH"       |
| `brand/favicon.svg`                 | Yes       | 2-slab reduction on an ink plate                   |
| `brand/favicon-16.png`              | Yes       | Rasterised from the same geometry                  |
| `brand/favicon-32.png`              | Yes       | Same                                               |
| `brand/apple-touch-icon.png`        | Yes       | 180 × 180, 4-slab, ink plate                       |

No embedded raster images inside any SVG. No third-party vector was traced,
adapted, or referenced.

## Custom diagram assets — all original

`assets/hero-request-to-result.svg`, `assets/immutable-version-stack.svg`,
`assets/job-lifecycle.svg`, `assets/signed-url-delivery.svg`,
`assets/mcp-tool-flow.svg`, `assets/workspace-isolation.svg`,
`assets/usage-entitlements.svg`.

All drawn for this project from rectangles, orthogonal paths and text; no stock
illustration, no clip art, no traced screenshots, no vendor artwork. Text inside
the SVGs requests JetBrains Mono and falls back to the platform monospace stack,
so the files stay legible without the webfont.

Every diagram is **informative**, not decorative: each one ships with the alt
text quoted in `component-inventory.md → DiagramFigure` and used verbatim in
`Relay Landing.dc.html`. The `<title>` element inside each SVG carries the same
description for direct-file use.

## Third-party marks deliberately not used

- **AWS, Cloudflare, MinIO, PostgreSQL, Redis** — no logos anywhere. Storage
  compatibility is stated as a protocol claim in text ("S3 API", "SELF-HOSTED",
  "PRESIGNED PUT / GET"). The landing page says so explicitly: "Provider names
  are omitted deliberately. Compatibility is a protocol claim, not an
  endorsement."
- **Google and GitHub** — the OAuth buttons use a neutral square placeholder
  glyph plus text. Before shipping, substitute the official marks under each
  provider's own brand guidelines (Google Identity branding guidelines; GitHub
  logos and usage). Do not draw approximations, and do not ship the placeholder
  square as a final asset.
- **ZafTech parent logo** — not redrawn, not distorted, not included in these
  files. Where the parent brand appears it is the words "by ZafTech" set in
  JetBrains Mono, subordinate to the Relay lockup. If a raster ZafTech lockup is
  ever required, use the existing exports in the parent repo (`public/logo/`)
  unmodified.

## Icons

No icon set is used. Every glyph in the system is either drawn from the 32-unit
icon geometry or is a Unicode character rendered in the brand fonts
(`■ □ ▲ ― ▪ ▾ → ← ×`). The parent system's Material Symbols CDN dependency is
not introduced into Relay.

## Photography

None. Relay ships no photographic assets; the design does not depend on any.

## Screens

`screens/*.png` are exports of the delivered Design Components in this project
and contain no third-party content. They are review artefacts; the Design
Component files are the source of truth.
