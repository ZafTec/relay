import type { DatabasePool } from "@relay/database";

/**
 * Minimal shape `ensurePersonalWorkspace` needs from a Better Auth adapter
 * (see docs/implementation-handoff/03-auth-workspaces.md "Personal workspace
 * provisioning"). Calling `auth.api.createOrganization` from inside a
 * session-create hook was spiked and rejected with 401 even with a `userId`
 * body and no session headers -- Better Auth's public `api.*` surface
 * enforces real request auth regardless. Using the adapter directly (the
 * same thing Better Auth's own route handlers call internally) sidesteps
 * that auth layer entirely, which is also why it carries no recursion risk
 * back into the session-create pipeline; this was proven live against
 * PostgreSQL 18, not assumed.
 */
export interface BetterAuthAdapter {
  create<T>(args: { model: string; data: Record<string, unknown> }): Promise<
    T
  >;
}

function personalWorkspaceSlug(userId: string): string {
  const suffix = crypto.getRandomValues(new Uint8Array(8))
    .reduce((hex, byte) => hex + byte.toString(16).padStart(2, "0"), "");
  // Opaque and recoverable from the user id without embedding anything
  // sensitive (never the user's email) -- and hex, not a UUID, per the
  // public-ID convention the rest of Relay's public identifiers use.
  return `personal-${userId.slice(0, 12)}-${suffix}`;
}

/**
 * Idempotent even under concurrent callers for the same user: the unique
 * `user_id` primary key on `relay.personal_workspaces` is the actual
 * concurrency-safety mechanism (`insert ... on conflict (user_id) do
 * nothing`), not application-level locking. Exactly one concurrent caller
 * observes zero rows returned from the insert and therefore creates the
 * Better Auth organization/member; every other caller (this one or a
 * different session hook invocation racing it) sees the row already there
 * and reuses its `organization_id`.
 */
export async function ensurePersonalWorkspace(
  adapter: BetterAuthAdapter,
  pool: DatabasePool,
  userId: string,
): Promise<string> {
  const existing = await pool.query<{ organization_id: string }>(
    "select organization_id from relay.personal_workspaces where user_id = $1",
    [userId],
  );
  if (existing.rows[0]) {
    return existing.rows[0].organization_id;
  }

  const organization = await adapter.create<{ id: string }>({
    model: "organization",
    data: {
      name: "Personal",
      slug: personalWorkspaceSlug(userId),
      createdAt: new Date(),
      metadata: null,
    },
  });

  const claimed = await pool.query<{ organization_id: string }>(
    `insert into relay.personal_workspaces (user_id, organization_id)
     values ($1, $2)
     on conflict (user_id) do nothing
     returning organization_id`,
    [userId, organization.id],
  );

  if (claimed.rows[0]) {
    await adapter.create({
      model: "member",
      data: {
        organizationId: organization.id,
        userId,
        role: "owner",
        createdAt: new Date(),
      },
    });
    return organization.id;
  }

  // Lost the race: another concurrent call already claimed the mapping.
  // The organization we just created is an orphan (no member row will ever
  // reference it) -- acceptable for an MVP with no organization-deletion UI;
  // revisit if orphaned-organization cleanup becomes worth the complexity.
  const winner = await pool.query<{ organization_id: string }>(
    "select organization_id from relay.personal_workspaces where user_id = $1",
    [userId],
  );
  if (!winner.rows[0]) {
    throw new Error(
      `personal workspace mapping missing for user ${userId} immediately after a lost insert race`,
    );
  }
  return winner.rows[0].organization_id;
}
