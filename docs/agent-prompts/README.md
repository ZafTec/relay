# Relay agent execution order

The design and implementation agents are intentionally separate. Run them in
this order.

## Design history

- `design/v1/` is the initial Ledger handoff.
- `design/v2/` is the expanded storage-first handoff and includes its source
  canvases.
- `design/v3/` is the normalized registry-first implementation reference,
  committed at `1eb7a3d`; its manifest lists unresolved production facts.

See [`../../design/README.md`](../../design/README.md) for version status.

## 1. Design amendments

Any design agent changing v3 must read:

```text
docs/product-and-roadmap.md
docs/brand.md
docs/legal.md
docs/versioning.md
design/README.md
design/v3/IMPLEMENTATION-MANIFEST.md
design/v3/HANDOFF.md
design/v3/ACCESSIBILITY.md
```

It should preserve the raw v3 sources, resolve only explicitly assigned open
items, and record reviewed amendments without replacing historical v1/v2.

[`claude-design.md`](claude-design.md) is the historical prompt that produced
the earlier design direction. Do not run it unchanged; the canonical product
document and v2 design-agent backlog supersede its storage-first product brief.

The owner reviews material amendments and records the approved commit/exception
in the v3 manifest.

## 2. Codex implementation

Prompt:

[`codex-implementation.md`](codex-implementation.md)

Codex must verify an owner-approved `design/v3/` handoff exists on `main` before
frontend implementation. It must stop when the handoff is missing, ambiguous, or
unapproved; it does not reinterpret v1 or v2.

After the design gate, implementation follows the tested milestone order in
[`../product-and-roadmap.md`](../product-and-roadmap.md), using isolated Git
worktrees, logical commits, review, and post-merge validation.
