import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  RUN_STATUSES,
  httpRunsAdapter,
  type ListRunsAdapterResult,
  type ListRunsRequest,
  type RunStatus,
  type RunSummary,
  type RunsAdapter,
} from "../../lib/api/runs";
import type { WorkspaceEventSourceFactory } from "../../lib/events";
import {
  formatCompleteness,
  formatRunStatus,
  formatRunTimestamp,
  LiveConnectionStatus,
  RunStatusBadge,
} from "./run-display";
import { useRunEventStream } from "./useRunEventStream";
import "./runs.css";

type RunsState =
  | { readonly kind: "loading" }
  | Exclude<ListRunsAdapterResult, { readonly kind: "auth-expired" }>;

interface FilterDraft {
  readonly status: "all" | RunStatus;
  readonly toolKey: string;
  readonly acceptedAfter: string;
  readonly acceptedBefore: string;
}

interface AppliedFilters {
  readonly status: "all" | RunStatus;
  readonly toolKey: string;
  readonly acceptedAfter?: string;
  readonly acceptedBefore?: string;
}

interface FilterErrors {
  readonly toolKey?: string;
  readonly acceptedRange?: string;
}

const EMPTY_DRAFT: FilterDraft = {
  status: "all",
  toolKey: "",
  acceptedAfter: "",
  acceptedBefore: "",
};
const EMPTY_FILTERS: AppliedFilters = {
  status: "all",
  toolKey: "",
};
const TOOL_KEY_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const PAGE_SIZE = 25;

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
    || (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError")
  );
}

function parseLocalTimestamp(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.valueOf()) ? timestamp.toISOString() : undefined;
}

function validateDraft(draft: FilterDraft): {
  readonly filters: AppliedFilters;
  readonly errors: FilterErrors;
} {
  const toolKey = draft.toolKey.trim();
  const acceptedAfter = parseLocalTimestamp(draft.acceptedAfter);
  const acceptedBefore = parseLocalTimestamp(draft.acceptedBefore);
  const errors: FilterErrors = {
    ...(toolKey.length > 0 && (toolKey.length > 128 || !TOOL_KEY_PATTERN.test(toolKey))
      ? {
          toolKey:
            "Use a lowercase tool key with letters, numbers, dots, underscores, or hyphens.",
        }
      : {}),
    ...((draft.acceptedAfter.length > 0 && acceptedAfter === undefined)
        || (draft.acceptedBefore.length > 0 && acceptedBefore === undefined)
        || (acceptedAfter !== undefined
          && acceptedBefore !== undefined
          && acceptedAfter >= acceptedBefore)
      ? { acceptedRange: "Accepted after must be earlier than accepted before." }
      : {}),
  };

  return {
    filters: {
      status: draft.status,
      toolKey,
      ...(acceptedAfter === undefined ? {} : { acceptedAfter }),
      ...(acceptedBefore === undefined ? {} : { acceptedBefore }),
    },
    errors,
  };
}

function sameFilters(left: AppliedFilters, right: AppliedFilters): boolean {
  return left.status === right.status
    && left.toolKey === right.toolKey
    && left.acceptedAfter === right.acceptedAfter
    && left.acceptedBefore === right.acceptedBefore;
}

function hasFilters(filters: AppliedFilters): boolean {
  return filters.status !== "all"
    || filters.toolKey.length > 0
    || filters.acceptedAfter !== undefined
    || filters.acceptedBefore !== undefined;
}

function requestFor(filters: AppliedFilters, cursor?: string): ListRunsRequest {
  return {
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.status === "all" ? {} : { statuses: [filters.status] }),
    ...(filters.toolKey.length === 0 ? {} : { toolKey: filters.toolKey }),
    ...(filters.acceptedAfter === undefined ? {} : { acceptedAfter: filters.acceptedAfter }),
    ...(filters.acceptedBefore === undefined ? {} : { acceptedBefore: filters.acceptedBefore }),
  };
}

function appendUnique(
  current: readonly RunSummary[],
  incoming: readonly RunSummary[],
): readonly RunSummary[] {
  const byId = new Map(current.map((run) => [run.id, run]));
  for (const run of incoming) byId.set(run.id, run);
  return Array.from(byId.values());
}

function resultLabel(state: RunsState): string {
  if (state.kind === "loading") return "Loading runs";
  if (state.kind !== "ok") return "Run registry unavailable";
  const count = state.items.length;
  return `${count}${state.nextCursor === null ? "" : "+"} ${count === 1 ? "run" : "runs"} loaded`;
}

export interface RunsPageProps {
  readonly adapter?: RunsAdapter;
  readonly eventSourceFactory?: WorkspaceEventSourceFactory;
}

export function RunsPage({
  adapter = httpRunsAdapter,
  eventSourceFactory,
}: RunsPageProps) {
  usePageMetadata("Runs | Relay", "#141A16");
  const { expireSession, refreshWorkspace, session, workspace } = useAuth();
  const sessionId = session.status === "authenticated" ? session.identity.session.id : undefined;
  const workspaceId = workspace.status === "ready" ? workspace.workspace.id : undefined;
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_DRAFT);
  const [filters, setFilters] = useState<AppliedFilters>(EMPTY_FILTERS);
  const [filterErrors, setFilterErrors] = useState<FilterErrors>({});
  const [state, setState] = useState<RunsState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const readControllerRef = useRef<AbortController | null>(null);

  const handleAuthExpired = useCallback(() => {
    expireSession(sessionId);
  }, [expireSession, sessionId]);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      generationRef.current += 1;
      readControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (sessionId === undefined || workspaceId === undefined) {
      setState({ kind: "loading" });
      return;
    }

    const generation = ++generationRef.current;
    const controller = new AbortController();
    readControllerRef.current?.abort();
    readControllerRef.current = controller;
    setState({ kind: "loading" });
    setRefreshing(false);
    setRefreshError(null);
    setLoadingMore(false);
    setPaginationError(null);

    void adapter.list(requestFor(filters), controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (!activeRef.current || generation !== generationRef.current) return;
      setState(result);
    }).catch((error: unknown) => {
      if (
        isAbortError(error)
        || !activeRef.current
        || generation !== generationRef.current
      ) return;
      setState({
        kind: "degraded",
        message: "Relay could not load runs. No run data was changed.",
      });
    }).finally(() => {
      if (readControllerRef.current === controller) readControllerRef.current = null;
    });

    return () => controller.abort();
  }, [adapter, expireSession, filters, reloadKey, sessionId, workspaceId]);

  const refreshDurableRuns = useCallback(async () => {
    if (sessionId === undefined || workspaceId === undefined) return;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    readControllerRef.current?.abort();
    readControllerRef.current = controller;
    setRefreshing(true);
    setLoadingMore(false);
    setRefreshError(null);
    setPaginationError(null);

    try {
      const result = await adapter.list(requestFor(filters), controller.signal);
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (!activeRef.current || generation !== generationRef.current) return;
      if (result.kind === "degraded") {
        setRefreshError(result.message);
        return;
      }
      setState(result);
    } catch (error) {
      if (
        !isAbortError(error)
        && activeRef.current
        && generation === generationRef.current
      ) {
        setRefreshError("Relay could not refresh the run registry. Existing results remain available.");
      }
    } finally {
      if (activeRef.current && generation === generationRef.current) {
        setRefreshing(false);
      }
      if (readControllerRef.current === controller) readControllerRef.current = null;
    }
  }, [adapter, expireSession, filters, sessionId, workspaceId]);

  const liveState = useRunEventStream({
    sessionId,
    workspaceId,
    eventSourceFactory,
    onRunInvalidated: () => {
      void refreshDurableRuns();
    },
    onResynchronized: () => {
      void refreshDurableRuns();
    },
    onPermissionChanged: () => {
      void refreshWorkspace();
      void refreshDurableRuns();
    },
    onAuthExpired: handleAuthExpired,
  });

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next = validateDraft(draft);
    setFilterErrors(next.errors);
    if (Object.keys(next.errors).length > 0) return;
    if (sameFilters(filters, next.filters)) {
      void refreshDurableRuns();
    } else {
      setFilters(next.filters);
    }
  }

  function clearFilters() {
    setDraft(EMPTY_DRAFT);
    setFilterErrors({});
    if (sameFilters(filters, EMPTY_FILTERS)) void refreshDurableRuns();
    else setFilters(EMPTY_FILTERS);
  }

  async function loadMore() {
    if (state.kind !== "ok" || state.nextCursor === null || loadingMore) return;
    const cursor = state.nextCursor;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    readControllerRef.current?.abort();
    readControllerRef.current = controller;
    setLoadingMore(true);
    setRefreshing(false);
    setPaginationError(null);

    try {
      const result = await adapter.list(requestFor(filters, cursor), controller.signal);
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (!activeRef.current || generation !== generationRef.current) return;
      if (result.kind === "ok") {
        setState((current) => current.kind === "ok" && current.nextCursor === cursor
          ? {
              kind: "ok",
              items: appendUnique(current.items, result.items),
              nextCursor: result.nextCursor,
            }
          : current);
        return;
      }
      setPaginationError(result.kind === "degraded"
        ? result.message
        : "Relay could not find the next run page. Existing results remain available.");
    } catch (error) {
      if (
        !isAbortError(error)
        && activeRef.current
        && generation === generationRef.current
      ) {
        setPaginationError("Relay could not load more runs. Existing results remain available.");
      }
    } finally {
      if (activeRef.current && generation === generationRef.current) setLoadingMore(false);
      if (readControllerRef.current === controller) readControllerRef.current = null;
    }
  }

  const filtered = hasFilters(filters);
  const hasDraft = draft.status !== "all"
    || draft.toolKey.length > 0
    || draft.acceptedAfter.length > 0
    || draft.acceptedBefore.length > 0;

  return (
    <div className="runs-page product-surface">
      <header className="runs-page-header">
        <div>
          <p className="mono-label">
            {workspaceId === undefined ? "Workspace runs" : `Workspace ${workspaceId}`}
          </p>
          <h1>Runs</h1>
        </div>
        <div className="runs-page-header__actions">
          <LiveConnectionStatus state={liveState} />
          <Button
            variant="outline"
            pending={refreshing}
            pendingLabel="Refreshing"
            onClick={() => {
              if (state.kind === "ok") void refreshDurableRuns();
              else setReloadKey((value) => value + 1);
            }}
          >
            Refresh
          </Button>
        </div>
      </header>

      <form
        className="run-filters"
        role="search"
        aria-label="Filter workspace runs"
        onSubmit={applyFilters}
      >
        <div className="run-filter-field">
          <label htmlFor="run-status-filter">State</label>
          <select
            id="run-status-filter"
            value={draft.status}
            onChange={(event) => {
              const status = event.currentTarget.value as FilterDraft["status"];
              setDraft((current) => ({ ...current, status }));
            }}
          >
            <option value="all">All states</option>
            {RUN_STATUSES.map((status) => (
              <option key={status} value={status}>{formatRunStatus(status)}</option>
            ))}
          </select>
        </div>

        <div className="run-filter-field">
          <label htmlFor="run-tool-filter">Tool key</label>
          <input
            id="run-tool-filter"
            value={draft.toolKey}
            onChange={(event) => {
              const toolKey = event.currentTarget.value;
              setDraft((current) => ({ ...current, toolKey }));
            }}
            aria-invalid={filterErrors.toolKey ? true : undefined}
            aria-describedby={filterErrors.toolKey ? "run-tool-filter-error" : undefined}
            placeholder="All tools"
            spellCheck="false"
          />
          {filterErrors.toolKey ? (
            <span className="run-filter-error" id="run-tool-filter-error" role="alert">
              {filterErrors.toolKey}
            </span>
          ) : null}
        </div>

        <div className="run-filter-field">
          <label htmlFor="run-accepted-after">Accepted after</label>
          <input
            id="run-accepted-after"
            type="datetime-local"
            value={draft.acceptedAfter}
            onChange={(event) => {
              const acceptedAfter = event.currentTarget.value;
              setDraft((current) => ({ ...current, acceptedAfter }));
            }}
            aria-invalid={filterErrors.acceptedRange ? true : undefined}
            aria-describedby={filterErrors.acceptedRange ? "run-accepted-range-error" : undefined}
          />
        </div>

        <div className="run-filter-field">
          <label htmlFor="run-accepted-before">Accepted before</label>
          <input
            id="run-accepted-before"
            type="datetime-local"
            value={draft.acceptedBefore}
            onChange={(event) => {
              const acceptedBefore = event.currentTarget.value;
              setDraft((current) => ({ ...current, acceptedBefore }));
            }}
            aria-invalid={filterErrors.acceptedRange ? true : undefined}
            aria-describedby={filterErrors.acceptedRange ? "run-accepted-range-error" : undefined}
          />
          {filterErrors.acceptedRange ? (
            <span className="run-filter-error" id="run-accepted-range-error" role="alert">
              {filterErrors.acceptedRange}
            </span>
          ) : null}
        </div>

        <div className="run-filter-actions">
          <Button type="submit">Apply filters</Button>
          <Button
            type="button"
            variant="quiet"
            disabled={!hasDraft && !filtered}
            onClick={clearFilters}
          >
            Clear
          </Button>
        </div>
      </form>

      <section
        className="runs-results"
        aria-labelledby="runs-results-heading"
        aria-busy={state.kind === "loading" || refreshing || undefined}
      >
        <div className="runs-results__heading">
          <div>
            <h2 id="runs-results-heading">Run registry</h2>
            <p>Durable invocation state for the active workspace.</p>
          </div>
          <p className="runs-result-count" role="status">{resultLabel(state)}</p>
        </div>

        {refreshError ? (
          <InlineNotice
            title="Live refresh unavailable"
            tone="error"
            action={
              <Button variant="outline" onClick={() => void refreshDurableRuns()}>
                Try refresh again
              </Button>
            }
          >
            <p>{refreshError}</p>
          </InlineNotice>
        ) : null}

        {state.kind === "loading" ? <Skeleton label="Loading runs" lines={6} /> : null}

        {state.kind === "degraded" ? (
          <InlineNotice
            title="Run registry unavailable"
            tone="error"
            action={
              <Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
                Try again
              </Button>
            }
          >
            <p>{state.message}</p>
          </InlineNotice>
        ) : null}

        {state.kind === "not_found" ? (
          <EmptyState
            label="Run registry"
            title="Run collection not found"
            actions={
              <Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
                Check again
              </Button>
            }
          >
            <p>
              The active workspace no longer exposes this run collection. Refresh the
              workspace context, then try again.
            </p>
          </EmptyState>
        ) : null}

        {state.kind === "ok" && state.items.length === 0 && !filtered ? (
          <EmptyState label="Run registry" title="No runs yet">
            <p>
              This workspace has no runs returned by the API. Invoke a published tool
              through a supported client to create one.
            </p>
          </EmptyState>
        ) : null}

        {state.kind === "ok" && state.items.length === 0 && filtered ? (
          <EmptyState
            label="Filtered run registry"
            title="No matching runs"
            actions={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
          >
            <p>No runs match the applied state, tool, and accepted-time filters.</p>
          </EmptyState>
        ) : null}

        {state.kind === "ok" && state.items.length > 0 ? (
          <>
            <div
              className="runs-table-scroll"
              role="region"
              aria-label="Scrollable workspace runs"
              tabIndex={0}
            >
              <table className="runs-table">
                <caption>
                  Runs in the active workspace, {state.items.length}{state.nextCursor === null ? "" : "+"} loaded
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Run</th>
                    <th scope="col">State</th>
                    <th scope="col">Tool</th>
                    <th scope="col">Result</th>
                    <th scope="col">Accepted</th>
                    <th scope="col">Started</th>
                    <th scope="col">Finished</th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((run) => (
                    <tr key={run.id} className={`runs-table__row runs-table__row--${run.status}`}>
                      <th scope="row">
                        <Link
                          className="runs-table__link"
                          to={`/dashboard/runs/${encodeURIComponent(run.id)}`}
                          aria-label={`Open run ${run.id}`}
                        >
                          <code>{run.id}</code>
                        </Link>
                      </th>
                      <td><RunStatusBadge status={run.status} /></td>
                      <td>
                        <strong>{run.tool.name}</strong>
                        <code>{run.tool.key} · v{run.tool.version}</code>
                      </td>
                      <td>{formatCompleteness(run.resultCompleteness)}</td>
                      <td>
                        <time dateTime={run.acceptedAt}>{formatRunTimestamp(run.acceptedAt)}</time>
                      </td>
                      <td>
                        {run.startedAt === null
                          ? "Not started"
                          : <time dateTime={run.startedAt}>{formatRunTimestamp(run.startedAt)}</time>}
                      </td>
                      <td>
                        {run.terminalAt === null
                          ? "Not terminal"
                          : <time dateTime={run.terminalAt}>{formatRunTimestamp(run.terminalAt)}</time>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {paginationError ? (
              <InlineNotice title="More runs unavailable" tone="error">
                <p>{paginationError}</p>
              </InlineNotice>
            ) : null}

            {state.nextCursor !== null ? (
              <div className="runs-pagination">
                <Button
                  variant="outline"
                  pending={loadingMore}
                  pendingLabel="Loading more"
                  onClick={() => void loadMore()}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
