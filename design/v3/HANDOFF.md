# Relay — design handoff (v0.2.0, registry pivot)

Repository snapshot: `design/v3/`\
Snapshot commit: `1eb7a3d`

Supersedes the storage-first design direction while retaining the Ledger
identity. This pass changes information architecture, screens, and copy—not the
mark, palette, or type system. The owner instructed that this package be
preserved as the third versioned Relay design handoff.

No production code is authorized by this deliverable. It is a design pass only —
see §7 for what is intentionally unresolved and needs an engineering or product
decision before implementation starts.

## 1. What changed and why

Relay is now positioned as **a curated tool and artifact registry for AI
agents** — not object storage with jobs bolted on. Tools execute asynchronously,
every output persists as a durable, versioned artifact, every run is metered
(estimate → reserve → settle/release), and delivery is always through a
Relay-managed URL or share link, never a raw provider or store URL. The initial
catalog is two image-generation tools across two fixture provider models:
**Halide XL** (higher fidelity, per-output, ~18s) and **Aurora Fast** (draft
speed, per-megapixel, ~4s, supports a reference image). These names are
illustrative fixtures for this design pass, not confirmed vendor commitments —
flag before engineering treats them as real integrations.

What did **not** change: the Ledger mark, the onyx/paper surface split, Plus
Jakarta Sans + JetBrains Mono, sharp corners, the one-accent system, the
glyph+label status convention, and the seven-state control model. `DESIGN.md`,
`tokens.json`, and `ASSET-LICENSES.md` from the prior pass still apply as
written — only the IA, screens, and copy below are new. `content-guidelines.md`
and `component-inventory.md` describe the storage-first product in places; treat
any passage that names files/jobs/versions-as-storage as superseded by the terms
table in §2, and the newer component descriptions in §5.

## 2. Canonical terms

Use exactly these terms in navigation, copy, and component names.

| Term                                                   | Meaning                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Tool                                                   | A curated capability an agent can discover and invoke                                |
| Tool version                                           | Its immutable input/output, handler, execution, meter contract                       |
| Provider                                               | The external/internal engine executing the tool                                      |
| Provider model                                         | The selected model and its capability/pricing snapshot                               |
| Run                                                    | One durable, asynchronous invocation — the primary noun in product copy              |
| Job                                                    | The queue execution behind a run — used in operational/admin detail                  |
| Attempt                                                | One provider submission/retrieval/recovery segment within a job                      |
| Artifact                                               | A durable output (or input) owned by a workspace                                     |
| Artifact version                                       | One immutable representation of an artifact                                          |
| Output set                                             | The named collection of outputs a run produces                                       |
| Managed URL                                            | A Relay-controlled delivery mechanism — never a raw provider/store URL               |
| Share link                                             | A revocable Relay resource with its own expiry/policy, distinct from an S3 signature |
| Estimate / Reservation / Usage receipt / Provider cost | Four distinct metering figures, never collapsed into one "usage" number              |
| Workspace                                              | Tenant and authorization boundary; roles `owner`, `admin`, `member`                  |
| Superadmin                                             | Platform-scoped permission, separate from any workspace role                         |

## 3. File map

```text
Relay Identity Directions.dc.html   Phase 1 mark exploration — historical record, mark unchanged by this pivot
Relay Landing.dc.html               / — registry positioning, catalog preview, golden path, retry/meter proof
Relay Tools.dc.html                 /dashboard/tools[...] — catalog, tool contract, composer, all states
Relay Runs.dc.html                  /dashboard/runs[...] — run list, run/attempt detail, SSE states, cancel_requested
Relay Artifacts.dc.html             /dashboard/artifacts[...] — gallery, detail, share-link mgmt, public recipient page
Relay Usage Settings Profile.dc.html /dashboard/usage, /dashboard/settings[...], /profile — estimate/reserve/settle, MCP clients, members, danger zone
Relay Admin.dc.html                 /admin/tools[...], /admin/providers — registry lifecycle, provider health/routing, MCP onboarding
Relay Changelog Screens.dc.html     /changelog[...], /admin/changelog[...] — carried over from v0.1.0, roles/casing not yet re-audited (§7)
Relay App Screens.dc.html           /sign-in[...] + dashboard shell spec — nav updated to Overview/Tools/Runs/Artifacts/Usage/Settings
Relay Docs and Status.dc.html       /docs[...], /status — quickstart rewritten tool-first, status adds provider availability
design/v3/DESIGN.md              design system — surfaces, colour, type, grid, states, motion (unchanged, still authoritative)
design/v3/tokens.json            machine-readable tokens (unchanged)
design/v3/ACCESSIBILITY.md       accessibility contract for this pivot + what still needs real tooling to verify
design/v3/content-guidelines.md  voice/casing/claims (storage-era examples superseded by §2 above)
design/v3/component-inventory.md prior component list (storage-era; §5 below adds/supersedes registry components)
design/v3/ASSET-LICENSES.md      provenance — unchanged, plus new diagram/icon assets listed in §6
design/v3/HANDOFF.md             this file
design/v3/brand/                 Ledger mark family (unchanged) + new tool-category icons (icon-tool-generate, icon-tool-edit, icon-run, icon-artifact, icon-share-link)
design/v3/assets/                new: hero-agent-to-artifact.svg, meter-path.svg, retry-decision.svg, artifact-provenance.svg (old storage-flow diagrams deleted)
design/v3/screens/               PNG exports — storage-era exports for Files/Jobs/old-Landing deleted; re-export the new DCs before external review (§7)
image-slot.js                       starter component backing every artifact preview/placeholder — drop real generated-output samples into the `<image-slot>` ids named in Relay Tools.dc.html and Relay Artifacts.dc.html
```

## 4. Golden path (what must work end to end)

Browse tool → inspect contract/meter → configure inputs → review
estimate/reservation → run → observe live state/attempts → inspect output
artifact(s) → create/copy a managed share link. Designed for: an authenticated
person in the dashboard, an MCP client reading the tool schema, a first run in
an empty workspace, a returning user with many runs/artifacts, and
desktop/tablet/mobile. `Relay Tools.dc.html` (browse, contract, composer) →
`Relay Runs.dc.html` (observe) → `Relay Artifacts.dc.html` (inspect, share) is
the exact screen sequence.

## 5. Components added or corrected this pass

New, beyond the v0.1.0 inventory (full prop/state/a11y writeups belong in
`component-inventory.md` — add them there before implementation; this list is
the pointer to where each lives):

`ToolCard`/`ToolRow`, `ToolLifecycleBadge` (draft/internal/published/
deprecated/disabled/retired), `ToolVersionBadge`, `ProviderModelSelector` +
provider comparison table, `SchemaDrivenForm` composer (prompt/negative
prompt/aspect ratio/output count/seed/reference-artifact/provider-model +
advanced `<details>`), `MeterEstimate` + `UsageReservationSummary` (estimate/
reservation/balance block in the composer and run detail), `RunReceipt`/
`RunStateTimeline`/`AttemptLedger` (provider op id, submission-certainty
language), `RetryDecision` treatment (disabled "Retry — not offered" vs. live
retry countdown), `SseConnectionStatus` (connected/reconnecting/stale/
offline/resynchronized/permission-changed), `OutputSetGrid`, `ArtifactCard`/
`ArtifactGallery`/`ArtifactPreview` (built on `<image-slot>`),
`ArtifactVersionHistory`, `ManagedUrlPanel`, `ShareLinkPolicyForm`/
`ShareLinkRow` (active/expiring/expired/exhausted/revoked)/`PublicShareView`,
`ToolPublishChecks`, `ProviderHealthPanel` (healthy/degraded + incident- disable
preview), `McpConnectionGuide` (scope → config → test, 3-step).

Superseded from the prior inventory: `DataTable` is now a real `<table>`
(§`ACCESSIBILITY.md` §1) rather than a styled `display: grid`; carry that
correction into every table-shaped screen, old and new. `RowDetailDrawer`
pattern is unchanged and now backs both the Runs and Artifacts drawers.

## 6. New assets

`assets/hero-agent-to-artifact.svg` (agent → registry → async run → output set →
artifacts → managed URL), `assets/meter-path.svg` (estimate → reserve → provider
use → settle/release), `assets/retry-decision.svg` (submission- certainty
branches), `assets/artifact-provenance.svg` (inputs → tool version →
provider/model → run → attempt → output set → artifact version).
`brand/icon-tool-generate.svg`, `icon-tool-edit.svg`, `icon-run.svg`,
`icon-artifact.svg`, `icon-share-link.svg` — all drawn from the existing
32-unit/3-stroke icon geometry, no new visual language introduced.

**Generated-output fixtures are placeholders, not delivered assets.** Every
artifact thumbnail/preview in `Relay Tools.dc.html` and
`Relay Artifacts.dc.html` is an `<image-slot>` with a placeholder caption — this
design cannot generate real Halide XL / Aurora Fast sample images. Drop real,
licensed outputs into those named slots (`ex1`, `ex2`, `a1`, `a2`, `a5`,
`detail-preview`, `pub`, `m1`, etc.) before this ships publicly; one slot in the
tool-detail example grid is deliberately left as a dashed "needs real output"
placeholder rather than a fabricated image.

## 7. Open items — flag before implementation

1. **Provider/model identity.** "Halide XL" and "Aurora Fast" are fixtures I
   generated for this pass (the user explicitly deferred this choice to design
   judgment). Confirm real provider names, actual meter units/prices, and actual
   latency figures with engineering before any of this ships as fact.
2. **No repository or live product access in this environment**, same constraint
   as the prior handoff. Re-verify the exact `/api/v1` route list, legal footer,
   and any billing/entitlement vocabulary against the real backend before
   merging.
3. **Not re-audited this pass:** `Relay Changelog Screens.dc.html` still uses
   `Owner`/`Engineer` casing and storage-era changelog category examples from
   v0.1.0. Update its role casing to `owner`/`admin`/`member` and, if the first
   real release is a registry-launch entry, align its sample entries with the
   `0.1.0` release referenced on the new landing page.
4. **P1 depth is uneven by design, not by oversight.** `Relay Admin.dc.html`
   covers tool registry, provider/model admin, and MCP onboarding at one
   fidelity pass each (list + one detail state + confirmations) rather than the
   full state matrix given to Tools/Runs/Artifacts. Extend it screen-by- screen
   if implementation needs more admin states before building against it.
5. **Screens PNGs are stale for every new/changed DC** (Landing, Tools, Runs,
   Artifacts, Usage/Settings/Profile, Admin, and the edited App Screens/Docs and
   Status). Re-export before circulating outside this tool — the `.dc.html`
   files are the source of truth in the meantime.
6. **Accessibility is a contract, not a completed audit** — see
   `ACCESSIBILITY.md §7` for the automated-scan, keyboard, screen-reader,
   320px/200%-zoom, high-contrast, and reduced-motion passes still needed from
   engineering/QA before the acceptance checklist can be checked off.
7. **Repository inclusion is owner-authorized.** The package is preserved under
   `design/v3/` with its ten `.dc.html` canvases and supporting runtime. See
   `IMPLEMENTATION-MANIFEST.md` for repository status and source precedence.
8. **Implementation sign-off remains conditional.** The owner authorized
   versioning and committing this handoff as the current implementation
   reference, but fixture providers/prices, stale exports, route names, and
   other open items above are not silently approved as production facts.
