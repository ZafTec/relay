import { type DatabasePool, withTransaction } from "@relay/database";
import { recordAuditEvent } from "@relay/audit";
import type pg from "pg";
import { parseImageSource } from "./image-source.ts";
import {
  suggestWorkspaceDetails,
  type WorkspaceDetails,
} from "./workspaces.ts";

export interface ManagedWorkspace extends WorkspaceDetails {
  readonly id: string;
  readonly role: string;
  readonly personal: boolean;
  readonly logo?: string | null;
}

export interface WorkspaceUpdate extends WorkspaceDetails {
  readonly logo?: string | null;
}

export function parseWorkspaceUpdate(value: unknown): WorkspaceUpdate {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceManagementError("invalid_input");
  }
  const { logo, ...details } = value as Record<string, unknown>;
  const parsed = parseWorkspaceDetails(details);
  try {
    return logo === undefined
      ? parsed
      : { ...parsed, logo: parseImageSource(logo) };
  } catch {
    throw new WorkspaceManagementError("invalid_input");
  }
}

export class WorkspaceManagementError extends Error {
  override readonly name = "WorkspaceManagementError";
  constructor(
    readonly reason:
      | "unauthenticated"
      | "invalid_input"
      | "not_found"
      | "owner_required"
      | "handle_immutable"
      | "personal_workspace"
      | "workspace_busy"
      | "confirmation_required"
      | "slug_taken"
      | "idempotency_conflict"
      | "workspace_limit",
  ) {
    super(reason);
  }
}

export const MAX_OWNED_WORKSPACES = 20;

export function parseWorkspaceDetails(value: unknown): WorkspaceDetails {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.keys(value).length !== 2 || !("name" in value) ||
    !("slug" in value) || typeof value.name !== "string" ||
    typeof value.slug !== "string"
  ) throw new WorkspaceManagementError("invalid_input");
  const name = value.name.trim();
  const slug = value.slug.trim().toLowerCase();
  // Control and bidi characters cannot be part of a visible workspace label.
  // deno-lint-ignore no-control-regex
  const unsafeLabel = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
  if (
    name.length < 2 || name.length > 80 ||
    unsafeLabel.test(name) ||
    slug.length < 3 || slug.length > 64 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
  ) throw new WorkspaceManagementError("invalid_input");
  return { name, slug };
}

export async function withWorkspaceSession<T>(
  pool: DatabasePool,
  sessionId: string,
  action: (client: pg.PoolClient, userId: string) => Promise<T>,
): Promise<T> {
  return await withTransaction(pool, async (client) => {
    // Hold the current session and verified identity through the mutation.
    // Client-supplied workspace IDs never substitute for membership checks.
    const session = await client.query<{ userId: string }>(
      `select s."userId" from auth.session s join auth."user" u on u.id=s."userId"
       where s.id=$1 and s."expiresAt">now() and u."emailVerified"=true
       for share of s,u`,
      [sessionId],
    );
    if (!session.rows[0]) {
      throw new WorkspaceManagementError("unauthenticated");
    }
    return await action(client, session.rows[0].userId);
  });
}

const WORKSPACE_FIELDS = `o.id,o.name,o.slug,o.logo,m.role,
  exists(select 1 from relay.personal_workspaces p where p.organization_id=o.id) as personal`;

export function listManagedWorkspaces(
  pool: DatabasePool,
  sessionId: string,
): Promise<ManagedWorkspace[]> {
  return withWorkspaceSession(pool, sessionId, async (client, userId) => {
    const result = await client.query<ManagedWorkspace>(
      `select ${WORKSPACE_FIELDS} from auth.organization o
       join auth.member m on m."organizationId"=o.id and m."userId"=$1
       order by lower(o.name),o.slug,o.id`,
      [userId],
    );
    return result.rows;
  });
}

export function proposeWorkspaceDetails(
  pool: DatabasePool,
  sessionId: string,
): Promise<WorkspaceDetails> {
  return withWorkspaceSession(pool, sessionId, async (client) => {
    for (let attempt = 0; attempt < 16; attempt++) {
      const proposed = suggestWorkspaceDetails();
      const found = await client.query(
        "select id from auth.organization where slug=$1",
        [proposed.slug],
      );
      if (found.rows.length === 0) return proposed;
    }
    throw new Error("A workspace suggestion could not be prepared");
  });
}

async function creationId(userId: string, key: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key)) {
    throw new WorkspaceManagementError("invalid_input");
  }
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify(["workspace.create", userId, key]),
      ),
    ),
  ).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

export function createManagedWorkspace(
  pool: DatabasePool,
  sessionId: string,
  input: WorkspaceDetails,
  idempotencyKey: string,
): Promise<{ workspace: ManagedWorkspace; replayed: boolean }> {
  const details = parseWorkspaceDetails(input);
  return withWorkspaceSession(pool, sessionId, async (client, userId) => {
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended('relay.workspace:create:' || $1,0))",
      [userId],
    );
    const id = await creationId(userId, idempotencyKey);
    const previous = await client.query<ManagedWorkspace>(
      `select ${WORKSPACE_FIELDS} from auth.organization o
       join auth.member m on m."organizationId"=o.id and m."userId"=$2
       where o.id=$1`,
      [id, userId],
    );
    if (previous.rows[0]) {
      const workspace = previous.rows[0];
      if (
        workspace.role !== "owner" || workspace.name !== details.name ||
        workspace.slug !== details.slug
      ) throw new WorkspaceManagementError("idempotency_conflict");
      return { workspace, replayed: true };
    }
    const existing = await client.query(
      "select id from auth.organization where id=$1",
      [id],
    );
    if (existing.rows.length) {
      throw new WorkspaceManagementError("idempotency_conflict");
    }
    const count = await client.query<{ count: number }>(
      `select count(*)::integer as count from auth.member where "userId"=$1 and role='owner'`,
      [userId],
    );
    if (count.rows[0].count >= MAX_OWNED_WORKSPACES) {
      throw new WorkspaceManagementError("workspace_limit");
    }
    const result = await client.query(
      `insert into auth.organization(id,name,slug,"createdAt",metadata)
       values($1,$2,$3,now(),null) on conflict(slug) do nothing returning id`,
      [id, details.name, details.slug],
    );
    if (!result.rows[0]) throw new WorkspaceManagementError("slug_taken");
    await client.query(
      `insert into auth.member(id,"organizationId","userId",role,"createdAt")
       values(gen_random_uuid()::text,$1,$2,'owner',now())`,
      [id, userId],
    );
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId: userId,
      workspaceId: id,
      action: "workspace.create",
      targetType: "workspace",
      targetId: id,
      outcome: "success",
    });
    // Creation grants ownership only. Execution and usage still require the
    // existing explicit superadmin allowance flow.
    return {
      workspace: { id, ...details, role: "owner", personal: false },
      replayed: false,
    };
  });
}

export function updateManagedWorkspace(
  pool: DatabasePool,
  sessionId: string,
  workspaceId: string,
  input: WorkspaceUpdate,
): Promise<ManagedWorkspace> {
  const details = parseWorkspaceUpdate(input);
  return withWorkspaceSession(pool, sessionId, async (client, userId) => {
    const result = await client.query<ManagedWorkspace>(
      `select ${WORKSPACE_FIELDS} from auth.organization o
       join auth.member m on m."organizationId"=o.id and m."userId"=$2
       where o.id=$1 for update of o for share of m`,
      [workspaceId, userId],
    );
    const workspace = result.rows[0];
    if (!workspace) throw new WorkspaceManagementError("not_found");
    if (workspace.role !== "owner") {
      throw new WorkspaceManagementError("owner_required");
    }
    if (workspace.slug !== details.slug) {
      throw new WorkspaceManagementError("handle_immutable");
    }
    const logo = details.logo === undefined
      ? workspace.logo ?? null
      : details.logo;
    if (workspace.name === details.name && (workspace.logo ?? null) === logo) {
      return workspace;
    }
    try {
      await client.query(
        "update auth.organization set name=$2,logo=$3 where id=$1",
        [workspaceId, details.name, logo],
      );
    } catch (error) {
      if (
        typeof error === "object" && error !== null && "code" in error &&
        error.code === "23505"
      ) throw new WorkspaceManagementError("slug_taken");
      throw error;
    }
    await recordAuditEvent(client, {
      actorType: "user",
      actorUserId: userId,
      workspaceId,
      action: "workspace.update",
      targetType: "workspace",
      targetId: workspaceId,
      outcome: "success",
    });
    return { ...workspace, ...details, logo };
  });
}

export function deleteManagedWorkspace(
  pool: DatabasePool,
  sessionId: string,
  workspaceId: string,
  confirmation: string,
): Promise<void> {
  return withWorkspaceSession(pool, sessionId, async (db, userId) => {
    const { rows } = await db.query<
      {
        slug: string;
        personal: boolean;
        deletedAt: Date | null;
        role: string | null;
      }
    >(
      `select o.slug,o."deletedAt",m.role, exists(select 1 from relay.personal_workspaces p where p.organization_id=o.id) as personal
       from auth.organization o left join auth.member m on m."organizationId"=o.id and m."userId"=$2
       where o.id=$1 and (m.id is not null or o."deletedBy"=$2) for update of o`,
      [workspaceId, userId],
    );
    const org = rows[0];
    if (!org) throw new WorkspaceManagementError("not_found");
    if (confirmation !== org.slug) {
      throw new WorkspaceManagementError("confirmation_required");
    }
    if (org.deletedAt) return;
    if (org.role !== "owner") {
      throw new WorkspaceManagementError("owner_required");
    }
    if (org.personal) throw new WorkspaceManagementError("personal_workspace");
    const busy = await db.query(
      `select 1 from relay.tool_runs where workspace_id=$1 and status in ('queued','running','cancel_requested')
      union all select 1 from relay.artifact_uploads where workspace_id=$1 and status='pending' limit 1`,
      [workspaceId],
    );
    if (busy.rows.length) throw new WorkspaceManagementError("workspace_busy");
    await db.query(
      'update auth.organization set "deletedAt"=now(),"deletedBy"=$2,logo=null where id=$1',
      [workspaceId, userId],
    );
    await db.query(
      `update relay.artifacts set deleted_at=now(),purge_after=now(),purge_status='pending',purge_last_error=null where workspace_id=$1 and deleted_at is null`,
      [workspaceId],
    );
    await db.query(
      "update relay.share_links set revoked_at=coalesce(revoked_at,now()) where workspace_id=$1",
      [workspaceId],
    );
    await db.query(
      'update auth."oauthAccessToken" set revoked=coalesce(revoked,now()) where "referenceId"=$1',
      [workspaceId],
    );
    await db.query(
      'update auth."oauthRefreshToken" set revoked=coalesce(revoked,now()) where "referenceId"=$1',
      [workspaceId],
    );
    await db.query('delete from auth."oauthConsent" where "referenceId"=$1', [
      workspaceId,
    ]);
    await db.query('delete from auth.invitation where "organizationId"=$1', [
      workspaceId,
    ]);
    await db.query('delete from auth.member where "organizationId"=$1', [
      workspaceId,
    ]);
    await db.query(
      `update auth.session s set "activeOrganizationId"=(select p.organization_id from relay.personal_workspaces p where p.user_id=s."userId"),"updatedAt"=now() where s."activeOrganizationId"=$1`,
      [workspaceId],
    );
    await recordAuditEvent(db, {
      actorType: "user",
      actorUserId: userId,
      workspaceId,
      action: "workspace.delete",
      targetType: "workspace",
      targetId: workspaceId,
      outcome: "success",
    });
  });
}
