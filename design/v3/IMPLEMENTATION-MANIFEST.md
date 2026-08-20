# Relay design v3 implementation manifest

Status: owner-authorized repository snapshot and current implementation
reference\
Snapshot commit: `1eb7a3d` (`Add Relay v3 design handoff`)\
Product authority:
[`../../docs/product-and-roadmap.md`](../../docs/product-and-roadmap.md)\
Engineering handoff:
[`../../docs/implementation-handoff/README.md`](../../docs/implementation-handoff/README.md)

## Source precedence

When v3 files conflict, implement in this order:

1. `docs/product-and-roadmap.md` for product and architecture invariants.
2. `docs/implementation-handoff/` for technical boundaries, ordering, and tests.
3. This manifest for v3 package status and explicit exceptions.
4. `HANDOFF.md` for registry-first screen intent.
5. `ACCESSIBILITY.md` for semantic, keyboard, and assistive-technology behavior.
6. `DESIGN.md` and `tokens.json` for visual foundations.
7. Current `.dc.html` canvases for composition and state reference.
8. PNG exports for review only; many are stale.
9. `component-inventory.md` and `content-guidelines.md` only where they do not
   retain the superseded storage-first model.

An implementation agent must report a conflict rather than silently selecting a
lower-precedence source.

## Package layout

```text
design/v3/
  IMPLEMENTATION-MANIFEST.md
  HANDOFF.md
  ACCESSIBILITY.md
  DESIGN.md
  tokens.json
  component-inventory.md
  content-guidelines.md
  ASSET-LICENSES.md
  brand/
  assets/
  screens/
  Relay *.dc.html
  _ds/
  support.js
  image-slot.js
  uploads/
```

The package is intentionally flattened to match `design/v1/` and `design/v2/`.

## Raw provenance files

Preserve these files unchanged as design provenance. They must not be imported
or copied into production application code:

```text
*.dc.html
support.js
image-slot.js
.thumbnail
_ds/
uploads/
```

The `.dc.html` files are raw visual canvases. They contain inline styles, inert
controls, design-host elements, template syntax, and external runtime loading.
They are not production HTML or JSX.

## Visual source files

Copy approved source assets into the web app rather than linking to the design
directory at runtime:

```text
brand/
assets/
tokens.json
```

Preserve originals in v3 for comparison. Production-derived assets and generated
CSS belong under `apps/web/`.

## Route and canvas map

| Canvas                                 | Intended surfaces                                        | Status                                                                 |
| -------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| `Relay Landing.dc.html`                | `/`                                                      | Registry-first source; current PNG export absent                       |
| `Relay App Screens.dc.html`            | `/sign-in`, `/dashboard`, shell                          | Updated IA mixed with some storage-era copy; existing PNGs stale       |
| `Relay Tools.dc.html`                  | `/dashboard/tools`, tool detail, composer                | Registry-first source; provider/model/price values are fixtures        |
| `Relay Runs.dc.html`                   | `/dashboard/runs`, run detail                            | Registry-first source; desktop-heavy and missing some failure variants |
| `Relay Artifacts.dc.html`              | `/dashboard/artifacts`, artifact detail, share recipient | Registry-first source; `/share` path remains an open product decision  |
| `Relay Usage Settings Profile.dc.html` | usage, MCP settings, profile                             | Updated but existing PNGs stale                                        |
| `Relay Admin.dc.html`                  | tool/provider administration and MCP onboarding          | Partial-depth admin reference; audit screen missing                    |
| `Relay Changelog Screens.dc.html`      | public/admin changelog                                   | Carried forward; role names and examples need product reconciliation   |
| `Relay Docs and Status.dc.html`        | docs and status                                          | Updated in part; contains stale route/copy fragments                   |
| `Relay Identity Directions.dc.html`    | identity provenance                                      | Historical exploration; Ledger remains selected                        |

## Approved navigation direction

```text
Overview / Tools / Runs / Artifacts / Usage / Settings
```

For the single-workspace MVP, show a non-interactive current-workspace label. Do
not expose a workspace switcher until multi-workspace behavior is implemented.

## Golden path

```text
browse tool
  -> inspect contract and meter
  -> configure inputs
  -> review estimate and reservation
  -> submit run
  -> observe queue/run/attempt state
  -> inspect one or many artifacts
  -> create or copy a managed share link
```

The production implementation must support this path through typed application
contracts. Canvas fixture data is not an API contract.

## Required states

- Tool available, internal, blocked, degraded, deprecated, disabled, retired
- Composer validation, estimating, reserving, idempotent replay, quota denial
- Run queued reasons, running, partial, failed, reconciliation, timeout,
  rate-limited, cancel requested, cancelled, completion-wins race
- SSE connected, reconnecting, stale, offline, resynchronized, permission
  changed
- Artifact loading, processing, unavailable bytes, deleted/purge pending
- Share active, expiring, expired, exhausted, revoked, public unavailable
- Usage empty, reserved, settled, released, delayed, adjusted
- Admin publish blocked, confirmation, provider incident/disablement
- Generic 401, 403, 404, 500, and offline boundaries

Some are specified only in prose or isolated specimens; implementation must add
them using established components without inventing a new visual language.

## Viewport requirements

Validate:

```text
320px reflow
390px mobile
768px or 834px tablet
1024px compact desktop
1440px desktop
200% text zoom
forced colors
prefers-reduced-motion
```

Current canvases do not provide complete exports for every route and viewport.
Use documented responsive rules and return material ambiguity to design review.

## Non-authoritative fixtures

Do not ship these as production facts:

- `Halide XL` and `Aurora Fast`
- Prices, allowance balances, provider rate limits, and latency figures
- Uptime, incidents, customer usage, and run counts
- Pro-plan availability
- Changelog entries and release claims
- Automatic fallback/routing
- Exact public API/MCP/share route names not finalized in product contracts

Keep test fixtures in an explicit fixture boundary and label design/demo data.

## Missing assets and deliverables

Before public launch:

- Official Google and GitHub OAuth marks
- Real licensed generated-image examples with provenance
- Current PNG exports for new/changed canvases, if screenshot review remains
  part of acceptance
- Plus Jakarta Sans 500 or an approved weight-token correction
- Complete font license files
- Route/state/viewport/checksum manifest extensions if assets change
- Full contracts for registry-specific components listed in `HANDOFF.md`
- `/admin/audit` design or an approved implementation using existing
  table/detail patterns

## Accessibility authority

`ACCESSIBILITY.md` is binding where old component documentation conflicts. In
particular:

- Use semantic tables, not div-grid table imitations.
- Use real labelled controls and checkboxes.
- Meet 44×44 target size.
- Implement focus trap/return for dialogs and sheets.
- Provide live-region semantics without noisy progress announcements.
- Provide equivalent tables for charts.
- Make scrollable diagrams keyboard reachable.
- Run axe, keyboard, VoiceOver, NVDA, 320px, 200%, forced-colors, and
  reduced-motion validation.

## Sign-off interpretation

The owner instructed that v3 be normalized, committed, and used as the current
implementation reference. This approves the design direction and package for
engineering planning. It does not convert explicitly marked fixtures or open
product decisions into production commitments.

The implementation agent must resolve blockers listed in
`docs/implementation-handoff/12-blockers-and-inputs.md` and record any material
visual amendment before shipping.
