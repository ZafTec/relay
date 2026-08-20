# Relay design versions

Relay design handoffs are preserved as versioned snapshots. Product and
architecture authority lives in
[`../docs/product-and-roadmap.md`](../docs/product-and-roadmap.md), not in a
historical design package.

## Versions

### `v1`

The initial owner-selected Ledger handoff, originally committed in `ac66e6f`. It
contains the identity, tokens, custom SVGs, and 12 screen exports for the
landing page, sign-in, dashboard shell, and changelog.

Its referenced `.dc.html` source canvases were not included in the original
tracked package. It represents the earlier storage-first product direction.

### `v2`

The expanded Ledger handoff with 26 screen exports plus seven `.dc.html` source
canvases, their design-system runtime, local font files, and the original input
prompt under `uploads/`.

The handoff adds docs, status, files, jobs, usage, settings, and profile, but it
still represents the earlier storage-first direction. It is a component and
state reference, not an approved implementation target for the current product.

### `v3`

The registry-first Ledger handoff, committed in `1eb7a3d`. It adds Tools, Runs,
Artifacts, metering, provider administration, managed sharing, accessibility
requirements, and ten raw `.dc.html` source canvases. The package is normalized
at `design/v3/` with its handoff, tokens, assets, brand files, screens, source
runtime, and provenance files at one predictable root.

Read [`v3/IMPLEMENTATION-MANIFEST.md`](v3/IMPLEMENTATION-MANIFEST.md) for source
precedence and implementation status. The owner authorized preserving and
committing v3 as the current implementation reference. Fixture provider names,
prices, route choices, stale screenshots, and other listed open items remain
non-authoritative until resolved.

## Current implementation gate

V1 and v2 remain historical. V3 is the current registry-first reference, but
frontend implementation follows the conditions in its manifest and the
implementation handoff under `docs/implementation-handoff/`.

Do not silently overwrite an earlier version or treat the numerically newest
folder as fully production-approved. Approval and unresolved exceptions are
recorded explicitly.
