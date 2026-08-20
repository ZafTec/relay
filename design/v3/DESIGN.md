# Relay by ZafTech — design system

Version 0.1.0 · identity **Ledger** (Direction B) · owner-selected 2026-07-29

Relay is durable infrastructure for work that does not finish in one request.
The design system exists to make state legible: what was stored, what version it
became, what work is underway, and what URL was issued.

---

## 1. Two surfaces, one system

|            | Public (`/`, `/docs`, `/changelog`, `/status`) | Product (`/sign-in`, `/dashboard`, `/admin`) |
| ---------- | ---------------------------------------------- | -------------------------------------------- |
| Background | Paper `#F5F4ED` / `#EFEDE2`                    | Onyx `#141A16` / rail `#121815`              |
| Text       | `#141A16`, `#46514B`, `#5F6B64`                | `#F5F4ED`, `#B4C0B6`, `#8E9A92`              |
| Accent     | Spruce dark `#1F776E`                          | Spruce `#63C8BC`                             |
| Purpose    | Explain, publish, convince                     | Operate, inspect, act                        |

The split is deliberate and load-bearing: the marketing page must never be
mistaken for the dashboard, and the dashboard must never look like a brochure.
Everything else — type, spacing, sharp corners, mono metadata, `// 01` kickers,
the icon grid, the motion vocabulary — is shared.

Light mode is not a separate design: the public surface _is_ the light
treatment, and the product surface is dark-only in v1.

## 2. Colour

Full values in `tokens.json`. Rules that are not obvious from the values:

- One accent. Spruce marks anything interactive, current, or numbered. There is
  no second accent — failure and security use ink, weight, glyph and border
  instead of red.
- Neutrals carry ~95% of both surfaces.
- Greys are contrast-checked per surface. `#7A8C84` (parent onyx-500) reads
  5.1:1 on onyx but only 3.2:1 on paper, so paper uses `#5F6B64` (5.1:1) and
  product uses `#8E9A92` (6.2:1) for 10–13px mono. Never move a grey between
  surfaces unchecked.
- Measured contrast: body `#46514B`/paper 7.4:1, `#B4C0B6`/onyx 9.9:1, accent
  `#1F776E`/paper 4.9:1, accent `#63C8BC`/onyx 9.0:1. All ≥ AA.

## 3. Typography

Plus Jakarta Sans + JetBrains Mono, inherited from ZafTech, both OFL.

Keeping the parent pairing is the right trade: Relay needs to read as a mature
ZafTech product, the fonts are already self-hosted in the parent repo (no new
licence, no new CDN, no new latency), and JetBrains Mono is load-bearing for the
metadata that this product is mostly made of — versions, SHAs, job ids, keys,
byte counts. Distinctiveness comes from the _use_ of type here, not the choice:
sentence-case sans wordmark, mono notation everywhere state is reported, and
version numbers set large in mono as page titles (`0.4.0`).

Sizes, weights and tracking: `tokens.json → typography`. Two hard rules:

1. Uppercase + wide tracking is only ever mono, and only for labels, buttons,
   kickers and metadata — never for headings or body.
2. Section kickers keep the parent form exactly: `// 01 Section name`.

## 4. Grid, spacing, containers

- Public: single 1200px column, gutter `clamp(16px, 4cqi, 40px)`, section
  padding `clamp(40px, 6cqi, 88px)`.
- Product: 260px rail + fluid main, 32px gutter, 84px page header, 480px right
  detail drawer.
- Spacing scale: 4, 8, 10, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 88, 104.
- Card grids are a 1px-gap CSS grid over a border-coloured background, so
  dividers are shared hairlines, not doubled borders.
- Layouts are container-driven (`container-type: inline-size`, `cqi` units,
  `auto-fit` grids, `flex-wrap`) so a screen reflows by its own width. This is
  what lets one design serve 1440 / 834 / 390 without media queries.

## 5. Corners, borders, elevation

- `border-radius: 0`. Always. Circular avatars are the only exception.
- 1px borders do the separation work; a 3px top rule marks a card as a stage or
  a state; a 4px left rule marks failure and security items.
- Shadow exists only on true overlays: `0 24px 48px rgba(0,0,0,0.40)` over a
  `rgba(14,19,16,0.72)` scrim.
- Blur: only the sticky public header (`backdrop-filter: blur(6px)`).

## 6. Icon and diagram language

One geometry for the mark, the icons and every diagram: a 32-unit grid, 3-unit
stroke, butt caps, miter joins, orthogonal paths, at most one diagonal.

- Slabs (20 × 4 units, 2.5-unit offset) mean versions.
- Plates with a 3px top rule mean durable stages.
- Thin 2px accent lines are control plane; 4px ink lines are data plane.
- Dashed 1px lines are failure and retry paths.
- Small filled squares are nodes.

No rounded caps, no gradient fills, no isometric illustration, no stock art.

## 7. Component states

Every interactive component defines all seven states. Colour is never the only
difference.

| State    | Treatment                                                                                           |
| -------- | --------------------------------------------------------------------------------------------------- |
| Default  | 1px border or solid accent fill; mono uppercase label                                               |
| Hover    | Border → accent, or fill → accent-hover; card top rule scales in from left                          |
| Focus    | 2px accent ring, 2px offset. Never removed, never colour-only                                       |
| Active   | `scale(0.97)`, 80ms                                                                                 |
| Disabled | Muted fill/border, explicit label change (`GitHub unavailable`), `cursor: not-allowed`              |
| Loading  | Label states the action in progress (`Opening Google…`), control disabled; no spinner-only state    |
| Error    | Ink border (1px + 4px left), `▲` glyph, typed message naming the failure and what was _not_ changed |

## 8. Data visualisation

- Usage meters: single filled bar in a bordered track, numeric `used / limit`
  beside it, and a text state (`WITHIN LIMIT`, `APPROACHING`, `AT LIMIT`). At
  limit the fill turns ink and reads `BLOCKED`.
- Job progress: labelled discrete stages, never a percentage without a stage.
- Version history: newest first, accent on the current version only.
- No pie charts, no sparklines without axis labels, no invented data. Any
  illustrative figure is labelled `ILLUSTRATIVE` in the artwork itself.

## 9. Motion

Durations, easings and patterns: `tokens.json → motion`. Principles:

1. Motion explains state or continuity, nothing else.
2. Nothing loops. Nothing moves without a trigger.
3. The hero request path draws once per page view, stage by stage (220ms each),
   left to right — it is the brand idea in motion.
4. Job state changes crossfade the label (180ms); the glyph swaps instantly, so
   the meaning is never mid-transition.
5. `prefers-reduced-motion: reduce` disables reveals, path drawing and press
   scaling. Every label, glyph and stage renders final immediately.

## 10. Accessibility

- WCAG AA minimum for text (4.5:1) and graphics (3:1); values recorded per
  token.
- Visible focus on every interactive element, 44px minimum touch target.
- One `h1` per page; headings descend in order; landmarks: `header`, `nav`,
  `main`, `aside`, `footer`, with `aria-label` on each `nav`.
- Status carried by label + glyph.
- Mobile layouts never overflow horizontally. Wide diagrams scroll inside their
  own `figure` (with `min-width`) so embedded labels stay legible instead of
  shrinking below readability.
- Code samples are real text, selectable, 13px minimum, in mono at 1.7 leading.
- Alt-text guidance for every custom asset: `ASSET-LICENSES.md` records whether
  an asset is decorative or informative, and the shipped `alt` text for each one
  lives in `component-inventory.md`.

## 11. Empty, loading and failure language

Honest, operational, short. Never "Oops".

- Empty: state the fact, then the next action. "This workspace has no assets
  yet. Connect an MCP client or call the API to request an upload URL."
- Loading: name the action. "Opening Google…", "Leasing job…".
- Failure: name what failed, what did not change, and what to do. "Google
  sign-in did not complete. The provider returned `access_denied`. Nothing was
  created. Try again or use GitHub."
- Expired: "Session expired. Sign in again to return to /dashboard. Queued jobs
  kept running."
- Not built yet: label it `SOON`, `PLANNED`, or `PREVIEW · NOT SHIPPED`. Never
  imply a release that has not happened.
