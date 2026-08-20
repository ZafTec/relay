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
content. Files, Jobs, Usage and Settings (below) all implement this shell
without renegotiating nav.

### `RowDetailDrawer` **A**
480px right-side panel, never a route or a modal. Header: entity id/name +
close (44px). Body: action row (40px buttons), key/value grid, and a scrolling
detail region (versions, steps, log). Used by `Files` (`VersionDrawer`) and
`Jobs` (`JobDrawer`) — same shell, different body.

### `DataTable` **A**
Grid-based table (`display: grid`, not `<table>`), 44px+ rows, 1px row
dividers, hover = `#1D251F`. Selected/current row gets a full-row background;
flagged rows (failed, blocked) get a 4px left rule instead of row tint so
severity and selection never compete for the same signal. Row-action column is
a fixed 44px `⋯` button. Never more than one column of secondary metadata per
row — pack extra facts into the same line with `·`, not a new column, so
columns survive a drawer taking half the viewport.

### `FilterBar` **A**
40px search input + one or more 40px dropdown buttons + a right-aligned mono
summary (count/size or count/date-range). Sits directly under `PageHeader`.

### `StatusTabRow` **A**
Horizontal row of mono chips, one `All N` (filled) + one per state (outlined,
glyph + label + count). Used identically in Jobs (desktop and mobile).

### `LiveIndicator` **A**
40–44px chip: small filled accent dot + `LIVE · 5s poll` in mono. Present on
Jobs' page header while the table polls; absent everywhere state is not
actively refreshed.

### `UploadDropzone` **A**
Dashed 1px (default) → solid 2px accent (drag-over) bordered region, mono
uppercase prompt + a muted constraint line (`MAX 5 GB PER OBJECT`). Appears
inline in the Files empty state and as a full-table overlay on drag-over.

### `ProgressRow` **B**
6–8px flat bar in a `#2E3830` track, filled accent (or ink at 100%/blocked).
Used for upload progress (Files), job step progress (Jobs), and usage meters —
one visual language for "how far along."

### `SkeletonRow` **A**
Static (non-shimmering) muted bars matching the loaded row's grid and height.
No pulsing animation — motion is reserved for state that is actually changing.

### `SelectionBar` **A**
Appears above the table when ≥1 row is checked: accent 1px border, mono
`N selected`, action buttons, right-aligned `Clear`. Destructive actions in the
bar always end in `…` to signal a confirmation follows.

### `ConfirmDialog` **A**
560px `role="dialog" aria-modal="true"`, same shell as `PublishDialog`:
consequence list (`■` non-destructive fact, `▲` destructive fact), an optional
type-to-confirm input for the highest-severity actions (delete asset, delete
workspace), Cancel + a primary button that stays `disabled` until its
confirmation input/checkbox is satisfied.

### `InlineAlert` **B**
1px border + 4px left rule, glyph + mono uppercase title + body copy + 0–2
actions. This is `InlineNotice` used specifically for blocking/limit/offline
states in-page (not modal): quota exceeded, store unreachable, feed
unreachable, metering delayed, permission read-only.

### `UsageMeterCard` **A**
Mono label + state tag (`WITHIN LIMIT` / `▲ APPROACHING` / `■ AT LIMIT`),
large mono figure with a muted unit, `ProgressRow`, mono caption. Three sit in
an `auto-fit` 1px-grid row; the same card (label/figure/bar/caption only)
appears solo on mobile.

### `DailyBarChart` **A**
Two-tone stacked bar (accent = succeeded, ink = failed/retried) per day, flat
bottom axis, mono date ticks at start/mid/"today". No axis lines, no
gridlines, no tooltip in the static design — values are shown in the caption
and in the meter cards above it.

### `SettingsNav` **A**
220px vertical list, same 44px-row / 3px-left-accent pattern as `AppRail`'s
`NavItem`, scoped to one page instead of the whole app.

### `FormSection` **A**
640px max-width column: `h2` + one-line description, then stacked `label` +
input/select/textarea groups (44px controls, mono 10px uppercase field
labels), a muted caption line under fields with consequences. Read-only fields
render as a dashed-border static value, not a disabled input, so the reason
("derived", "owner only") is legible without a tooltip.

### `ConnectionTestPanel` **A**
Button that becomes a disabled `cursor: wait` state naming the specific
operation under test (`Testing LIST…`), then either a `■`-bulleted pass list
(one line per operation) or a `▲` failure card naming exactly which operation
failed and what was not attempted.

### `TokenRevealPanel` **A**
One-time accent-bordered panel shown immediately after creating a token: full
value in a `code` block, `Copy token` button, and a mono caption stating Relay
does not store the value. Never shown again after navigation.

### `ToggleRow` **B**
44×24px flat toggle (no rounded pill) + label + one-line consequence caption.
Used for all boolean settings (retention, auto-retry, notification prefs).

### `MemberRow` **A**
32px square avatar-initials + name/email + role pill (`Owner` accent outline,
`Engineer` neutral outline, `Pending □` dashed) + provider/date + row action.

### `WorkspaceListItem` **A/profile**
Used on `/profile` to list every workspace the account belongs to: name +
id/asset-count/size, role pill, and either `CURRENT` (mono, no action) or
`SWITCH →`.

### `SessionRow` **A/profile**
Client/OS + `· THIS DEVICE` tag when applicable, location + IP + relative
time, and a `Revoke` button (omitted for the current session).

### `ProfileHeader` **A**
Circular initials avatar (the one permitted radius exception), name, email,
connected-provider chips, conditional `Superadmin` chip. Explicitly not
workspace-scoped — carries no workspace switcher.

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
`Publish 0.5.0`. Publication is never one click from a list row. Same shell as
`ConfirmDialog` above — this is that component with a security-specific body.

---

## Public docs & status

### `DocsLayout` **P**
Three-column shell: 260px grouped nav (Start here / Guides / Reference, `SOON`
tags for unpublished pages) · fluid article (breadcrumb, `h1`, fact chips,
numbered `h2` sections, `CodeBlock`) · 220px `on this page` rail with active
section indicated by a 2px left accent. Collapses to a top tab row + single
column on mobile; no third column.

### `DocsSearch` **P**
`⌘/Ctrl-K`-style overlay: 560px panel, input + result list grouped as
`N results`, each result showing title, one-line description and a mono
breadcrumb. States: populated, no-results (with two suggested links), and the
persistent footer hint row (`↑↓ NAVIGATE`, `↵ OPEN`, `ESC CLOSE`).

### `CodeBlockTabs` **P**
`CodeBlock` variant with a language/client toggle (`CURL` / `MCP`) plus
`COPY` → `COPIED ■` (1.5s, no toast).

### `StatusBanner` **P**
Full-width fact block, 4px left rule. Three fixed states: operational (`■`
accent, ink border), degraded/incident (`▲`, ink border, ink surface), major
outage (`▲`, inverted to ink background — the only place the public surface
goes dark). Always states the plain-language consequence
(`Uploads & reads unaffected`) next to the technical detail.

### `ComponentStatusRow` **P**
Label + status (`■ Operational` / `▲ Degraded`) + a day-by-day bar strip (45
days desktop, 30 mobile; each bar full = up, short = degraded, hollow-outlined
= outage) + a right-aligned uptime percentage. Never shows object-store health
— only what Relay itself operates.

### `IncidentTimeline` **P**
Vertical connector line with a filled node per update (most recent), hollow
nodes for earlier updates; each entry is a mono timestamp + status word +
plain-language body. Always states what is and is not affected.

### `IncidentHistoryRow` **P**
Date + status tag (`DEGRADED` outline, `MAINTENANCE` filled, future:
`RESOLVED`/`COMPLETED` duration) + one-line summary + duration, as a link row
matching `ChangelogPreview`'s row pattern.
