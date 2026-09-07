import { withTransaction } from "@relay/database";
import type { DatabasePool } from "@relay/database";

const PERSONAL_WORKSPACE_LOCK_NAMESPACE = 0x524c5957;
const ADJECTIVES = [
  "amber",
  "bright",
  "calm",
  "clear",
  "coral",
  "crisp",
  "dawn",
  "deep",
  "gentle",
  "golden",
  "green",
  "hidden",
  "indigo",
  "kind",
  "little",
  "lively",
  "lunar",
  "mellow",
  "misty",
  "noble",
  "open",
  "quiet",
  "rapid",
  "silver",
  "soft",
  "solar",
  "still",
  "sunny",
  "tidal",
  "vivid",
  "warm",
  "wild",
] as const;
const NOUNS = [
  "atlas",
  "bay",
  "birch",
  "bloom",
  "brook",
  "cedar",
  "cove",
  "dune",
  "elm",
  "fern",
  "field",
  "forest",
  "garden",
  "grove",
  "harbor",
  "hill",
  "island",
  "lake",
  "maple",
  "meadow",
  "moon",
  "oak",
  "ocean",
  "orchard",
  "pine",
  "pond",
  "reef",
  "river",
  "shore",
  "sky",
  "stone",
  "willow",
] as const;

export interface WorkspaceDetails {
  readonly name: string;
  readonly slug: string;
}

function suggestedDetails(bytes: Uint8Array): WorkspaceDetails {
  const adjective = ADJECTIVES[bytes[0] % ADJECTIVES.length];
  const noun = NOUNS[bytes[1] % NOUNS.length];
  const suffix = 1000 + ((bytes[2] * 256 + bytes[3]) % 9000);
  return {
    name: `${adjective[0].toUpperCase()}${adjective.slice(1)} ${
      noun[0].toUpperCase()
    }${noun.slice(1)}`,
    slug: `${adjective}-${noun}-${suffix}`,
  };
}

/** Display identifiers contain no email, profile name, or authentication data. */
export function suggestWorkspaceDetails(): WorkspaceDetails {
  return suggestedDetails(crypto.getRandomValues(new Uint8Array(4)));
}

/**
 * Stable first suggestion, independent of mutable profile data. The database
 * reserves the slug; another suggestion is used on collision. Authorization
 * always uses the immutable workspace ID, never this human-readable label.
 */
export async function personalWorkspaceSlug(
  userId: string,
  attempt = 0,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `relay-personal-workspace:${userId}${attempt === 0 ? "" : `:${attempt}`}`,
    ),
  );
  return suggestedDetails(new Uint8Array(digest)).slug;
}

/**
 * Creates or repairs a user's personal workspace as one PostgreSQL transaction.
 * The transaction-scoped advisory lock serializes every provisioning attempt
 * for the same user before any state is inspected, so no losing caller can
 * create an orphan organization. Existing mappings are healed by inserting a
 * missing membership or restoring a downgraded membership to `owner`.
 * Execution capabilities and usage allowances require explicit grants.
 */
export async function ensurePersonalWorkspace(
  pool: DatabasePool,
  userId: string,
): Promise<string> {
  return await withTransaction(pool, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, $2::bigint))",
      [userId, PERSONAL_WORKSPACE_LOCK_NAMESPACE],
    );

    const existing = await client.query<{ organization_id: string }>(
      "select organization_id from relay.personal_workspaces where user_id = $1",
      [userId],
    );

    if (existing.rows[0]) {
      const organizationId = existing.rows[0].organization_id;
      await ensureOwnerMembership(client, organizationId, userId);
      return organizationId;
    }

    const organizationId = crypto.randomUUID();
    let created = false;
    for (let attempt = 0; attempt < 16; attempt++) {
      const slug = await personalWorkspaceSlug(userId, attempt);
      const name = slug.split("-").slice(0, 2).map((word) =>
        word[0].toUpperCase() + word.slice(1)
      ).join(" ");
      const result = await client.query(
        `insert into auth.organization (id, name, slug, "createdAt", metadata)
         values ($1, $2, $3, now(), null) on conflict (slug) do nothing returning id`,
        [organizationId, name, slug],
      );
      if (result.rows.length > 0) {
        created = true;
        break;
      }
    }
    if (!created) throw new Error("A workspace slug could not be reserved");
    await ensureOwnerMembership(client, organizationId, userId);
    await client.query(
      `insert into relay.personal_workspaces (user_id, organization_id)
       values ($1, $2)`,
      [userId, organizationId],
    );

    return organizationId;
  });
}

interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

async function ensureOwnerMembership(
  queryable: Queryable,
  organizationId: string,
  userId: string,
): Promise<void> {
  await queryable.query(
    `insert into auth.member as existing
       (id, "organizationId", "userId", role, "createdAt")
     values (gen_random_uuid()::text, $1, $2, 'owner', now())
     on conflict ("organizationId", "userId") do update
       set role = excluded.role
       where existing.role is distinct from excluded.role`,
    [organizationId, userId],
  );
}
