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

Read [`v2/DESIGN-AGENT-SUGGESTIONS.md`](v2/DESIGN-AGENT-SUGGESTIONS.md) for the
required registry-first revision.

## Current implementation gate

Neither v1 nor v2 is approved for implementing the clarified Relay product.
Frontend implementation remains blocked until the owner approves a new handoff
that covers the tool registry, image-generation run flow, metering, artifacts,
and managed share URLs.

The next revision should be created under `design/v3/` so v1 and v2 remain
reviewable historical snapshots. After owner approval, active implementation
instructions must reference that exact version and commit.

Do not silently overwrite an earlier version or treat the numerically newest
folder as approved. Approval is explicit and recorded by commit hash.
