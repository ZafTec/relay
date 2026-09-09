import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice, type NoticeTone } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { Disclosure } from "../../components/ui/Disclosure";
import { StatusBadge } from "../../components/ui/StatusBadge";
import {
  httpRunsAdapter,
  isRunId,
  type GetRunAdapterResult,
  type JsonValue,
  type RunDetail,
  type RunOutputSet,
  type RunReservationSummary,
  type RunStatus,
  type RunsAdapter,
} from "../../lib/api/runs";
import type { WorkspaceEventSourceFactory } from "../../lib/events";
import { CancelRunDialog, type CancelDialogState } from "./CancelRunDialog";
import {
  formatCompleteness,
  formatRunStatus,
  formatRunTimestamp,
  LiveConnectionStatus,
  RunStatusBadge,
} from "./run-display";
import { useRunEventStream } from "./useRunEventStream";
import "./runs.css";

type DetailState =
  | { readonly kind: "loading" }
  | Exclude<GetRunAdapterResult, { readonly kind: "auth-expired" }>;

interface CancellationOutcome {
  readonly tone: NoticeTone;
  readonly title: string;
  readonly message: string;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function isTerminal(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function canRequestCancellation(status: RunStatus): boolean {
  return status === "queued" || status === "running";
}

function stateDescription(status: RunStatus): string {
  switch (status) {
    case "queued":
      return "Relay accepted this run and is waiting to begin execution.";
    case "running":
      return "Your tool is running. This page updates as work progresses.";
    case "succeeded":
      return "Your run is complete. Open the results below.";
    case "failed":
      return "The run could not finish. Review any returned results and error details below.";
    case "cancel_requested":
      return "Cancellation was requested. A terminal result can still win if it completes first.";
    case "cancelled":
      return "Relay confirmed this run is cancelled.";
  }
}

function jsonText(value: JsonValue): string {
  return JSON.stringify(value, null, 2);
}

function RunFacts({ run }: { readonly run: RunDetail }) {
  return (
    <dl className="run-detail-facts">
      <div>
        <dt>Run ID</dt>
        <dd><code>{run.id}</code></dd>
      </div>
      <div>
        <dt>Tool</dt>
        <dd>
          <Link
            className="run-tool-link"
            to={`/dashboard/tools/${encodeURIComponent(run.tool.key)}`}
          >
            <strong>{run.tool.name}</strong>
            <code>{run.tool.key} · v{run.tool.version}</code>
          </Link>
        </dd>
      </div>
      <div>
        <dt>Tool version ID</dt>
        <dd><code>{run.tool.versionId}</code></dd>
      </div>
      <div>
        <dt>Result completeness</dt>
        <dd>{formatCompleteness(run.resultCompleteness)}</dd>
      </div>
      <div>
        <dt>Accepted</dt>
        <dd><time dateTime={run.acceptedAt}>{formatRunTimestamp(run.acceptedAt)}</time></dd>
      </div>
      <div>
        <dt>Started</dt>
        <dd>
          {run.startedAt === null
            ? "Not started"
            : <time dateTime={run.startedAt}>{formatRunTimestamp(run.startedAt)}</time>}
        </dd>
      </div>
      <div>
        <dt>Terminal</dt>
        <dd>
          {run.terminalAt === null
            ? "Not terminal"
            : <time dateTime={run.terminalAt}>{formatRunTimestamp(run.terminalAt)}</time>}
        </dd>
      </div>
    </dl>
  );
}

function ReservationPanel({
  reservation,
}: {
  readonly reservation: RunReservationSummary | null;
}) {
  return (
    <section className="run-ledger-section" aria-labelledby="run-reservation-heading">
      <header className="run-section-heading">
        <div>
          <h2 id="run-reservation-heading">Reservation</h2>
          <p>Meter reservation fields returned with this run.</p>
        </div>
        {reservation === null
          ? <StatusBadge tone="muted">Not returned</StatusBadge>
          : <StatusBadge tone={reservation.status === "active" ? "pending" : "ready"}>{reservation.status}</StatusBadge>}
      </header>
      {reservation === null ? (
        <p className="run-section-empty">No reservation was returned for this run.</p>
      ) : (
        <dl className="run-reservation-grid">
          <div>
            <dt>Reservation ID</dt>
            <dd><code>{reservation.id}</code></dd>
          </div>
          <div>
            <dt>Metric</dt>
            <dd><code>{reservation.metric}</code></dd>
          </div>
          <div>
            <dt>Reserved amount</dt>
            <dd><code>{reservation.amount} {reservation.unit}</code></dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{reservation.status}</dd>
          </div>
          <div>
            <dt>Expires</dt>
            <dd>
              <time dateTime={reservation.expiresAt}>
                {formatRunTimestamp(reservation.expiresAt)}
              </time>
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}

function OutputPanel({ outputSet }: { readonly outputSet: RunOutputSet | null }) {
  return (
    <section className="run-ledger-section" aria-labelledby="run-output-heading">
      <header className="run-section-heading">
        <div>
          <h2 id="run-output-heading">Output set</h2>
          <p>Named outputs and artifact references returned by Relay.</p>
        </div>
        {outputSet === null ? (
          <StatusBadge tone="muted">Not returned</StatusBadge>
        ) : (
          <span className="run-output-count">
            {outputSet.producedCount} produced · {outputSet.requestedCount} requested
          </span>
        )}
      </header>

      {outputSet === null ? (
        <p className="run-section-empty">No output set was returned for this run.</p>
      ) : (
        <>
          <dl className="run-output-summary">
            <div>
              <dt>Output set ID</dt>
              <dd><code>{outputSet.id}</code></dd>
            </div>
            <div>
              <dt>Completeness</dt>
              <dd>{formatCompleteness(outputSet.completeness)}</dd>
            </div>
          </dl>
          {outputSet.items.length === 0 ? (
            <p className="run-section-empty">The output set contains no output items.</p>
          ) : (
            <ol className="run-output-items">
              {outputSet.items.map((item) => (
                <li key={`${item.ordinal}:${item.name}`}>
                  <div className="run-output-item__heading">
                    <div>
                      <span>Output {item.ordinal + 1}</span>
                      <h3>{item.name}</h3>
                    </div>
                    <StatusBadge
                      tone={item.status === "succeeded"
                        ? "ready"
                        : item.status === "failed"
                          ? "warning"
                          : "pending"}
                    >
                      {item.status}
                    </StatusBadge>
                  </div>
                  {item.status === "succeeded"
                    && item.artifactId !== null
                    && item.artifactVersionId !== null ? (
                    <dl>
                      <div>
                        <dt>Artifact</dt>
                        <dd>
                          <Link to={`/dashboard/artifacts/${encodeURIComponent(item.artifactId)}`}>
                            <code>{item.artifactId}</code>
                          </Link>
                        </dd>
                      </div>
                      <div>
                        <dt>Artifact version</dt>
                        <dd><code>{item.artifactVersionId}</code></dd>
                      </div>
                    </dl>
                  ) : item.status === "failed" ? (
                    <p>Error code: <code>{item.errorCode}</code></p>
                  ) : (
                    <p>No artifact has been returned for this output.</p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {outputSet.warnings.length > 0 ? (
            <div className="run-output-warnings">
              <h3>Warnings</h3>
              <ol>
                {outputSet.warnings.map((warning, index) => (
                  <li key={index}><code>{jsonText(warning)}</code></li>
                ))}
              </ol>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

export interface RunDetailPageProps {
  readonly adapter?: RunsAdapter;
  readonly eventSourceFactory?: WorkspaceEventSourceFactory;
  readonly runId?: string;
}

export function RunDetailPage({
  adapter = httpRunsAdapter,
  eventSourceFactory,
  runId: runIdProp,
}: RunDetailPageProps) {
  const params = useParams<{ runId: string }>();
  const runId = runIdProp ?? params.runId;
  const { expireSession, refreshWorkspace, session, workspace } = useAuth();
  const sessionId = session.status === "authenticated" ? session.identity.session.id : undefined;
  const workspaceId = workspace.status === "ready" ? workspace.workspace.id : undefined;
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [cancelDialog, setCancelDialog] = useState<CancelDialogState>({ kind: "closed" });
  const [cancelTrigger, setCancelTrigger] = useState<HTMLButtonElement | null>(null);
  const [cancellationOutcome, setCancellationOutcome] = useState<CancellationOutcome | null>(null);
  const activeRef = useRef(false);
  const runIdRef = useRef(runId);
  const readGenerationRef = useRef(0);
  const cancellationGenerationRef = useRef(0);
  const readControllerRef = useRef<AbortController | null>(null);
  const outcomeRef = useRef<HTMLDivElement | null>(null);
  const cancelDialogKindRef = useRef<CancelDialogState["kind"]>(cancelDialog.kind);
  runIdRef.current = runId;
  cancelDialogKindRef.current = cancelDialog.kind;

  const run = state.kind === "found" && state.run.id === runId ? state.run : null;
  const pageTitle = run === null ? "Run details | Relay" : `${run.id} | Relay`;
  usePageMetadata(pageTitle, "#141A16");

  const handleAuthExpired = useCallback(() => {
    expireSession(sessionId);
  }, [expireSession, sessionId]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      readGenerationRef.current += 1;
      cancellationGenerationRef.current += 1;
      readControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const generation = ++readGenerationRef.current;
    cancellationGenerationRef.current += 1;
    readControllerRef.current?.abort();
    readControllerRef.current = null;
    setCancelDialog({ kind: "closed" });
    setCancellationOutcome(null);
    setRefreshError(null);
    setRefreshing(false);

    if (!isRunId(runId)) {
      setState({ kind: "not_found" });
      return;
    }
    if (sessionId === undefined || workspaceId === undefined) {
      setState({ kind: "loading" });
      return;
    }

    const controller = new AbortController();
    readControllerRef.current = controller;
    setState({ kind: "loading" });
    void adapter.get(runId, controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (!activeRef.current || generation !== readGenerationRef.current) return;
      setState(result);
    }).catch((error: unknown) => {
      if (
        isAbortError(error)
        || !activeRef.current
        || generation !== readGenerationRef.current
      ) return;
      setState({
        kind: "degraded",
        message: "Relay could not load this run. No run data was changed.",
      });
    }).finally(() => {
      if (readControllerRef.current === controller) readControllerRef.current = null;
    });

    return () => controller.abort();
  }, [adapter, expireSession, reloadKey, runId, sessionId, workspaceId]);

  const refreshDurableDetail = useCallback(async () => {
    if (
      !isRunId(runId)
      || sessionId === undefined
      || workspaceId === undefined
      || cancelDialogKindRef.current === "pending"
    ) return;
    const requestedRunId = runId;
    const generation = ++readGenerationRef.current;
    const controller = new AbortController();
    readControllerRef.current?.abort();
    readControllerRef.current = controller;
    setRefreshing(true);
    setRefreshError(null);

    try {
      const result = await adapter.get(requestedRunId, controller.signal);
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (
        !activeRef.current
        || generation !== readGenerationRef.current
        || runIdRef.current !== requestedRunId
      ) return;
      if (result.kind === "degraded") {
        setRefreshError(result.message);
        return;
      }
      setState(result);
      if (result.kind === "found" && isTerminal(result.run.status)) {
        const cancellationWasOpen = cancelDialogKindRef.current !== "closed";
        setCancelDialog({ kind: "closed" });
        if (cancellationWasOpen) {
          setCancellationOutcome({
            tone: "info",
            title: "Run reached a terminal state",
            message: `The run finished as ${formatRunStatus(result.run.status).toLocaleLowerCase()}. Relay kept the terminal result.`,
          });
          window.setTimeout(() => outcomeRef.current?.focus(), 0);
        }
      }
    } catch (error) {
      if (
        !isAbortError(error)
        && activeRef.current
        && generation === readGenerationRef.current
        && runIdRef.current === requestedRunId
      ) {
        setRefreshError("Relay could not refresh this run. Existing durable data remains visible.");
      }
    } finally {
      if (
        activeRef.current
        && generation === readGenerationRef.current
        && runIdRef.current === requestedRunId
      ) {
        setRefreshing(false);
      }
      if (readControllerRef.current === controller) readControllerRef.current = null;
    }
  }, [adapter, expireSession, runId, sessionId, workspaceId]);

  const liveState = useRunEventStream({
    sessionId,
    workspaceId,
    eventSourceFactory,
    onRunInvalidated: (invalidatedRunId) => {
      if (invalidatedRunId === runId) void refreshDurableDetail();
    },
    onResynchronized: () => {
      void refreshDurableDetail();
    },
    onPermissionChanged: () => {
      void refreshWorkspace();
      void refreshDurableDetail();
    },
    onAuthExpired: handleAuthExpired,
  });

  const closeCancelDialog = useCallback(() => {
    setCancelDialog((current) => current.kind === "pending"
      ? current
      : { kind: "closed" });
  }, []);

  const confirmCancellation = useCallback(async () => {
    if (run === null || !canRequestCancellation(run.status) || cancelDialog.kind === "pending") {
      return;
    }
    const requestedRunId = run.id;
    const generation = ++cancellationGenerationRef.current;
    readGenerationRef.current += 1;
    readControllerRef.current?.abort();
    readControllerRef.current = null;
    setRefreshing(false);
    setCancelDialog({ kind: "pending" });
    setCancellationOutcome(null);

    try {
      const result = await adapter.cancel(requestedRunId);
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (
        !activeRef.current
        || generation !== cancellationGenerationRef.current
        || runIdRef.current !== requestedRunId
      ) return;
      if (result.kind === "degraded") {
        setCancelDialog({ kind: "error", message: result.message });
        return;
      }
      if (result.kind === "not_found") {
        readGenerationRef.current += 1;
        setCancelDialog({ kind: "closed" });
        setState({ kind: "not_found" });
        return;
      }

      readGenerationRef.current += 1;
      setRefreshing(false);
      setRefreshError(null);
      setState({ kind: "found", run: result.run });
      setCancelDialog({ kind: "closed" });
      setCancellationOutcome(result.kind === "already_terminal"
        ? result.run.status === "cancelled"
          ? {
              tone: "success",
              title: "Run already cancelled",
              message: "Relay confirmed the run was already cancelled.",
            }
          : {
              tone: "info",
              title: "Run already terminal",
              message: `The run finished as ${formatRunStatus(result.run.status).toLocaleLowerCase()} before cancellation took effect. Relay kept the terminal result.`,
            }
        : result.kind === "cancel_requested"
          ? {
              tone: "info",
              title: "Cancellation requested",
              message: "Relay recorded the request. A terminal result can still win if it completes first.",
            }
          : {
              tone: "success",
              title: "Run cancelled",
              message: "Relay confirmed the run is cancelled.",
            });
      window.setTimeout(() => outcomeRef.current?.focus(), 0);
    } catch {
      if (
        activeRef.current
        && generation === cancellationGenerationRef.current
        && runIdRef.current === requestedRunId
      ) {
        setCancelDialog({
          kind: "error",
          message:
            "Relay could not confirm the cancellation result. The request was not repeated. Refresh the run or try cancellation again.",
        });
      }
    }
  }, [adapter, cancelDialog.kind, expireSession, run, sessionId]);

  return (
    <div className="run-detail-page product-surface">
      <header className="run-detail-header">
        <div className="run-detail-header__main">
          <nav className="run-breadcrumb" aria-label="Breadcrumb">
            <Link to="/dashboard/runs">Runs</Link>
            <span aria-hidden="true">/</span>
            <span aria-current="page">Run details</span>
          </nav>
          <div className="run-detail-title">
            <div>
              <h1>{run === null ? "Run detail" : run.tool.name}</h1>
              {run === null ? null : <p>Accepted {formatRunTimestamp(run.acceptedAt)}</p>}
            </div>
            {run === null ? null : <RunStatusBadge status={run.status} />}
          </div>
        </div>
        <div className="run-detail-header__actions">
          <LiveConnectionStatus state={liveState} />
          <Button
            variant="outline"
            pending={refreshing}
            pendingLabel="Refreshing"
            onClick={() => {
              if (run === null) setReloadKey((value) => value + 1);
              else void refreshDurableDetail();
            }}
          >
            Refresh
          </Button>
        </div>
      </header>

      <div className="run-detail-body" aria-busy={state.kind === "loading" || refreshing || undefined}>
        {state.kind === "loading" ? <Skeleton label="Loading run details" lines={8} /> : null}

        {state.kind === "degraded" ? (
          <div className="run-detail-state">
            <InlineNotice
              title="Run unavailable"
              tone="error"
              action={
                <Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
                  Try again
                </Button>
              }
            >
              <p>{state.message}</p>
            </InlineNotice>
            <LinkButton variant="quiet" to="/dashboard/runs">Back to runs</LinkButton>
          </div>
        ) : null}

        {state.kind === "not_found" ? (
          <section className="run-not-found" aria-labelledby="run-not-found-heading">
            <p className="mono-label">Run registry</p>
            <h2 id="run-not-found-heading">Run not found</h2>
            <p>The run does not exist in the active workspace, or it is no longer available.</p>
            <LinkButton variant="outline" to="/dashboard/runs">Return to runs</LinkButton>
          </section>
        ) : null}

        {run !== null ? (
          <>
            {refreshError ? (
              <InlineNotice
                title="Durable refresh unavailable"
                tone="error"
                action={
                  <Button variant="outline" onClick={() => void refreshDurableDetail()}>
                    Try refresh again
                  </Button>
                }
              >
                <p>{refreshError}</p>
              </InlineNotice>
            ) : null}

            {cancellationOutcome ? (
              <div ref={outcomeRef} tabIndex={-1} className="run-cancellation-outcome">
                <InlineNotice title={cancellationOutcome.title} tone={cancellationOutcome.tone}>
                  <p>{cancellationOutcome.message}</p>
                </InlineNotice>
              </div>
            ) : null}

            {run.status === "cancel_requested" && cancellationOutcome === null ? (
              <InlineNotice title="Cancellation requested" tone="warning">
                <p>
                  Relay is waiting for the run to stop. A terminal result can still win
                  if it completes before cancellation takes effect.
                </p>
              </InlineNotice>
            ) : null}

            <section className={`run-state-panel run-state-panel--${run.status}`} aria-labelledby="run-state-heading">
              <div>
                <h2 id="run-state-heading">Current state</h2>
                <p>{stateDescription(run.status)}</p>
              </div>
              <div className="run-state-panel__actions">
                <RunStatusBadge status={run.status} />
                {canRequestCancellation(run.status) ? (
                  <Button
                    variant="outline"
                    onClick={(event) => {
                      setCancelTrigger(event.currentTarget);
                      setCancelDialog({ kind: "confirming" });
                    }}
                  >
                    Request cancellation
                  </Button>
                ) : null}
              </div>
            </section>

            <OutputPanel outputSet={run.outputSet} />

            <Disclosure title="Run details" description="Timing, completeness, and reference IDs">
              <RunFacts run={run} />
            </Disclosure>

            <Disclosure title="Input and reservation" description="Review the submitted input and reserved usage">
            <div className="run-detail-ledger">
              <section className="run-ledger-section" aria-labelledby="run-input-heading">
                <header className="run-section-heading">
                  <div>
                    <h2 id="run-input-heading">Input</h2>
                    <p>Accepted JSON stored with the run.</p>
                  </div>
                  <span className="run-section-format">JSON</span>
                </header>
                <pre className="run-input" tabIndex={0} aria-label={`Input for ${run.id}`}>
                  <code>{jsonText(run.input)}</code>
                </pre>
              </section>

              <ReservationPanel reservation={run.reservation} />
            </div>

            </Disclosure>
          </>
        ) : null}
      </div>

      {run !== null ? (
        <CancelRunDialog
          runId={run.id}
          state={cancelDialog}
          returnFocusTo={cancelTrigger}
          onConfirm={() => void confirmCancellation()}
          onClose={closeCancelDialog}
        />
      ) : null}
    </div>
  );
}
