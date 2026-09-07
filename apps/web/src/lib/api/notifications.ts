import { fetchJsonResponse } from "./client";

export interface NotificationState {
  configured: boolean;
  completed: boolean;
  failed: boolean;
  deliveries: { id: string; runId: string; event: string; status: string; attempts: number; nextAttemptAt: string | null; sentAt: string | null; failureCode: string | null }[];
}

function parseNotificationState(value: unknown): NotificationState {
  const state = (value as { notifications?: Partial<NotificationState> } | null)?.notifications;
  if (!state || typeof state.configured !== "boolean" || typeof state.completed !== "boolean"
    || typeof state.failed !== "boolean" || !Array.isArray(state.deliveries)
    || !state.deliveries.every((item) => item && typeof item.id === "string" && typeof item.runId === "string"
      && typeof item.event === "string" && typeof item.status === "string"
      && Number.isSafeInteger(item.attempts) && item.attempts >= 0
      && [item.nextAttemptAt, item.sentAt, item.failureCode].every((field) => field === null || typeof field === "string"))) {
    throw new TypeError("Invalid notification response");
  }
  return state as NotificationState;
}

export const notificationsApi = {
  async get(signal?: AbortSignal): Promise<NotificationState> {
    return parseNotificationState((await fetchJsonResponse<unknown>("/api/v1/notifications", { signal })).data);
  },
  async update(settings: Pick<NotificationState, "completed" | "failed">): Promise<NotificationState> {
    return parseNotificationState((await fetchJsonResponse<unknown>("/api/v1/notifications", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings),
    })).data);
  },
};
