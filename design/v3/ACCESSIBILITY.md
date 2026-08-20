# Relay — accessibility contract

Registry/artifact pivot, 2026-08-20. This is the accessibility **contract** the
design commits to — the semantic, keyboard, and ARIA behavior every screen must
implement. It is not itself an audit: no automated scanner or screen-reader
session ran against these files in this environment. §7 lists exactly what still
needs to run before the acceptance checklist can be marked complete.

## 1. Structure

- One `h1` per page; headings descend without skipping levels.
- Landmarks on every screen: `header`, `nav[aria-label]` (one per distinct nav —
  "Primary", "Sections", "Settings sections", "Superadmin sections", "Footer",
  "Breadcrumb"), `main`, `aside[aria-label]` for drawers, `footer`.
- Tabular data (`Tools`, `Runs`, `Members`, `MCP clients`, `Storage by prefix`,
  the admin registry list) is a real `<table>` with `<caption>` and
  `scope="col"` headers — never a styled `display: grid` standing in for one.
  `Relay Tools.dc.html`, `Relay Runs.dc.html`, `Relay Artifacts.dc.html`,
  `Relay Usage Settings Profile.dc.html`, and `Relay Admin.dc.html` ship this
  pattern; carry it into implementation rather than reverting to div-grids.

## 2. Forms

- Every input, select, and textarea has a visible `<label for>`, not a
  placeholder standing in for one.
- Invalid fields carry `aria-invalid="true"` and `aria-describedby` pointing at
  an adjacent `role="alert"` message that states the rule, not just "invalid"
  (see the composer's validation states in `Relay Tools.dc.html`).
- Toggles are real `<input type="checkbox">` (visually restyled) with
  `checked`/`disabled` reflected in the DOM, not a styled `<span>` alone — where
  this deliverable used a styled span for a toggle look, implementation must
  wrap a real checkbox input underneath it.
- Read-only-because-of-permission fields render as a dashed-border static value
  with a stated reason ("owner only", "derived"), never a disabled input with no
  explanation and never simply hidden.

## 3. Touch targets and focus

- Every interactive element — row action buttons, nav items, filter chips,
  mobile toggles, table row links — is ≥ 44×44 CSS px.
- Every interactive element has a visible focus-visible ring: 2px accent
  (`#63C8BC` product / `#1F776E` public), 2px offset, never removed with
  `outline: none` and no replacement.
- Dialogs (`ConfirmDialog`, `PublishDialog`, delete-workspace, cancel-run,
  create-share-link) trap focus, open with focus on the first field or the
  dialog heading, close on Escape, and return focus to the control that opened
  them.
- Mobile full-screen sheets (artifact detail, run detail on narrow viewports)
  follow the same open/trap/Escape/return-focus contract as a dialog.

## 4. Live regions and status

- The SSE connection indicator (`Relay Runs.dc.html`) is `role="status"`;
  connect/reconnect/stale/offline/resync transitions announce once per
  transition, not per tick.
- Copy-confirmation ("COPIED ■"), connection-test results, and "run succeeded"
  toasts use `role="status" aria-live="polite"` — informational, not
  interrupting.
- Blocking errors (quota exceeded, publish blocked, deletion blocked) use
  `role="alert"` since they require attention before the user can proceed.
- Progress bars (usage meters, job/run step progress, upload progress) carry
  `role="progressbar"` with `aria-valuenow`/`aria-valuemin`/`aria-valuemax` and
  a text equivalent alongside the bar — the mono percentage/fraction label
  already shown in every meter in this deliverable _is_ that text equivalent;
  keep it paired with the ARIA value in implementation, don't drop one for the
  other.

## 5. Charts and diagrams

- Every bar chart (usage-per-day, uptime strips) ships an accessible data table
  with the same values, collapsed under a `<details>` disclosure right next to
  the chart — see `Relay Usage Settings Profile.dc.html`'s "Accessible data
  table" and the status page's uptime strips. The chart region itself carries
  `role="img"` with an `aria-label` summarizing the trend, since it is
  presentational once the table exists.
- Every custom SVG diagram (`assets/*.svg`) has a `<title>` element with a
  description of the flow, and the `<img>` referencing it has matching `alt`
  text — both already written into the shipped files; keep them in sync if the
  diagrams change.
- Wide diagrams that scroll horizontally (`overflow-x: auto` figures) are
  `tabindex="0"` with an `aria-label` naming the region, so keyboard users can
  scroll them without a mouse.

## 6. Content

- No status is color-only: every state pairs a glyph (`■ □ ▲ ―`) with a text
  label. Verified across Tools, Runs, Artifacts, Admin, Usage, and Status.
- Long identifiers (run ids, share-link paths, tokens) use
  `overflow-wrap: anywhere` so they wrap instead of overflowing at any zoom
  level or viewport width.
- Illustrative figures and fixtures are labelled in the artifact itself
  (`ILLUSTRATIVE`, `SAMPLE`, provider/model names called out as fixtures on the
  landing page and in `Relay Tools.dc.html`'s intro) — this is a content rule as
  much as an accessibility one: a screen reader user gets the same "this isn't
  real data" signal as a sighted user reading the badge.

## 7. Not yet run — do before sign-off

These require tooling this design environment doesn't have. Track them as
acceptance-checklist items owned by engineering/QA, not as open design
questions:

1. **Automated WCAG scan** (axe-core or equivalent) against the built pages, not
   the static design files — dynamic states (open dialogs, populated tables)
   need to be exercised.
2. **Keyboard-only walkthrough** of the golden path: browse → contract →
   composer → run detail → artifact detail → create share link.
3. **Screen-reader walkthrough** (VoiceOver + NVDA at minimum) of the same path,
   plus the SSE state region and the publish/delete confirmation dialogs.
4. **320px reflow** and **200% text zoom** on Tools, Runs, Artifacts, and
   Settings — this deliverable's mobile artboards are fixed at 390px and were
   not stress-tested at 320px or with system font scaling.
5. **High-contrast mode** (Windows High Contrast / forced-colors) — the
   glyph+label status pattern should survive it, but forced-colors can strip
   background fills that currently carry the 4px severity rule; verify the rule
   remains visible as a border, not only a background.
6. **prefers-reduced-motion** — confirm the built implementation actually
   disables the hero path-draw, reveal stagger, and press-scale per
   `DESIGN.md §9`, not just that the design intends it to.
