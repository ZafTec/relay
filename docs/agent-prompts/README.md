# Relay agent execution order

The design and implementation agents are intentionally separate. Run them in
this order.

## Design history

- `design/v1/` is the initial Ledger handoff.
- `design/v2/` is the expanded storage-first handoff and includes its source
  canvases.
- Neither version is approved for implementing the current registry-first
  product.

See [`../../design/README.md`](../../design/README.md) for version status.

## 1. Design revision

The next design agent must read:

```text
docs/product-and-roadmap.md
docs/brand.md
docs/legal.md
docs/versioning.md
design/README.md
design/v2/DESIGN-AGENT-SUGGESTIONS.md
```

It should preserve useful Ledger foundations, resolve the backlog, and write the
next reviewable handoff under:

```text
design/v3/
```

[`claude-design.md`](claude-design.md) is the historical prompt that produced
the earlier design direction. Do not run it unchanged; the canonical product
document and v2 design-agent backlog supersede its storage-first product brief.

The owner reviews the new handoff, requests revisions, approves an exact commit,
and merges it into `main`.

## 2. Codex implementation

Prompt:

[`codex-implementation.md`](codex-implementation.md)

Codex must verify an owner-approved `design/v3/` handoff exists on `main` before
frontend implementation. It must stop when the handoff is missing, ambiguous, or
unapproved; it does not reinterpret v1 or v2.

After the design gate, implementation follows the tested milestone order in
[`../product-and-roadmap.md`](../product-and-roadmap.md), using isolated Git
worktrees, logical commits, review, and post-merge validation.
