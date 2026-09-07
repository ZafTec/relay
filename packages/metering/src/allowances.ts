import type { DatabasePool } from "@relay/database";
import type pg from "pg";
import { sha256Hex } from "./canonical.ts";
import { normalizeDecimalAmount, subtractDecimalAmounts } from "./decimal.ts";
import { resolveCapabilityAt, resolveLimitAt } from "./entitlements.ts";
import { periodWindow } from "./periods.ts";

export const ALLOWANCE_KEYS = [
  "tools.execute",
  "images.generated",
  "ocr.requests",
] as const;
export type AllowanceKey = typeof ALLOWANCE_KEYS[number];
export interface AllowanceWorkspace {
  id: string;
  name: string;
  slug: string;
  owner?: { name: string; email: string } | null;
}
export interface GrantAllowanceInput {
  key: AllowanceKey;
  mode: "enabled" | "finite" | "unlimited";
  amount: string | null;
  /** Null explicitly selects immediate effect / no expiry. */
  effectiveAt: string | null;
  expiresAt: string | null;
  reason: string;
}
export interface RevokeAllowanceInput {
  grantId: string;
  reason: string;
}
export interface AllowanceGrant {
  id: string;
  key: AllowanceKey;
  amount: string | null;
  sourceKind: string;
  effectiveAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  operatorUserId: string | null;
  reason: string | null;
}
export interface AllowanceAuditEvent {
  id: string;
  at: string;
  action: "allowance.grant" | "allowance.revoke";
  grantId: string;
  operatorUserId: string;
  reason: string;
}
export interface AllowancePage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface AllowanceSummary {
  workspace: AllowanceWorkspace;
  asOf: string;
  executionAllowed: boolean;
  periodStartsAt: string;
  periodEndsAt: string;
  limits: {
    key: "images.generated" | "ocr.requests";
    state: "none" | "limited" | "unlimited" | "invalid";
    amount: string | null;
    consumed: string;
    reserved: string;
    remaining: string | null;
  }[];
}
export interface AllowanceMutationResult {
  grantId: string;
  operation: "grant" | "revoke";
  replayed: boolean;
}

export class AllowanceInputError extends Error {}
function invalid(): never {
  throw new AllowanceInputError("Invalid allowance request");
}
export function allowanceText(value: unknown, max = 256): string {
  if (
    typeof value !== "string" || value.trim() === "" || value.length > max ||
    [...value].some((character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  ) invalid();
  return value;
}
function strictObject(
  input: unknown,
  fields: string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    invalid();
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) invalid();
  return value;
}
function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/
      .test(value) ||
    !Number.isFinite(Date.parse(value))
  ) invalid();
  return new Date(value).toISOString();
}
export function parseGrantAllowanceInput(input: unknown): GrantAllowanceInput {
  const value = strictObject(input, [
    "key",
    "mode",
    "amount",
    "effectiveAt",
    "expiresAt",
    "reason",
  ]);
  const key = value.key as AllowanceKey;
  if (!ALLOWANCE_KEYS.includes(key)) invalid();
  if (key === "tools.execute") {
    if (value.mode !== "enabled" || value.amount !== null) invalid();
  } else if (value.mode === "finite") {
    if (
      typeof value.amount !== "string" ||
      !/^(0|[1-9][0-9]{0,28})$/.test(value.amount)
    ) invalid();
  } else if (value.mode !== "unlimited" || value.amount !== null) invalid();
  const effectiveAt = timestamp(value.effectiveAt);
  const expiresAt = timestamp(value.expiresAt);
  if (effectiveAt !== null && expiresAt !== null && expiresAt <= effectiveAt) {
    invalid();
  }
  return {
    key,
    mode: value.mode as GrantAllowanceInput["mode"],
    amount: value.amount as string | null,
    effectiveAt,
    expiresAt,
    reason: allowanceText(value.reason, 1000).trim(),
  };
}
export function parseRevokeAllowanceInput(
  input: unknown,
): RevokeAllowanceInput {
  const value = strictObject(input, ["grantId", "reason"]);
  return {
    grantId: allowanceText(value.grantId),
    reason: allowanceText(value.reason, 1000).trim(),
  };
}

/** Hold role authorization for the entire read, just as mutation functions do. */
async function authorizedRead<T>(
  pool: DatabasePool,
  sessionId: string,
  read: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock_shared(hashtextextended('relay.system-role:mutations', 0))",
    );
    await client.query("select relay.require_fresh_superadmin_session($1)", [
      sessionId,
    ]);
    const result = await read(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
const PAGE_SIZE = 30;
const WORKSPACE_OWNER = `left join lateral (
  select json_build_object('name',u.name,'email',u.email) as owner
  from auth.member m join auth."user" u on u.id=m."userId"
  where m."organizationId"=o.id and m.role='owner'
  order by m."createdAt",m.id limit 1
) owner_record on true`;
function page<T>(rows: T[], cursor: (row: T) => string): AllowancePage<T> {
  return {
    items: rows.slice(0, PAGE_SIZE),
    nextCursor: rows.length > PAGE_SIZE ? cursor(rows[PAGE_SIZE - 1]) : null,
  };
}
export function listAllowanceWorkspaces(
  pool: DatabasePool,
  sessionId: string,
  search = "",
  after: string | null = null,
): Promise<AllowancePage<AllowanceWorkspace>> {
  if (search.length > 128) invalid();
  if (after !== null) allowanceText(after);
  return authorizedRead(pool, sessionId, async (client) => {
    const result = await client.query<AllowanceWorkspace>(
      `select o.id,o.name,o.slug,owner_record.owner from auth.organization o ${WORKSPACE_OWNER}
        where ($1 = '' or strpos(lower(o.name), lower($1)) > 0 or strpos(lower(o.slug), lower($1)) > 0 or o.id = $1
          or exists(select 1 from auth.member m join auth."user" u on u.id=m."userId"
            where m."organizationId"=o.id and m.role='owner'
              and (strpos(lower(u.email),lower($1)) > 0 or strpos(lower(u.name),lower($1)) > 0)))
          and ($2::text is null or o.id > $2) order by o.id limit $3`,
      [search, after, PAGE_SIZE + 1],
    );
    return page(result.rows, (row) => row.id);
  });
}
export function getWorkspaceAllowances(
  pool: DatabasePool,
  sessionId: string,
  workspaceId: string,
): Promise<AllowanceSummary | null> {
  allowanceText(workspaceId);
  return authorizedRead(pool, sessionId, async (client) => {
    await client.query(
      "select pg_advisory_xact_lock_shared(hashtextextended('relay.allowance:workspace:' || $1, 0))",
      [workspaceId],
    );
    const workspace = (await client.query<AllowanceWorkspace>(
      `select o.id,o.name,o.slug,owner_record.owner from auth.organization o ${WORKSPACE_OWNER} where o.id=$1`,
      [workspaceId],
    )).rows[0];
    if (!workspace) return null;
    const at =
      (await client.query<{ now: Date }>("select clock_timestamp() as now"))
        .rows[0].now;
    const window = periodWindow(at, "calendar_month");
    const capability = await resolveCapabilityAt(
      client,
      workspaceId,
      "tools.execute",
      at,
    );
    const limits: AllowanceSummary["limits"] = [];
    for (
      const [key, unit] of [["images.generated", "image"], [
        "ocr.requests",
        "request",
      ]] as const
    ) {
      const resolved = await resolveLimitAt(client, workspaceId, key, at);
      const bucket =
        (await client.query<{ consumed: string; reserved: string }>(
          `select consumed_amount::text as consumed, reserved_amount::text as reserved from relay.usage_buckets
          where workspace_id = $1 and metric_key = $2 and unit = $3 and period = 'calendar_month' and period_start = $4`,
          [workspaceId, key, unit, window.startsAt],
        )).rows[0];
      const consumed = normalizeDecimalAmount(bucket?.consumed ?? "0");
      const reserved = normalizeDecimalAmount(bucket?.reserved ?? "0");
      const limit = resolved.limit;
      const compatible = limit?.unit === unit &&
        limit.period === "calendar_month";
      const state = resolved.kind !== "configured"
        ? resolved.kind
        : !compatible
        ? "invalid"
        : limit!.kind;
      const amount = state === "limited" && limit?.kind === "limited"
        ? limit.amount
        : null;
      const remainder = amount === null ? null : subtractDecimalAmounts(
        subtractDecimalAmounts(amount, consumed, { allowNegative: true }),
        reserved,
        { allowNegative: true },
      );
      limits.push({
        key,
        state,
        amount,
        consumed,
        reserved,
        remaining: remainder?.startsWith("-")
          ? normalizeDecimalAmount("0")
          : remainder,
      });
    }
    return {
      workspace,
      asOf: at.toISOString(),
      executionAllowed: capability.allowed,
      periodStartsAt: window.startsAt.toISOString(),
      periodEndsAt: window.endsAt.toISOString(),
      limits,
    };
  });
}
export function listAllowanceGrants(
  pool: DatabasePool,
  sessionId: string,
  workspaceId: string,
  before: string | null = null,
): Promise<AllowancePage<AllowanceGrant>> {
  allowanceText(workspaceId);
  if (before !== null) allowanceText(before);
  return authorizedRead(pool, sessionId, async (client) => {
    const result = await client.query<AllowanceGrant>(
      `select id, entitlement_key as key, limit_amount::text as amount, source_kind as "sourceKind",
        to_char(effective_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "effectiveAt",
        to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "expiresAt",
        to_char(revoked_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "revokedAt",
        to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
        metadata ->> 'operatorUserId' as "operatorUserId", metadata ->> 'reason' as reason
       from relay.entitlement_grants
       where workspace_id = $1 and entitlement_key = any($2::text[])
         and ($3::text is null or (created_at, id) < (select created_at, id from relay.entitlement_grants where workspace_id = $1 and id = $3))
       order by created_at desc, id desc limit $4`,
      [workspaceId, [...ALLOWANCE_KEYS], before, PAGE_SIZE + 1],
    );
    return page(result.rows, (row) => row.id);
  });
}
export function listAllowanceAudit(
  pool: DatabasePool,
  sessionId: string,
  workspaceId: string,
  before: string | null = null,
): Promise<AllowancePage<AllowanceAuditEvent>> {
  allowanceText(workspaceId);
  if (
    before !== null &&
    (!/^[1-9][0-9]{0,18}$/.test(before) ||
      BigInt(before) > 9223372036854775807n)
  ) invalid();
  return authorizedRead(pool, sessionId, async (client) => {
    const result = await client.query<AllowanceAuditEvent>(
      `select id::text, to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at,
        action, target_id as "grantId", actor_user_id as "operatorUserId", after_snapshot ->> 'reason' as reason
       from relay.audit_events where workspace_id = $1 and action in ('allowance.grant', 'allowance.revoke')
         and ($2::bigint is null or id < $2) order by id desc limit $3`,
      [workspaceId, before, PAGE_SIZE + 1],
    );
    return page(result.rows, (row) => row.id);
  });
}
export async function manageWorkspaceAllowance(
  pool: DatabasePool,
  sessionId: string,
  workspaceId: string,
  operation: "grant" | "revoke",
  input: GrantAllowanceInput | RevokeAllowanceInput,
  idempotencyKey: string,
  requestId: string,
): Promise<AllowanceMutationResult> {
  allowanceText(workspaceId);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(idempotencyKey)) invalid();
  const parsed = operation === "grant"
    ? parseGrantAllowanceInput(input)
    : parseRevokeAllowanceInput(input);
  const result = await pool.query<{ result: AllowanceMutationResult }>(
    "select relay.manage_workspace_allowance($1, $2, $3, $4::jsonb, $5, $6) as result",
    [
      sessionId,
      workspaceId,
      operation,
      JSON.stringify(parsed),
      await sha256Hex(idempotencyKey),
      requestId,
    ],
  );
  return result.rows[0].result;
}
