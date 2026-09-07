# Relay — design handoff

Version: v2 historical snapshot; not approved for the current registry-first
product\
Revision backlog: [`DESIGN-AGENT-SUGGESTIONS.md`](DESIGN-AGENT-SUGGESTIONS.md)

Identity **Ledger** (Direction B, owner-selected 2026-07-29) · design pass only
· no production code in this deliverable.

Implementation may begin **after** the owner merges this branch. Nothing here
authorises app, API, worker, infra or CI work beyond building the screens below.

---

## 1. Chosen identity rationale

Ledger reads the product model literally: four slabs, fixed 2.5-unit rightward
offset, accent on the newest slab only — an asset whose earlier versions remain
visible beneath the current one. It is compact and vertical (strong in a browser
tab and an app rail), reuses the exact slab geometry already drawn inside the
version and hero diagrams, and needs no gradient or depth trick to work.

Three binding rules keep it clear of database / layer / blockchain marks:

1. Offset stays aggressive (2.5 units per slab); a tight stack reads as a
   database.
2. Accent marks the newest slab only — never a ramp across the stack.
3. Slab count reduces with size: 4 at ≥ 24px, 3 at 21–23px, 2 at ≤ 20px (incl.
   favicon).

Two elements were carried over from the unselected directions: mono technical
notation for all metadata, and a paper surface for public pages so `/` can never
be mistaken for `/dashboard`.

Reviewable exploration of all three directions:
`Relay Identity Directions.dc.html`.

## 2. File map

```text
design/v2/
  DESIGN.md                  design system: surfaces, colour, type, grid, states, motion, a11y
  tokens.json                machine-readable tokens (hex + oklch + contrast + motion + a11y)
  content-guidelines.md      voice, casing, claims discipline, naming, error/empty copy
  component-inventory.md     every component, its props, states, and shipped alt text
  ASSET-LICENSES.md          provenance: fonts, originality, marks deliberately not used
  HANDOFF.md                 this file
  brand/
    relay-mark.svg               32×32, 4 slabs, full colour
    relay-mark-mono.svg          32×32, currentColor
    relay-mark-reverse.svg       32×32, light ramp for dark surfaces
    relay-wordmark.svg           108×28, stroke-built RELAY, no font dependency
    relay-by-zaftech-lockup.svg  232×32, mark + wordmark + BY ZAFTECH
    favicon.svg                  32×32, 2-slab on ink plate
    favicon-16.png / favicon-32.png / apple-touch-icon.png (180×180)
  assets/
    hero-request-to-result.svg   1200×340
    immutable-version-stack.svg  760×346
    job-lifecycle.svg            924×306
    signed-url-delivery.svg      924×334
    mcp-tool-flow.svg            924×364
    workspace-isolation.svg      932×322
    usage-entitlements.svg       924×338
  screens/
    landing-desktop.png 1440w · landing-tablet.png 834w · landing-mobile.png 390w
    sign-in-desktop.png 1440×900 · sign-in-mobile.png 390×844
    dashboard-desktop.png 1440×900 · dashboard-mobile.png 390×844
    changelog-public-desktop.png · changelog-entry-desktop.png
    changelog-admin-list.png · changelog-admin-editor.png · changelog-admin-preview.png
    docs-desktop.png · docs-search.png · docs-mobile.png
    status-operational.png · status-degraded.png · status-mobile.png
    files-desktop.png · files-mobile.png · jobs-desktop.png · jobs-mobile.png
    usage-desktop.png · usage-mobile.png · settings-desktop.png · profile-desktop.png
```

**Inspectable source (the real deliverable — PNGs are review artefacts):**

| File                                   | Contains                                                                                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Relay Identity Directions.dc.html`    | Phase 1: three directions, marks at review + 16/24/32px, favicons, mono applications, risks, selection record                                                                                                                                         |
| `Relay Landing.dc.html`                | `/` — full responsive landing, reflows by container width                                                                                                                                                                                             |
| `Relay App Screens.dc.html`            | `/sign-in` desktop + mobile + 4 states; `/dashboard` overview desktop + mobile; annotated future shell                                                                                                                                                |
| `Relay Changelog Screens.dc.html`      | `/changelog`, entry page, admin list, editor, preview + publish dialog                                                                                                                                                                                |
| `Relay Docs and Status.dc.html`        | `/docs` (article, search, breadcrumbs, TOC, nav states) + mobile; `/status` (operational, active incident, upcoming maintenance, outage, feed-unreachable, subscribe) + mobile                                                                        |
| `Relay Files and Jobs.dc.html`         | `/dashboard/files` populated + drawer + empty/drag/loading/selection/delete/blocked/offline/no-match states; `/dashboard/jobs` populated + run-detail drawer + empty/failed/enqueue/blocked/cancel states; both mobile                                |
| `Relay Usage Settings Profile.dc.html` | `/dashboard/usage` (meters, daily chart, per-prefix breakdown, at-limit) + states + mobile; `/dashboard/settings` (general, object store, tokens, members, danger zone) + states; `/profile` (identity, workspaces, sessions, notifications) + states |

These are self-contained HTML design artefacts, not the production frontend. No
tab in the product is a placeholder anymore — Files, Jobs, Usage, Settings and
Profile are fully designed with their states and events, matching the shell spec
from `Relay App Screens.dc.html`.

## 3. Colour (implementation values)

Full set in `tokens.json`. Do not sample colours from the PNGs.

**Product (onyx):** bg `#141A16` · rail `#121815` · surface `#1D251F` · border
`#2E3830` · border-strong `#414D45` · ink `#F5F4ED` · ink-secondary `#B4C0B6` ·
ink-muted `#8E9A92` · accent `#63C8BC` · accent-hover `#86D6CD`.

**Public (paper):** paper `#F5F4ED` · paper-2 `#EFEDE2` · border `#D8D5C8` ·
border-strong `#C9C7BA` · ink `#141A16` · ink-secondary `#46514B` · ink-muted
`#5F6B64` · accent `#1F776E` · accent-hover `#145B54` · invert fill `#141A16`.

**Mark slabs:** `#3F4E47` `#57685F` `#7A8C84` + top slab `#63C8BC` (dark) or
`#1F776E` (light). Reverse ramp `#4C5A52` `#6B7C74` `#9BA9A1` `#63C8BC`.

Greys are surface-specific by design: `#7A8C84` is 5.1:1 on onyx but only 3.2:1
on paper. Never move a grey across surfaces without re-checking.

## 4. Type

Plus Jakarta Sans (400/500/700) + JetBrains Mono (400/500/700), both OFL 1.1,
already self-hosted in the parent repo (`public/fonts/`). Serve locally with
`font-display: swap`; no Google Fonts request. Trade-off discussion:
`DESIGN.md §3`.

Wordmark is live text: sans 500, `letter-spacing: 0.01em`, sentence case
"Relay". `by ZafTech` is mono 9–10px, 0.14em, muted — present on public pages
and `/sign-in`, removed inside `/dashboard` and `/admin`.

## 5. Responsive behaviour

Breakpoints: mobile ≤ 640 · tablet 641–1024 · desktop ≥ 1025 · app rail
collapses ≤ 900.

The designs are **container-driven**: `container-type: inline-size` on the page
root, `cqi` units in the type/space clamps, `auto-fit minmax()` grids and
`flex-wrap` rows. A screen therefore reflows by its own width, which is how the
same source produced the 1440 / 834 / 390 exports without media queries. Keep
this approach in React, or convert to the breakpoints above — but do not mix.

- Header nav wraps to a second row below ~900px; every item stays ≥ 44px.
- Two-column sections collapse to one at ~640px content width
  (`flex: 1 1 380px`).
- Wide diagrams do **not** shrink below legibility: each `figure` is
  `overflow-x: auto` and each diagram `img` is `width: 100%; min-width: 560px`
  (hero excepted at 100%/560px too). The page itself never overflows.
- App rail → hamburger drawer + horizontal chip row (see
  `dashboard-mobile.png`).

## 6. Interaction specification

| Trigger                              | Change                                                                                   | Duration  | Easing                       |
| ------------------------------------ | ---------------------------------------------------------------------------------------- | --------- | ---------------------------- |
| Section enters viewport (first time) | opacity 0→1, translateY 20px→0, 80ms stagger per grid item                               | 400ms     | `cubic-bezier(0.16,1,0.3,1)` |
| Card / row hover                     | top rule `scaleX(0→1)` from left; background lifts one step                              | 180ms     | out-strong                   |
| Button press                         | `scale(0.97)`                                                                            | 80ms      | out-strong                   |
| Hero first view                      | request path connects stage by stage, left to right, 220ms per stage, once per page view | 220ms × 6 | linear                       |
| Job state change                     | label crossfade; glyph swaps instantly                                                   | 180ms     | linear                       |
| Version select                       | accent moves to the selected slab/row; no reflow                                         | 180ms     | out-strong                   |
| Dialog open                          | scrim fade + dialog opacity; no scale, no slide                                          | 180ms     | out-strong                   |

`prefers-reduced-motion: reduce` disables reveals, path drawing and press
scaling. Everything renders in its final state; no information is motion-only.

## 7. Component states

`component-inventory.md` lists every component with props and states. Universal
contract: **default · hover · focus · active · disabled · loading · error**.

- Focus: 2px accent ring, 2px offset, never removed.
- Loading: the label names the action (`Opening Google…`); no spinner-only
  state.
- Disabled: muted fill/border **and** a changed label (`GitHub unavailable`).
- Error: 1px ink border + 4px left rule + `▲` + typed message stating what
  failed, what did not change, and what to do.
- Status never depends on colour: `■` succeeded/published · `□` queued/draft ·
  `▲` failed/security · `―` archived.

## 8. Accessibility notes

- AA minimum, per-token contrast recorded in `tokens.json`.
- 44px minimum touch targets throughout (verified on the mobile artboards).
- One `h1` per page; `header` / `nav[aria-label]` / `main` / `aside` / `footer`.
- Publish dialog: `role="dialog" aria-modal="true"` + `aria-labelledby`; focus
  trapped; Escape cancels; the destructive action stays disabled until its
  blocking check clears and the confirmation checkbox is ticked.
- `aria-current="page"` on the active nav item (rail and public header).
- Every diagram is informative: use the exact `alt` strings from
  `Relay Landing.dc.html`; the same text is in each SVG `<title>`.
- Illustrative data is labelled in the artwork, not only in surrounding copy.

## 9. Implementation notes (React + Vite)

1. **Assets.** Copy `design/v2/brand/` and `design/v2/assets/` into
   `apps/web/public/relay/`. Reference diagrams as `<img src>` — do not inline
   them into JSX; they are documents with their own `<title>`.
2. **Favicons.** `favicon.svg` (any-size), `favicon-32.png`, `favicon-16.png`,
   `apple-touch-icon.png` at 180. Theme colour `#141A16`.
3. **Tokens.** Generate CSS custom properties from `tokens.json` at build time,
   scoped as `.surface-public` / `.surface-product` so a grey cannot leak across
   surfaces. Do not hand-copy hex values into components.
4. **Fonts.** `@font-face` from the parent repo's woff2 files,
   `font-display:
   swap`, weights 400/500/700 for both families only.
5. **Corners.** Set `border-radius: 0` globally and treat any radius in review
   as a bug (circular avatars excepted).
6. **Layout.** Public pages: one 1200px column. Product pages: 260px rail +
   main, 32px gutter, 84px page header, 480px right drawer. Row detail always
   opens in the drawer — never a new route, never a modal.
7. **Route → design mapping.** `/` → `Relay Landing.dc.html` · `/sign-in` → App
   Screens (sign-in artboards + 4 states) · `/dashboard` → App Screens (overview
   artboards + shell spec) · `/dashboard/files` → Files and Jobs (Files
   artboards + 9 states) · `/dashboard/jobs` → Files and Jobs (Jobs artboards +
   drawer + 9 states) · `/dashboard/usage` → Usage Settings Profile (Usage
   artboards + 3 states) · `/dashboard/settings*` → Usage Settings Profile
   (Settings artboards, 5 sections
   - 6 states) · `/profile` → Usage Settings Profile (Profile artboards + 4
     states) · `/docs*` → Docs and Status (doc artboards + search + 4 states) ·
     `/status` → Docs and Status (status artboards + 4 states) · `/changelog`
     and `/changelog/:version` → Changelog Screens (public artboards) ·
     `/admin/changelog*` → Changelog Screens (admin artboards). All routes named
     in the brief are now designed; see §11 for what remains out of scope
     entirely (nothing route-level — only cross-cutting build items).
8. **OAuth buttons.** Replace the placeholder square with the official Google
   and GitHub marks under each provider's brand guidelines before launch.
9. **Empty states are the default.** Build the empty state first; the dashboard
   is specified to look correct with zero rows, and must never render fake data.
10. **Superadmin.** A separate permission and a separate scope block, not a
    workspace role. `/admin` never shows a workspace switcher.

## 10. Handoff checklist

| #  | Item                            | Status                                                                                                                                                                          |
| -- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Chosen identity rationale       | §1 + `Relay Identity Directions.dc.html`                                                                                                                                        |
| 2  | Logo files                      | `brand/` — 9 files                                                                                                                                                              |
| 3  | Tokens                          | `tokens.json`                                                                                                                                                                   |
| 4  | Component inventory             | `component-inventory.md`                                                                                                                                                        |
| 5  | Landing screens                 | 1440 / 834 / 390 + source DC                                                                                                                                                    |
| 6  | Sign-in screens                 | desktop + mobile + loading / error / unavailable / expired                                                                                                                      |
| 7  | Dashboard overview screens      | desktop + mobile + future shell spec                                                                                                                                            |
| 8  | Changelog screens               | public list, entry, admin list, editor, preview + publish dialog                                                                                                                |
| 9  | Custom SVG assets               | `assets/` — 7 diagrams                                                                                                                                                          |
| 10 | Docs screens                    | article, search (open/no-results), 404, unwritten section, code-copy state, mobile                                                                                              |
| 11 | Status screens                  | operational, active incident (timeline), upcoming maintenance, major outage, feed-unreachable, subscribe, mobile                                                                |
| 12 | Files screens                   | populated + version drawer, empty, drag-over, loading skeleton, selection bar, delete confirmation, storage-at-limit, store-unreachable, filter-no-match, mobile                |
| 13 | Jobs screens                    | populated + run-detail drawer, empty, failed detail, live-update event, enqueue form, quota-blocked, no-workers, cancel confirmation, mobile                                    |
| 14 | Usage screens                   | 3 meters + daily chart + per-prefix breakdown + at-limit panel, empty, metering-delayed, export preparing/ready, mobile                                                         |
| 15 | Settings screens                | object store (form + connection test pass/fail), general, tokens (create/reveal/revoke), members (owner/engineer/pending), danger zone (delete workspace), permission-read-only |
| 16 | Profile screens                 | identity + providers, workspace list, active sessions, notification prefs, disconnect-blocked, session-menu, delete-account-blocked                                             |
| 17 | Responsive behaviour            | §5                                                                                                                                                                              |
| 18 | Interaction specification       | §6                                                                                                                                                                              |
| 19 | Accessibility notes             | §8 + `DESIGN.md §10`                                                                                                                                                            |
| 20 | Content / copy                  | `content-guidelines.md`                                                                                                                                                         |
| 21 | Asset licences                  | `ASSET-LICENSES.md`                                                                                                                                                             |
| 22 | React/Vite implementation notes | §9                                                                                                                                                                              |

## 11. Known gaps — flag before implementation

1. **No repository context was available in this environment.** The brief's
   required reading (`docs/architecture.md`, `docs/brand.md`, `docs/legal.md`,
   `docs/versioning.md`, `.superdesign/*`) and the parent-brand site could
   not be opened here; the parent visual language came from the bound ZafTech
   design system, and product facts came from the brief itself. Re-check three
   things against the repo before merging: exact route list, legal footer
   wording, and versioning/changelog category vocabulary.
2. **Repository location.** This historical handoff and its seven `.dc.html`
   sources are preserved together under `design/v2/`. It must not be treated as
   the current implementation target; complete the linked revision backlog in a
   new version and obtain owner approval.
3. **OAuth provider marks** are placeholders (§9.8).
4. **Numeric figures throughout (usage meters, job durations, storage-by-prefix,
   uptime bars, session locations) are illustrative**, generated for layout
   review — wire them to real metering, job, and auth data during
   implementation. None should be read as a product commitment.
5. **Settings sections not drawn:** `General` beyond the fields shown, and the
   `MCP clients` section, are named in the settings nav but not separately
   mocked — they follow the same 640px form-column pattern as Object store and
   General; build them from that pattern rather than waiting on new screens.
6. **Screens PNGs are exports of the DC sources.** If a value is ever in doubt,
   the DC file and `tokens.json` win.
