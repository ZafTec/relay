import { ApiError, fetchJson } from "./client";

interface ApiRootResponse {
  name?: unknown;
  status?: unknown;
}

export type DashboardOverviewResult =
  | { kind: "empty"; serviceName: string }
  | { kind: "auth-expired" }
  | { kind: "degraded"; message: string };

export interface DashboardOverviewAdapter {
  load(signal?: AbortSignal): Promise<DashboardOverviewResult>;
}

export const httpDashboardOverviewAdapter: DashboardOverviewAdapter = {
  async load(signal) {
    try {
      const response = await fetchJson<ApiRootResponse>("/api/v1", { signal });
      if (response.status !== "ok") {
        return {
          kind: "degraded",
          message: "Relay API is reachable but did not report an available state.",
        };
      }

      return {
        kind: "empty",
        serviceName: typeof response.name === "string" ? response.name : "Relay",
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof ApiError && error.status === 401) {
        return { kind: "auth-expired" };
      }
      return {
        kind: "degraded",
        message: error instanceof TypeError
          ? "Relay API could not be reached. Check the connection and try again."
          : "Relay API status is unavailable. No workspace data was changed.",
      };
    }
  },
};
