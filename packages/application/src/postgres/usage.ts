import {
  type GetStorageUsageResult,
  getStorageUsageResultSchema,
  type GetUsageSummaryResult,
  getUsageSummaryResultSchema,
  storageByteCount,
  type UsagePeriod,
  usageSummaryItemSchema,
  type UsageSummaryRequest,
  usageSummaryRequestSchema,
} from "@relay/contracts";
import type { DatabasePool } from "@relay/database";
import type { WorkspaceActorContext } from "../context.ts";
import { validateWorkspaceActorContext } from "../context.ts";
import type { UsageApplicationService } from "../services.ts";
import { hasCurrentMembership, iso } from "./shared.ts";

const MAX_USAGE_SUMMARY_ITEMS = 100;

export type StorageUsageLimitResolver = (workspaceId: string) => Promise<
  | { readonly kind: "limited"; readonly maxBytes: string }
  | { readonly kind: "unlimited" }
  | {
    readonly kind: "denied";
    readonly reason: "not_configured" | "unavailable";
  }
>;

interface UsageBucketRow {
  readonly metric_key: string;
  readonly unit: string;
  readonly period: UsagePeriod;
  readonly period_start: Date | string;
  readonly period_end: Date | string;
  readonly consumed_amount: string;
  readonly reserved_amount: string;
}

export class PostgresUsageService implements UsageApplicationService {
  readonly #pool: DatabasePool;
  readonly #now: () => Date;
  readonly #storageLimit?: StorageUsageLimitResolver;

  constructor(
    pool: DatabasePool,
    now: () => Date = () => new Date(),
    storageLimit?: StorageUsageLimitResolver,
  ) {
    this.#pool = pool;
    this.#now = now;
    this.#storageLimit = storageLimit;
  }

  async getStorageSummary(
    rawContext: WorkspaceActorContext,
  ): Promise<GetStorageUsageResult> {
    const context = validateWorkspaceActorContext(rawContext);
    // A member without an account has never reserved bytes. Read membership and
    // both counters in one snapshot, so a missing membership cannot become zero.
    const { rows } = await this.#pool.query<{
      stored_bytes: string;
      reserved_bytes: string;
      cleanup_pending_bytes: string;
    }>(
      `select coalesce(account.committed_bytes, 0)::text as stored_bytes,
              coalesce(account.reserved_bytes, 0)::text as reserved_bytes,
              coalesce((
                select sum(upload.expected_size_bytes)
                  from relay.artifact_uploads upload
                 where upload.workspace_id = member."organizationId"
                   and upload.quota_state = 'cleanup_held'
              ), 0)::text as cleanup_pending_bytes
         from auth.member member
         left join relay.artifact_storage_accounts account
           on account.workspace_id = member."organizationId"
        where member."organizationId" = $1 and member."userId" = $2`,
      [context.workspaceId, context.actorUserId],
    );
    const row = rows[0];
    if (row === undefined) return { kind: "not_found" };
    if (this.#storageLimit === undefined) return { kind: "unavailable" };
    let limitBytes: string | null;
    try {
      const decision = await this.#storageLimit(context.workspaceId);
      if (decision.kind === "denied") return { kind: "unavailable" };
      if (decision.kind === "unlimited") limitBytes = null;
      else if (decision.kind === "limited") {
        limitBytes = storageByteCount(decision.maxBytes, "limitBytes");
      } else return { kind: "unavailable" };
    } catch {
      return { kind: "unavailable" };
    }
    const occupied = BigInt(row.stored_bytes) + BigInt(row.reserved_bytes);
    const availableBytes = limitBytes === null
      ? null
      : (BigInt(limitBytes) > occupied ? BigInt(limitBytes) - occupied : 0n)
        .toString();
    return getStorageUsageResultSchema.parse({
      kind: "ok",
      storage: {
        generatedAt: this.#now().toISOString(),
        storedBytes: row.stored_bytes,
        reservedBytes: row.reserved_bytes,
        cleanupPendingBytes: row.cleanup_pending_bytes,
        limitBytes,
        availableBytes,
      },
    });
  }

  async getSummary(
    rawContext: WorkspaceActorContext,
    rawRequest: UsageSummaryRequest,
  ): Promise<GetUsageSummaryResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const request = usageSummaryRequestSchema.parse(rawRequest);
    if (!await hasCurrentMembership(this.#pool, context)) {
      return { kind: "not_found" };
    }

    const { rows } = await this.#pool.query<UsageBucketRow>(
      `select bucket.metric_key, bucket.unit, bucket.period,
              bucket.period_start, bucket.period_end,
              bucket.consumed_amount::text, bucket.reserved_amount::text
         from relay.usage_buckets bucket
        where bucket.workspace_id = $1
          and exists (
            select 1 from auth.member member
             where member."organizationId" = bucket.workspace_id
               and member."userId" = $2
          )
          and bucket.period_start <= now() and bucket.period_end > now()
          and ($3::text is null or bucket.metric_key = $3)
          and ($4::text is null or bucket.period = $4)
        order by bucket.metric_key asc, bucket.unit asc, bucket.period asc,
                 bucket.period_start desc, bucket.id desc
        limit $5`,
      [
        context.workspaceId,
        context.actorUserId,
        request.metric ?? null,
        request.period ?? null,
        MAX_USAGE_SUMMARY_ITEMS + 1,
      ],
    );
    const selected = rows.slice(0, MAX_USAGE_SUMMARY_ITEMS);
    return getUsageSummaryResultSchema.parse({
      kind: "ok",
      usage: {
        generatedAt: this.#now().toISOString(),
        items: selected.map((row: UsageBucketRow) =>
          usageSummaryItemSchema.parse({
            metric: row.metric_key,
            unit: row.unit,
            period: row.period,
            periodStartsAt: iso(row.period_start),
            periodEndsAt: iso(row.period_end),
            consumedAmount: row.consumed_amount,
            reservedAmount: row.reserved_amount,
          })
        ),
        truncated: rows.length > MAX_USAGE_SUMMARY_ITEMS,
      },
    });
  }
}
