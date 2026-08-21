/** Satisfied by both `pg.Pool` and a checked-out `pg.PoolClient`. */
export interface Queryable {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type AuditActorType = "user" | "system" | "oauth_client";
export type AuditOutcome = "success" | "failure" | "denied";

export interface AuditEventInput {
  readonly actorType: AuditActorType;
  readonly actorUserId?: string | null;
  readonly oauthClientId?: string | null;
  readonly workspaceId?: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId?: string | null;
  readonly outcome: AuditOutcome;
  readonly reasonCode?: string | null;
  readonly beforeSnapshot?: unknown;
  readonly afterSnapshot?: unknown;
  readonly requestId?: string | null;
  readonly traceId?: string | null;
  readonly ipHashOrPolicyValue?: string | null;
  readonly userAgentSummary?: string | null;
  /**
   * Set for any action that might retry (e.g. a client re-submitting after
   * a timeout). A retry reusing the same key produces exactly one durable
   * event, not a duplicate -- docs/implementation-handoff/07-observability-audit.md
   * "Durable audit events" and its "Required actions create exactly one
   * durable event" test.
   */
  readonly idempotencyKey?: string | null;
}

const SENSITIVE_KEY_PATTERN =
  /password|secret|token|credential|authorization|cookie|api[-_]?key/i;

/**
 * Defense in depth for "secret fields are absent from snapshots": strips
 * any object key that looks credential-shaped before it ever reaches the
 * audit table, on top of callers being expected not to pass secrets in.
 * Deliberately shallow-recursive and simple -- this is a safety net, not a
 * substitute for callers building clean snapshots.
 */
function redactSnapshot(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined || depth > 5) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactSnapshot(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[redacted]"
        : redactSnapshot(val, depth + 1);
    }
    return result;
  }
  return value;
}

/**
 * Insert-only. Callers doing a fail-closed governed action pass a
 * transaction client (see @relay/database's withTransaction) so the audit
 * row commits or rolls back with the change it records; callers doing a
 * fail-open/best-effort action may pass the plain pool instead.
 */
export async function recordAuditEvent(
  queryable: Queryable,
  event: AuditEventInput,
): Promise<void> {
  await queryable.query(
    `insert into relay.audit_events
       (actor_type, actor_user_id, oauth_client_id, workspace_id, action,
        target_type, target_id, outcome, reason_code, before_snapshot,
        after_snapshot, request_id, trace_id, ip_hash_or_policy_value,
        user_agent_summary, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict (idempotency_key) do nothing`,
    [
      event.actorType,
      event.actorUserId ?? null,
      event.oauthClientId ?? null,
      event.workspaceId ?? null,
      event.action,
      event.targetType,
      event.targetId ?? null,
      event.outcome,
      event.reasonCode ?? null,
      event.beforeSnapshot === undefined
        ? null
        : JSON.stringify(redactSnapshot(event.beforeSnapshot)),
      event.afterSnapshot === undefined
        ? null
        : JSON.stringify(redactSnapshot(event.afterSnapshot)),
      event.requestId ?? null,
      event.traceId ?? null,
      event.ipHashOrPolicyValue ?? null,
      event.userAgentSummary ?? null,
      event.idempotencyKey ?? null,
    ],
  );
}
