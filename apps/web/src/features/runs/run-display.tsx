import { StatusBadge, type StatusTone } from "../../components/ui/StatusBadge";
import type {
  RunResultCompleteness,
  RunStatus,
} from "../../lib/api/runs";
import type { WorkspaceEventConnectionState } from "../../lib/events";

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancel_requested: "Cancel requested",
  cancelled: "Cancelled",
};

const STATUS_TONES: Record<RunStatus, StatusTone> = {
  queued: "pending",
  running: "ready",
  succeeded: "ready",
  failed: "warning",
  cancel_requested: "pending",
  cancelled: "muted",
};

const COMPLETENESS_LABELS: Record<RunResultCompleteness, string> = {
  pending: "Pending",
  complete: "Complete",
  partial: "Partial",
  failed: "Failed",
};

export function formatRunStatus(status: RunStatus): string {
  return STATUS_LABELS[status];
}

export function formatCompleteness(
  completeness: RunResultCompleteness | null,
): string {
  return completeness === null ? "Not reported" : COMPLETENESS_LABELS[completeness];
}

export function formatRunTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(timestamp));
}

export function RunStatusBadge({ status }: { readonly status: RunStatus }) {
  return <StatusBadge tone={STATUS_TONES[status]}>{STATUS_LABELS[status]}</StatusBadge>;
}

function connectionLabel(state: WorkspaceEventConnectionState): string {
  switch (state.kind) {
    case "connecting":
      return "Connecting to live updates";
    case "connected":
      return "Connected · live";
    case "reconnecting":
      return `Reconnecting · attempt ${state.attempt}`;
    case "stale":
      return "Live updates stale";
    case "offline":
      return "Offline · durable state shown";
    case "resynchronized":
      return "Resynchronized · durable state refreshed";
    case "permission_changed":
      return state.reason === "role_changed"
        ? "Role changed · refreshing permissions"
        : "Membership changed · refreshing permissions";
  }
}

export function LiveConnectionStatus({
  state,
}: {
  readonly state: WorkspaceEventConnectionState;
}) {
  return (
    <div
      className={`run-live-status run-live-status--${state.kind}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="run-live-status__mark" aria-hidden="true" />
      <span>{connectionLabel(state)}</span>
    </div>
  );
}
