import { ApiError, fetchJson } from "./client";
import { parseListRunsResponse, type RunSummary } from "./runs";
import { type ArtifactSummary, parseListArtifactsResponse } from "./artifacts";

export interface DashboardOverview {
  counts: {
    runs: number;
    activeRuns: number;
    failedRuns: number;
    artifacts: number;
  };
  runs: readonly RunSummary[];
  artifacts: readonly ArtifactSummary[];
  generatedAt: string;
}
export type DashboardOverviewResult =
  | { kind: "ok"; overview: DashboardOverview }
  | { kind: "auth-expired" }
  | { kind: "degraded"; message: string };
export interface DashboardOverviewAdapter {
  load(signal?: AbortSignal): Promise<DashboardOverviewResult>;
}

export function parseOverview(value: unknown): DashboardOverview {
  const raw = value as Record<string, unknown> | null;
  if (
    !raw || raw.kind !== "ok" || typeof raw.generatedAt !== "string" ||
    !Number.isFinite(Date.parse(raw.generatedAt))
  ) throw new TypeError("Invalid overview");
  const counts = raw.counts as DashboardOverview["counts"] | null;
  if (
    !counts ||
    [counts.runs, counts.activeRuns, counts.failedRuns, counts.artifacts].some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    ) ||
    counts.activeRuns + counts.failedRuns > counts.runs
  ) throw new TypeError("Invalid overview counts");
  const runs = parseListRunsResponse(raw.recentRuns);
  const artifacts = parseListArtifactsResponse(raw.recentArtifacts);
  if (runs.kind !== "ok" || artifacts.kind !== "ok") {
    throw new TypeError("Invalid overview activity");
  }
  return {
    counts,
    runs: runs.items,
    artifacts: artifacts.items,
    generatedAt: raw.generatedAt,
  };
}

export const httpDashboardOverviewAdapter: DashboardOverviewAdapter = {
  async load(signal) {
    try {
      return {
        kind: "ok",
        overview: parseOverview(
          await fetchJson("/api/v1/overview", { signal, cache: "no-store" }),
        ),
      };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ApiError && error.status === 401) {
        return { kind: "auth-expired" };
      }
      return {
        kind: "degraded",
        message: error instanceof TypeError
          ? "Your workspace overview could not be reached. Please try again."
          : "Your workspace overview is unavailable. Please try again.",
      };
    }
  },
};
