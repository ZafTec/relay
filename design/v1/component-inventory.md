# Relay — component inventory

Every component below appears in at least one delivered screen. Names are
proposed React component names; the source of truth for geometry and values is
`tokens.json` plus the screen it appears in.

Legend for surface: **P** public/paper, **A** authenticated/onyx, **B** both.

---

## Brand

### `RelayMark`
**B** · slab stack, 32-unit grid. Props: `size` (16 | 20 | 24 | 32 | 48+),
`surface` ('paper' | 'onyx' | 'mono').
Slab count reduces with size: 4 slabs ≥ 24px, 3 at 21–23px, 2 at ≤ 20px.
Accent on the top slab only. Files: `brand/relay-mark*.svg`.
Decorative when paired with the wordmark (`aria-hidden`), otherwise
`role="img"` with label "Relay".

### `RelayLockup`
**B** · mark + "Relay" (sans 500, 0.01em) + optional "by ZafTech" (mono 9–10px,
0.14em, muted). `by ZafTech` is present on all public pages and on `/sign-in`;
it is removed inside `/dashboard` and `/admin`.
Clear space: one slab height (mark height ÷ 4) on all sides. Minimum mark size
16px; minimum lockup width 96px.

---

## Public components

### `SiteHeader` **P**
Sticky, `rgba(245,244,237,0.92)` + `blur(6px)`, 1px bottom border, 68px tall.
Lockup left; nav Product · Workflow · Security · Changelog · Docs; then
`Sign in` (outline) and `Open dashboard` (accent fill). All nav items 44px
minimum height, `white-space: nowrap`, wrap to a second row below ~900px.
States: default, hover (ink), current (`aria-current`, 2px accent underline).

### `Kicker` **B**
`// 01 Section name`. Mono 11px, 0.14em, accent; the number is muted.

### `HeroStatement` **P**
`clamp(38px, 7cqi, 82px)` sans 700, three lines, then a 380px+ paragraph and two
buttons in a wrapping row.

### `Button` **B**
Variants: `solid-ink` (paper surface), `solid-accent`, `outline`, `ghost`.
Heights 44 (nav, table actions) / 48 (page CTA) / 52 (OAuth). Mono uppercase
label, sharp corners, `scale(0.97)` on press, `nowrap`.

### `FactGrid` **P**
`auto-fit minmax(240px, 1fr)` grid over a 1px border-coloured background. Each
cell: mono category label, 17px bold title, 15px body. Hover lifts the cell
background to paper.

### `StepList` **P**
Ordered list, one row per step, 1px shared dividers, mono index in accent, bold
tool name inline in the sentence.

### `DiagramFigure` **B**
`figure` with 1px border and `overflow-x: auto`; the `img` carries
`width: 100%; min-width: 560px`. Below ~600px the diagram scrolls inside the
figure instead of shrinking its labels. Alt text is mandatory and describes the
*flow*, not the shapes — see the strings in `Relay Landing.dc.html`, which are
the shipped copy.

### `CodeBlock` **B**
Onyx panel, 1px border, chrome bar with two dots and a mono filename/caption
(`relay.enqueue_job — illustrative`). Body: mono 13px / 1.7, accent for tool
names and states, ink for literals, `overflow-x: auto`.

### `TagRow` **P**
Mono 11px bordered chips, 6px × 10px padding, wrapping row. Used for deployment
facts and changelog category filters.

### `ChangelogPreview` **P**
Three most recent published releases. Row: version (mono 14px bold, 68px min),
date (mono 11px muted, 96px min), category tag, one-line summary. Whole row is
the link; hover lifts the background.

### `SiteFooter` **P/A-dark**
Onyx. Lockup, ZafTech legal block, three link columns (Product · Legal ·
ZafTech). `nav[aria-label="Footer"]`.

---

## Auth

### `AuthSplit` **A**
55/45 split. Left: technical-grid panel with lockup, statement, mono footnote.
Right: 420px auth column. Below 900px the left panel becomes a short bordered
statement block above the column (see mobile artboard).

### `ProviderButton` **A**
52px, full width, mono uppercase, square glyph placeholder + label + trailing
arrow. Google = ink-on-paper fill (primary), GitHub = outline.
States: default, hover, loading (`Opening Google…`, both disabled), unavailable
(dashed border, label `GitHub unavailable`, `SEE STATUS`), error (see
`InlineNotice`).
**Implementation note:** the square is a placeholder. Substitute the official
Google and GitHub marks per their brand guidelines at build time; do not draw
approximations.

### `LegalNote` **A**
13px, 1.7 leading, muted, with accent links to Terms and Privacy. States what
signing in creates and where bytes live.

### `InlineNotice` **B**
1px ink border with a 4px left rule, `▲` glyph, mono uppercase title, 14px body.
Variants: `error`, `warning`, `info` (border only). Never colour-only.

---

## Product shell

### `AppRail` **A**
260px, `#121815`, 1px right border. Order is fixed: mark → `WorkspaceSwitcher`
→ section nav → permission-dependent superadmin entry → `SessionMenu`.
Collapses to a hamburger drawer below 900px.

### `WorkspaceSwitcher` **A**
Button, 44px+, mono `WORKSPACE` label, workspace name, accent workspace id,
`▾`. Superadmin screens replace it with a fixed `SCOPE: PLATFORM` block — no
workspace can be selected there.

### `NavItem` **A**
44px minimum. Current: `#1D251F` fill + 3px accent left border +
`aria-current="page"`. Placeholder sections carry a bordered mono `SOON` tag and
remain focusable links.

### `SessionMenu` **A**
56px row: 32px square initials tile, name, mono `SESSION · SIGN OUT`, `▾`.

### `PageHeader` **A**
84px, 1px bottom border. Left: mono scope label (`WORKSPACE ws_a1f9`) + `h1`.
Right: secondary + primary action, both 44px, `nowrap`. Every product page uses
this contract.

### `EmptyState` **A**
Bordered `#1D251F` panel, 40px padding. Mono state label, 24px heading, 52ch
body, two buttons, and an optional `CodeBlock` on the right showing the first
call. Text states the fact and the next action; it never fakes data.

### `PlannedTile` **A**
Three-column 1px grid of labelled placeholders (`PLANNED · FILES`). Muted, not
interactive, explicitly captioned as not-shipped so the space later screens fill
is visible without pretending it exists.

### `ShellSpec` (documentation only)
The annotated future-shell diagram in `Relay App Screens.dc.html`: rail 260px,
page header 84px, content 32px gutter, right detail drawer 480px overlaying
content. Files/Jobs/Usage/Settings all fit this without renegotiating nav.

---

## Changelog

### `ReleaseList` **P**
`article` per release: 200px meta column (version link, date, `tag · commit`)
and a flexible items column. 1px divider between releases.

### `CategoryTag` **B**
Mono 10px, 0.12em. `ADDED` accent outline · `IMPROVED`/`FIXED` neutral outline ·
`BREAKING` ink outline · `SECURITY` ink fill + `▲`. Category is always readable
as text.

### `ReleaseEntry` **P**
860px column. Mono 56px version as `h1`, meta row (published date, tag, commit,
category tags), then one `section` per category with a mono uppercase heading and
glyph-prefixed items. Prev/next + RSS at the foot.

### `FeedAffordance` **P**
Outline button `RSS feed` in the page header and at the end of an entry.

### `AdminReleaseTable` **A**
Columns: version · state · tag · commit · items · last change + actions.
State pill: `PUBLISHED ■` (outline), `DRAFT □` (accent fill), `ARCHIVED ―`
(dashed, 60% opacity). Actions are 44px links: Edit, Preview, Unpublish, View.

### `ReleaseEditor` **A**
Four-up metadata inputs (version, git tag, commit SHA, publication date);
required-but-empty fields get an ink border plus a `▲` note — never colour only.
Item rows: category select + text input + remove button. A security item gains a
4px left rule and an inline disclosure warning.
Right column: `PublishChecks` (glyph list, `■` pass / `▲` blocking) and
`AuditTrail` (timestamp, action, actor · role; append-only).

### `PreviewBanner` **A over P**
Onyx bar over the rendered public entry: `PREVIEW □`, `DRAFT 0.5.0 · NOT
PUBLISHED · VISIBLE TO SUPERADMIN ONLY`, plus Back to editor and Publish.
The preview body renders the real public entry component at 45% opacity so it
cannot be mistaken for the live page.

### `PublishDialog` **A**
560px `role="dialog" aria-modal="true"` over a `rgba(14,19,16,0.72)` scrim, with
the only shadow in the system. Consequence list, blocking-check notice, a
required confirmation checkbox for security disclosure, Cancel + disabled
`Publish 0.5.0`. Publication is never one click from a list row.
