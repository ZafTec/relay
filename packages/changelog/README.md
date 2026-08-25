# `@relay/changelog`

Transport-neutral changelog and legal-governance services for Relay.

- Public reads call database functions that can return only currently published
  revisions; runtime callers have no `SELECT` privilege on draft/history tables.
- Admin reads and every governance mutation accept a Better Auth session ID.
  PostgreSQL derives the actor and applies the existing fresh-superadmin
  boundary.
- Mutations require an idempotency key. Only hashes/fingerprints are stored, and
  a key reused with another payload raises `GovernanceIdempotencyConflictError`.
- Changelog edits append immutable snapshots. Publishing a newer snapshot
  records a supersession; unpublishing archives public visibility without
  erasing history.
- Legal records contain operator-provided safe HTTPS URL/version/hash metadata,
  never copied policy text. Future-effective publications remain scheduled while
  the latest effective document stays public. User acceptance is per-user;
  workspace acceptance is organization-wide and requires a current owner/admin.

The package deliberately contains no HTTP, Hono, MCP, or UI code. Integration
owners can map its discriminated unions to any transport without duplicating the
security or lifecycle decisions.
