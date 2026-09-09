import type { DatabasePool } from "@relay/database";
import type { ListArtifactsResult, ListRunsResult } from "@relay/contracts";
import {
  validateWorkspaceActorContext,
  type WorkspaceActorContext,
} from "./context.ts";
import type {
  ArtifactReadApplicationService,
  RunReadApplicationService,
} from "./services.ts";

export interface OverviewCounts {
  runs: number;
  activeRuns: number;
  failedRuns: number;
  artifacts: number;
}
export type OverviewResult = { kind: "not_found" } | {
  kind: "ok";
  generatedAt: string;
  counts: OverviewCounts;
  recentRuns: Extract<ListRunsResult, { kind: "ok" }>;
  recentArtifacts: Extract<ListArtifactsResult, { kind: "ok" }>;
};
export interface OverviewApplicationService {
  get(context: WorkspaceActorContext): Promise<OverviewResult>;
}

export function createOverviewService(
  pool: DatabasePool,
  runs: RunReadApplicationService,
  artifacts: ArtifactReadApplicationService,
): OverviewApplicationService {
  return {
    async get(raw) {
      const context = validateWorkspaceActorContext(raw);
      // Missing access must never be represented as an empty workspace.
      const { rows } = await pool.query<OverviewCounts>(
        `select
        (select count(*)::integer from relay.tool_runs where workspace_id=$1) as runs,
        (select count(*)::integer from relay.tool_runs where workspace_id=$1 and status in ('queued','running','cancel_requested')) as "activeRuns",
        (select count(*)::integer from relay.tool_runs where workspace_id=$1 and status='failed') as "failedRuns",
        (select count(*)::integer from relay.artifacts where workspace_id=$1 and deleted_at is null and purged_at is null) as artifacts
       from auth.member where "organizationId"=$1 and "userId"=$2`,
        [context.workspaceId, context.actorUserId],
      );
      if (!rows[0]) return { kind: "not_found" };
      const [recentRuns, recentArtifacts] = await Promise.all([
        runs.list(context, { limit: 5, cursor: null }),
        artifacts.list(context, { limit: 4, cursor: null }),
      ]);
      if (recentRuns.kind !== "ok" || recentArtifacts.kind !== "ok") {
        return {
          kind: "not_found",
        };
      }
      return {
        kind: "ok",
        generatedAt: new Date().toISOString(),
        counts: rows[0],
        recentRuns,
        recentArtifacts,
      };
    },
  };
}
