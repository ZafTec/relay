import { useEffect, useRef, useState } from "react";
import {
  httpWorkspaceEventSourceFactory,
  type WorkspaceEventConnectionState,
  type WorkspaceEventEnvelope,
  type WorkspaceEventSourceFactory,
} from "../../lib/events";

interface RunEventStreamOptions {
  readonly sessionId: string | undefined;
  readonly workspaceId: string | undefined;
  readonly eventSourceFactory?: WorkspaceEventSourceFactory;
  readonly onRunInvalidated: (runId: string) => void;
  readonly onResynchronized: () => void;
  readonly onPermissionChanged: () => void;
  readonly onAuthExpired: () => void;
}

function invalidatedRunId(envelope: WorkspaceEventEnvelope): string | null {
  switch (envelope.event.type) {
    case "run.created":
    case "run.progress_changed":
    case "run.status_changed":
    case "run.completed":
      return envelope.event.runId;
    case "artifact.created":
      return envelope.event.runId;
    default:
      return null;
  }
}

export function useRunEventStream({
  sessionId,
  workspaceId,
  eventSourceFactory = httpWorkspaceEventSourceFactory,
  onRunInvalidated,
  onResynchronized,
  onPermissionChanged,
  onAuthExpired,
}: RunEventStreamOptions): WorkspaceEventConnectionState {
  const [state, setState] = useState<WorkspaceEventConnectionState>({
    kind: "connecting",
  });
  const callbacks = useRef({
    onRunInvalidated,
    onResynchronized,
    onPermissionChanged,
  });
  const permissionChangePendingRef = useRef(false);
  const owningSessionRef = useRef<string | undefined>(undefined);
  callbacks.current = {
    onRunInvalidated,
    onResynchronized,
    onPermissionChanged,
  };

  useEffect(() => {
    if (sessionId === undefined || workspaceId === undefined) {
      if (!permissionChangePendingRef.current) setState({ kind: "connecting" });
      return;
    }
    if (owningSessionRef.current !== sessionId) {
      owningSessionRef.current = sessionId;
      permissionChangePendingRef.current = false;
    }

    let disposed = false;
    let synchronized = false;
    let connection: ReturnType<WorkspaceEventSourceFactory> | null = null;
    const expireOwningSession = onAuthExpired;

    connection = eventSourceFactory({
      sessionId,
      workspaceId,
      handlers: {
        onState(nextState) {
          if (disposed) return;
          if (
            nextState.kind === "connecting"
            || nextState.kind === "reconnecting"
            || nextState.kind === "offline"
          ) {
            synchronized = false;
          }
          if (
            permissionChangePendingRef.current
            && (nextState.kind === "connecting"
              || nextState.kind === "connected"
              || nextState.kind === "reconnecting"
              || nextState.kind === "stale")
          ) {
            return;
          }
          setState(nextState);
        },
        onEvent(envelope) {
          if (disposed || envelope.workspaceId !== workspaceId) return;
          if (envelope.event.type === "session.permission_changed") {
            synchronized = false;
            permissionChangePendingRef.current = true;
            setState({
              kind: "permission_changed",
              reason: envelope.event.reason,
            });
            callbacks.current.onPermissionChanged();
            connection?.reconnect();
            return;
          }

          const runId = invalidatedRunId(envelope);
          if (synchronized && runId !== null) {
            callbacks.current.onRunInvalidated(runId);
          }
        },
        onResynchronized() {
          if (disposed) return;
          synchronized = true;
          permissionChangePendingRef.current = false;
          setState({ kind: "resynchronized" });
          callbacks.current.onResynchronized();
        },
        onAuthExpired() {
          expireOwningSession();
        },
        onAccessUnavailable() {
          if (disposed) return;
          synchronized = false;
          permissionChangePendingRef.current = true;
          setState({ kind: "permission_changed", reason: "membership_changed" });
          callbacks.current.onPermissionChanged();
        },
      },
    });

    return () => {
      disposed = true;
      connection?.close();
    };
  }, [eventSourceFactory, onAuthExpired, sessionId, workspaceId]);

  return state;
}
