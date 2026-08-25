import {
  type GetUsageSummaryResult,
  getUsageSummaryResultSchema,
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

  constructor(pool: DatabasePool, now: () => Date = () => new Date()) {
    this.#pool = pool;
    this.#now = now;
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
