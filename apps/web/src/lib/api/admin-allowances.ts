import { fetchJson } from "./client";

export type AllowanceKey = "tools.execute" | "images.generated" | "ocr.requests";
export interface AllowanceWorkspace { id: string; name: string; slug: string; owner?: { name: string; email: string } | null }
export interface AllowancePage<T> { items: T[]; nextCursor: string | null }
export interface AllowanceSummary {
  workspace: AllowanceWorkspace;
  asOf: string;
  executionAllowed: boolean;
  periodStartsAt: string;
  periodEndsAt: string;
  limits: { key: "images.generated" | "ocr.requests"; state: "none" | "limited" | "unlimited" | "invalid";
    amount: string | null; consumed: string; reserved: string; remaining: string | null }[];
}
export interface AllowanceGrant {
  id: string; key: AllowanceKey; amount: string | null; sourceKind: string;
  effectiveAt: string; expiresAt: string | null; revokedAt: string | null; createdAt: string;
  operatorUserId: string | null; reason: string | null;
}
export interface AllowanceAuditEvent {
  id: string; at: string; action: "allowance.grant" | "allowance.revoke";
  grantId: string; operatorUserId: string; reason: string;
}
export interface GrantAllowanceInput {
  key: AllowanceKey; mode: "enabled" | "finite" | "unlimited"; amount: string | null;
  effectiveAt: string | null; expiresAt: string | null; reason: string;
}
export interface RevokeAllowanceInput { grantId: string; reason: string }
export interface AllowanceMutationResult { grantId: string; operation: "grant" | "revoke"; replayed: boolean }
export interface AdminAllowanceAdapter {
  workspaces(search?: string, after?: string | null, signal?: AbortSignal): Promise<AllowancePage<AllowanceWorkspace>>;
  summary(workspaceId: string, signal?: AbortSignal): Promise<AllowanceSummary>;
  grants(workspaceId: string, before?: string | null, signal?: AbortSignal): Promise<AllowancePage<AllowanceGrant>>;
  audit(workspaceId: string, before?: string | null, signal?: AbortSignal): Promise<AllowancePage<AllowanceAuditEvent>>;
  mutate(workspaceId: string, operation: "grant" | "revoke", input: GrantAllowanceInput | RevokeAllowanceInput, key: string): Promise<AllowanceMutationResult>;
}

// Validate responses before displaying quota or success. Malformed write
// responses are uncertain outcomes and must be retried with the same key.
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid allowance response");
  return value as RecordValue;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Invalid allowance text");
  return value;
}
function nullable(value: unknown): string | null { return value === null ? null : string(value); }
function timestamp(value: unknown): string {
  const result = string(value);
  if (!Number.isFinite(Date.parse(result))) throw new TypeError("Invalid allowance timestamp");
  return result;
}
function dateOrNull(value: unknown): string | null { return value === null ? null : timestamp(value); }
function amount(value: unknown): string {
  const result = string(value);
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(result)) throw new TypeError("Invalid allowance amount");
  return result;
}
function amountOrNull(value: unknown): string | null { return value === null ? null : amount(value); }
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new TypeError("Invalid allowance value");
  return value as T;
}
function workspace(value: unknown): AllowanceWorkspace {
  const v = object(value);
  const owner = v.owner === undefined ? undefined : v.owner === null ? null : object(v.owner);
  return { id: string(v.id), name: string(v.name), slug: string(v.slug),
    ...(owner === undefined ? {} : { owner: owner === null ? null : { name: string(owner.name), email: string(owner.email) } }) };
}
function page<T>(value: unknown, parse: (item: unknown) => T): AllowancePage<T> {
  const v = object(value);
  if (!Array.isArray(v.items) || v.items.length > 30) throw new TypeError("Invalid allowance page");
  return { items: v.items.map(parse), nextCursor: nullable(v.nextCursor) };
}
function summary(value: unknown): AllowanceSummary {
  const v = object(value);
  if (typeof v.executionAllowed !== "boolean" || !Array.isArray(v.limits) || v.limits.length !== 2) throw new TypeError("Invalid allowance summary");
  const limits = v.limits.map((entry) => {
    const row = object(entry);
    const result = { key: choice(row.key, ["images.generated", "ocr.requests"] as const),
      state: choice(row.state, ["none", "limited", "unlimited", "invalid"] as const), amount: amountOrNull(row.amount),
      consumed: amount(row.consumed), reserved: amount(row.reserved), remaining: amountOrNull(row.remaining) };
    if (result.state === "limited" && (result.amount === null || result.remaining === null)) throw new TypeError("Missing finite allowance");
    return result;
  });
  if (new Set(limits.map((l) => l.key)).size !== 2) throw new TypeError("Duplicate allowance metric");
  return { workspace: workspace(v.workspace), asOf: timestamp(v.asOf), executionAllowed: v.executionAllowed,
    periodStartsAt: timestamp(v.periodStartsAt), periodEndsAt: timestamp(v.periodEndsAt), limits };
}
function grant(value: unknown): AllowanceGrant {
  const v = object(value);
  return { id: string(v.id), key: choice(v.key, ["tools.execute", "images.generated", "ocr.requests"] as const),
    amount: amountOrNull(v.amount), sourceKind: string(v.sourceKind), effectiveAt: timestamp(v.effectiveAt),
    expiresAt: dateOrNull(v.expiresAt), revokedAt: dateOrNull(v.revokedAt), createdAt: timestamp(v.createdAt),
    operatorUserId: nullable(v.operatorUserId), reason: nullable(v.reason) };
}
function audit(value: unknown): AllowanceAuditEvent {
  const v = object(value);
  return { id: string(v.id), at: timestamp(v.at), action: choice(v.action, ["allowance.grant", "allowance.revoke"] as const),
    grantId: string(v.grantId), operatorUserId: string(v.operatorUserId), reason: string(v.reason) };
}
const ROOT = "/api/v1/admin/allowances/workspaces";
function query(values: Record<string, string | null | undefined>) {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
  return params.size ? `?${params}` : "";
}
export const httpAdminAllowanceAdapter: AdminAllowanceAdapter = {
  async workspaces(search, after, signal) { return page(await fetchJson(`${ROOT}${query({ search, after })}`, { signal }), workspace); },
  async summary(id, signal) { return summary(await fetchJson(`${ROOT}/${encodeURIComponent(id)}`, { signal })); },
  async grants(id, before, signal) { return page(await fetchJson(`${ROOT}/${encodeURIComponent(id)}/grants${query({ before })}`, { signal }), grant); },
  async audit(id, before, signal) { return page(await fetchJson(`${ROOT}/${encodeURIComponent(id)}/audit${query({ before })}`, { signal }), audit); },
  async mutate(id, operation, input, key) {
    const result = object(await fetchJson(`${ROOT}/${encodeURIComponent(id)}/${operation}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(input),
    }));
    if (typeof result.replayed !== "boolean" || result.operation !== operation) throw new TypeError("Invalid allowance receipt");
    return { grantId: string(result.grantId), operation, replayed: result.replayed };
  },
};
