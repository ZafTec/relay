# Relay agent execution order

The design and implementation agents are intentionally separate. Run them in
this order.

## 1. Claude Design

Prompt:

[`claude-design.md`](claude-design.md)

Claude Design owns only:

```text
design/relay/
```

Expected outcome:

- Original Relay identity directions
- Owner-selected logo system
- Custom SVG assets
- Design tokens
- Responsive landing page
- Sign-in page
- Initial protected dashboard
- Public and superadmin changelog screens
- Complete `design/relay/HANDOFF.md`
- A committed `design/relay-identity` branch

The owner reviews the design, requests revisions if necessary, approves it, and
merges the design branch into `main`.

Do not run Codex before this is complete.

## 2. Codex implementation

Prompt:

[`codex-implementation.md`](codex-implementation.md)

Codex must first verify the approved design handoff exists on `main`. Codex
implements the supplied design; it does not create, reinterpret, or replace it.

Codex then proceeds in this order:

1. Minimal platform bootstrap
2. Landing, Better Auth, and protected `/dashboard`
3. End-to-end landing and auth tests
4. Changelog, OpenTelemetry, audit logs, and CI/CD
5. Operational integration tests
6. Storage and immutable asset versions
7. Durable jobs and Deno workers
8. MCP OAuth resource server and tools
9. Image generation
10. Entitlements, usage, and production hardening

Every implementation component uses an isolated Git worktree, targeted tests,
logical commits, review, merge, and a full post-merge validation gate.
