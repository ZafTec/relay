import axe from "axe-core";
import {
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type {
  AuthAdapter,
  RelayIdentity,
  RelayWorkspace,
} from "../../src/auth/types";
import { RunDetailPage } from "../../src/features/runs/RunDetailPage";
import { RunsPage } from "../../src/features/runs/RunsPage";
import {
  httpRunsAdapter,
  parseCancelRunResponse,
  parseGetRunResponse,
  parseListRunsResponse,
  type CancelRunAdapterResult,
  type GetRunAdapterResult,
  type ListRunsAdapterResult,
  type RunDetail,
  type RunSummary,
  type RunsAdapter,
} from "../../src/lib/api/runs";
import {
  createFetchWorkspaceEventSourceFactory,
  parseResynchronizedEvent,
  parseWorkspaceEventEnvelope,
  type WorkspaceEventConnection,
  type WorkspaceEventEnvelope,
  type WorkspaceEventSourceFactory,
  type WorkspaceEventSourceRequest,
} from "../../src/lib/events";

const RUN_ID = `run_${"1".repeat(32)}`;
const SECOND_RUN_ID = `run_${"2".repeat(32)}`;
const TOOL_VERSION_ID = `tver_${"3".repeat(32)}`;
const OUTPUT_SET_ID = `outset_${"4".repeat(32)}`;
const RESERVATION_ID = `reservation_${"5".repeat(32)}`;
const ARTIFACT_ID = `art_${"6".repeat(32)}`;
const ARTIFACT_VERSION_ID = `aver_${"7".repeat(32)}`;
const ACCEPTED_AT = "2030-01-02T03:04:05.000Z";
const STARTED_AT = "2030-01-02T03:04:06.000Z";
const TERMINAL_AT = "2030-01-02T03:05:06.000Z";

const identity: RelayIdentity = {
  session: {
    id: "session-runs-one",
    userId: "user-runs",
    expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    activeWorkspaceId: "workspace-runs",
  },
  user: {
    id: "user-runs",
    name: "Run Operator",
    email: "runs@example.test",
    image: null,
  },
};

const workspace: RelayWorkspace = {
  id: "workspace-runs",
  name: "Runs workspace",
  slug: "runs",
};

const runningSummary: RunSummary = {
  id: RUN_ID,
  tool: {
    key: "image.generate.fixture",
    name: "Fixture image generator",
    versionId: TOOL_VERSION_ID,
    version: 3,
  },
  status: "running",
  resultCompleteness: "pending",
  acceptedAt: ACCEPTED_AT,
  startedAt: STARTED_AT,
  terminalAt: null,
};

const secondSummary: RunSummary = {
  ...runningSummary,
  id: SECOND_RUN_ID,
  status: "queued",
  resultCompleteness: null,
  startedAt: null,
};

const runningRun: RunDetail = {
  ...runningSummary,
  input: {
    prompt: "test-only lighthouse",
    output_count: 2,
  },
  outputSet: {
    id: OUTPUT_SET_ID,
    requestedCount: 2,
    producedCount: 0,
    completeness: "pending",
    warnings: [],
    items: [
      {
        ordinal: 0,
        name: "primary",
        status: "pending",
        artifactId: null,
        artifactVersionId: null,
        errorCode: null,
      },
      {
        ordinal: 1,
        name: "alternate",
        status: "pending",
        artifactId: null,
        artifactVersionId: null,
        errorCode: null,
      },
    ],
  },
  reservation: {
    id: RESERVATION_ID,
    metric: "images.generated",
    unit: "image",
    amount: "2",
    status: "active",
    expiresAt: "2030-01-02T03:14:05.000Z",
  },
};

const succeededRun: RunDetail = {
  ...runningRun,
  status: "succeeded",
  resultCompleteness: "partial",
  terminalAt: TERMINAL_AT,
  outputSet: {
    id: OUTPUT_SET_ID,
    requestedCount: 2,
    producedCount: 1,
    completeness: "partial",
    warnings: [{ code: "one_output_failed" }],
    items: [
      {
        ordinal: 0,
        name: "primary",
        status: "succeeded",
        artifactId: ARTIFACT_ID,
        artifactVersionId: ARTIFACT_VERSION_ID,
        errorCode: null,
      },
      {
        ordinal: 1,
        name: "alternate",
        status: "failed",
        artifactId: null,
        artifactVersionId: null,
        errorCode: "output_failed",
      },
    ],
  },
  reservation: {
    ...runningRun.reservation!,
    status: "committed",
  },
};

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function createRunsAdapter(overrides: Partial<RunsAdapter> = {}): RunsAdapter {
  return {
    list: vi.fn(async () => ({
      kind: "ok" as const,
      items: [runningSummary],
      nextCursor: null,
    })),
    get: vi.fn(async () => ({ kind: "found" as const, run: runningRun })),
    cancel: vi.fn(async () => ({
      kind: "cancel_requested" as const,
      run: { ...runningRun, status: "cancel_requested" as const },
    })),
    ...overrides,
  };
}

interface EventHarness {
  readonly factory: WorkspaceEventSourceFactory;
  readonly connection: WorkspaceEventConnection;
  request(): WorkspaceEventSourceRequest;
  state(state: Parameters<WorkspaceEventSourceRequest["handlers"]["onState"]>[0]): void;
  event(event: WorkspaceEventEnvelope): void;
  resynchronize(lastEventId?: string | null): void;
  expireAuth(): void;
  accessUnavailable(): void;
}

function createEventHarness(): EventHarness {
  let currentRequest: WorkspaceEventSourceRequest | undefined;
  const connection: WorkspaceEventConnection = {
    close: vi.fn(),
    reconnect: vi.fn(),
  };
  const factory = vi.fn<WorkspaceEventSourceFactory>((request) => {
    currentRequest = request;
    request.handlers.onState({ kind: "connected" });
    return connection;
  });
  const request = () => {
    if (currentRequest === undefined) throw new Error("Event source has not connected.");
    return currentRequest;
  };
  return {
    factory,
    connection,
    request,
    state(nextState) {
      request().handlers.onState(nextState);
    },
    event(event) {
      request().handlers.onEvent(event);
    },
    resynchronize(lastEventId = null) {
      request().handlers.onResynchronized({ lastEventId });
    },
    expireAuth() {
      request().handlers.onAuthExpired();
    },
    accessUnavailable() {
      request().handlers.onAccessUnavailable();
    },
  };
}

function workspaceEvent(
  id: string,
  event: WorkspaceEventEnvelope["event"],
): WorkspaceEventEnvelope {
  return {
    id,
    workspaceId: workspace.id,
    occurredAt: ACCEPTED_AT,
    event,
  };
}

function renderWithAuth(
  page: React.ReactNode,
  initialEntry: string,
  authAdapter: AuthAdapter = createTestAuthAdapter({
    identity,
    activeWorkspace: workspace,
  }),
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider adapter={authAdapter}>
        <main className="product-surface">{page}</main>
      </AuthProvider>
    </MemoryRouter>,
  );
}

function SignInProbe() {
  const location = useLocation();
  return <h1>Sign in {location.search}</h1>;
}

function renderProtected(
  page: React.ReactNode,
  initialEntry: string,
  path: string,
  authAdapter: AuthAdapter = createTestAuthAdapter({
    identity,
    activeWorkspace: workspace,
  }),
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider adapter={authAdapter}>
        <Routes>
          <Route path="/sign-in" element={<SignInProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route path={path} element={page} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations).toEqual([]);
}

function DetailRouteHarness({
  adapter,
  eventSourceFactory,
}: {
  readonly adapter: RunsAdapter;
  readonly eventSourceFactory: WorkspaceEventSourceFactory;
}) {
  const [runId, setRunId] = useState(RUN_ID);
  return (
    <>
      <button type="button" onClick={() => setRunId(SECOND_RUN_ID)}>
        Switch run route
      </button>
      <RunDetailPage
        adapter={adapter}
        eventSourceFactory={eventSourceFactory}
        runId={runId}
      />
    </>
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("run API and event parsing", () => {
  it("strictly rejects unknown fields and impossible output item combinations", () => {
    expect(() => parseListRunsResponse({
      kind: "ok",
      items: [{ ...runningSummary, provider: "invented" }],
      nextCursor: null,
    })).toThrow(/provider: is not supported/i);

    expect(() => parseGetRunResponse({
      kind: "found",
      run: {
        ...succeededRun,
        outputSet: {
          ...succeededRun.outputSet,
          items: [{
            ordinal: 0,
            name: "invalid",
            status: "succeeded",
            artifactId: null,
            artifactVersionId: ARTIFACT_VERSION_ID,
            errorCode: null,
          }],
        },
      },
    })).toThrow(/output item fields do not match its status/i);

    expect(() => parseCancelRunResponse({
      kind: "already_terminal",
      run: { ...succeededRun, extra: true },
    })).toThrow(/extra: is not supported/i);
    expect(() => parseCancelRunResponse({
      kind: "cancel_requested",
      run: runningRun,
    })).toThrow(/does not match the returned run status/i);
  });

  it("strictly parses workspace events and resynchronization markers", () => {
    expect(parseWorkspaceEventEnvelope(workspaceEvent("1", {
      type: "run.status_changed",
      runId: RUN_ID,
      status: "running",
    }))).toEqual(workspaceEvent("1", {
      type: "run.status_changed",
      runId: RUN_ID,
      status: "running",
    }));
    expect(parseResynchronizedEvent({ lastEventId: "1" })).toEqual({ lastEventId: "1" });
    expect(() => parseWorkspaceEventEnvelope({
      ...workspaceEvent("2", { type: "run.created", runId: RUN_ID }),
      progress: 50,
    })).toThrow(/progress: is not supported/i);
    expect(() => parseResynchronizedEvent({ lastEventId: "1", trusted: true }))
      .toThrow(/trusted: is not supported/i);
  });

  it("stops reconnecting when the workspace event endpoint rejects access", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ error: { code: "not_found", message: "not found" } }),
      { status: 404, headers: { "content-type": "application/json" } },
    ));
    const onAccessUnavailable = vi.fn();
    const connection = createFetchWorkspaceEventSourceFactory({
      fetcher,
      reconnectDelayMs: 10,
      staleAfterMs: 100,
    })({
      sessionId: identity.session.id,
      workspaceId: workspace.id,
      handlers: {
        onState: vi.fn(),
        onEvent: vi.fn(),
        onResynchronized: vi.fn(),
        onAuthExpired: vi.fn(),
        onAccessUnavailable,
      },
    });

    await waitFor(() => expect(onAccessUnavailable).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => window.setTimeout(resolve, 25));
    expect(fetcher).toHaveBeenCalledTimes(1);
    connection.close();
  });

  it("encodes supported list filters and never auto-retries cancellation", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: "ok",
        items: [runningSummary],
        nextCursor: "next_cursor",
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpRunsAdapter.list({
      cursor: "cursor_one",
      limit: 25,
      statuses: ["queued", "running"],
      toolKey: "image.generate.fixture",
      acceptedAfter: "2030-01-01T00:00:00.000Z",
      acceptedBefore: "2030-02-01T00:00:00.000Z",
    })).resolves.toEqual({
      kind: "ok",
      items: [runningSummary],
      nextCursor: "next_cursor",
    });

    const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]), "https://relay.test");
    expect(requestUrl.pathname).toBe("/api/v1/runs");
    expect(requestUrl.searchParams.get("cursor")).toBe("cursor_one");
    expect(requestUrl.searchParams.get("limit")).toBe("25");
    expect(requestUrl.searchParams.getAll("statuses")).toEqual(["queued", "running"]);
    expect(requestUrl.searchParams.get("toolKey")).toBe("image.generate.fixture");
    expect(requestUrl.searchParams.get("acceptedAfter")).toBe("2030-01-01T00:00:00.000Z");
    expect(requestUrl.searchParams.get("acceptedBefore")).toBe("2030-02-01T00:00:00.000Z");

    await expect(httpRunsAdapter.cancel(RUN_ID)).resolves.toMatchObject({
      kind: "degraded",
      message: expect.stringMatching(/request was not repeated/i),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/v1/runs/${RUN_ID}/cancel`);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
  });
});

describe("runs list page", () => {
  it("renders a semantic run table, loads another page, and passes axe", async () => {
    const eventHarness = createEventHarness();
    const list = vi.fn()
      .mockResolvedValueOnce({
        kind: "ok" as const,
        items: [runningSummary],
        nextCursor: "next_cursor",
      })
      .mockResolvedValueOnce({
        kind: "ok" as const,
        items: [secondSummary],
        nextCursor: null,
      });
    const { container } = renderWithAuth(
      <RunsPage adapter={createRunsAdapter({ list })} eventSourceFactory={eventHarness.factory} />,
      "/dashboard/runs",
    );

    const table = await screen.findByRole("table", {
      name: "Runs in the active workspace, 1+ loaded",
    });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent))
      .toEqual(["Run", "State", "Tool", "Result", "Accepted", "Started", "Finished"]);
    expect(within(table).getByRole("link", { name: `Open run ${RUN_ID}` }))
      .toHaveAttribute("href", `/dashboard/runs/${RUN_ID}`);
    expect(screen.queryByText(/Halide|Aurora|provider|actor|estimate|settled/i))
      .not.toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByRole("table", {
      name: "Runs in the active workspace, 2 loaded",
    })).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(
      { limit: 25, cursor: "next_cursor" },
      expect.any(AbortSignal),
    );
    await expectNoAxeViolations(container);
  });

  it("applies API-backed filters and distinguishes empty from no-match", async () => {
    const eventHarness = createEventHarness();
    const list = vi.fn(async () => ({
      kind: "ok" as const,
      items: [] as readonly RunSummary[],
      nextCursor: null,
    }));
    const user = userEvent.setup();
    const renderResult = renderWithAuth(
      <RunsPage adapter={createRunsAdapter({ list })} eventSourceFactory={eventHarness.factory} />,
      "/dashboard/runs",
    );

    expect(await screen.findByRole("heading", { name: "No runs yet" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("State"), "failed");
    await user.type(screen.getByLabelText("Tool key"), "image.generate.fixture");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByRole("heading", { name: "No matching runs" })).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(
      {
        limit: 25,
        statuses: ["failed"],
        toolKey: "image.generate.fixture",
      },
      expect.any(AbortSignal),
    );
    renderResult.unmount();
  });

  it("keeps the newest list when an older request resolves late", async () => {
    const eventHarness = createEventHarness();
    const first = deferred<ListRunsAdapterResult>();
    const second = deferred<ListRunsAdapterResult>();
    const list = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const user = userEvent.setup();
    renderWithAuth(
      <RunsPage adapter={createRunsAdapter({ list })} eventSourceFactory={eventHarness.factory} />,
      "/dashboard/runs",
    );

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve({
      kind: "ok",
      items: [secondSummary],
      nextCursor: null,
    }));
    expect(await screen.findByRole("link", { name: `Open run ${SECOND_RUN_ID}` }))
      .toBeInTheDocument();

    await act(async () => first.resolve({ kind: "ok", items: [], nextCursor: null }));
    expect(screen.getByRole("link", { name: `Open run ${SECOND_RUN_ID}` }))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No runs yet" })).not.toBeInTheDocument();
  });

  it("clears pagination pending state when a live resync supersedes it", async () => {
    const eventHarness = createEventHarness();
    const loadMoreResult = deferred<ListRunsAdapterResult>();
    const refreshResult = deferred<ListRunsAdapterResult>();
    const list = vi.fn()
      .mockResolvedValueOnce({
        kind: "ok" as const,
        items: [runningSummary],
        nextCursor: "next_cursor",
      })
      .mockReturnValueOnce(loadMoreResult.promise)
      .mockReturnValueOnce(refreshResult.promise);
    const user = userEvent.setup();
    renderWithAuth(
      <RunsPage adapter={createRunsAdapter({ list })} eventSourceFactory={eventHarness.factory} />,
      "/dashboard/runs",
    );

    await screen.findByRole("link", { name: `Open run ${RUN_ID}` });
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(screen.getByRole("button", { name: "Loading more" })).toBeDisabled();

    act(() => eventHarness.resynchronize());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(screen.getByRole("button", { name: "Load more" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Refreshing" })).toBeDisabled();

    await act(async () => refreshResult.resolve({
      kind: "ok",
      items: [runningSummary],
      nextCursor: "next_cursor",
    }));
    await act(async () => loadMoreResult.resolve({
      kind: "ok",
      items: [secondSummary],
      nextCursor: null,
    }));

    expect(screen.queryByRole("link", { name: `Open run ${SECOND_RUN_ID}` }))
      .not.toBeInTheDocument();
  });

  it("renders degraded and not-found states without partial rows", async () => {
    const firstEvents = createEventHarness();
    const degraded = renderWithAuth(
      <RunsPage
        adapter={createRunsAdapter({
          list: vi.fn(async () => ({
            kind: "degraded" as const,
            message: "Unreadable test response. No rows were changed.",
          })),
        })}
        eventSourceFactory={firstEvents.factory}
      />,
      "/dashboard/runs",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Run registry unavailable");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    degraded.unmount();

    const secondEvents = createEventHarness();
    renderWithAuth(
      <RunsPage
        adapter={createRunsAdapter({ list: vi.fn(async () => ({ kind: "not_found" as const })) })}
        eventSourceFactory={secondEvents.factory}
      />,
      "/dashboard/runs",
    );
    expect(await screen.findByRole("heading", { name: "Run collection not found" }))
      .toBeInTheDocument();
  });

  it("stops reconnecting and refreshes durable context when stream access disappears", async () => {
    const eventHarness = createEventHarness();
    const list = vi.fn(async () => ({
      kind: "ok" as const,
      items: [runningSummary],
      nextCursor: null,
    }));
    renderWithAuth(
      <RunsPage adapter={createRunsAdapter({ list })} eventSourceFactory={eventHarness.factory} />,
      "/dashboard/runs",
    );

    await screen.findByRole("link", { name: `Open run ${RUN_ID}` });
    await waitFor(() => expect(eventHarness.factory).toHaveBeenCalledTimes(1));
    act(() => eventHarness.accessUnavailable());

    expect(screen.getByText("Membership changed · refreshing permissions"))
      .toBeInTheDocument();
    expect(eventHarness.connection.reconnect).not.toHaveBeenCalled();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

describe("run detail page", () => {
  it("renders durable state, input, output, and reservation data without invented facts", async () => {
    const eventHarness = createEventHarness();
    const adapter = createRunsAdapter({
      get: vi.fn(async () => ({ kind: "found" as const, run: succeededRun })),
    });
    const { container } = renderWithAuth(
      <RunDetailPage
        adapter={adapter}
        eventSourceFactory={eventHarness.factory}
        runId={RUN_ID}
      />,
      `/dashboard/runs/${RUN_ID}`,
    );

    expect(await screen.findByRole("heading", { level: 1, name: RUN_ID })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Current state" })).toBeInTheDocument();
    expect(screen.getByLabelText(`Input for ${RUN_ID}`)).toHaveTextContent("test-only lighthouse");
    expect(screen.getByText("images.generated")).toBeInTheDocument();
    expect(screen.getByText("1 produced · 2 requested")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: ARTIFACT_ID })).toHaveAttribute(
      "href",
      `/dashboard/artifacts/${ARTIFACT_ID}`,
    );
    expect(screen.getByRole("link", { name: /Fixture Image Generator/i }))
      .toHaveAttribute("href", "/dashboard/tools/image.generate.fixture");
    expect(screen.getByText("output_failed")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/Halide|Aurora|provider op|actor|idempotency|percentage/i);
    expect(screen.queryByRole("button", { name: "Request cancellation" })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("serializes cancellation and preserves a completion-wins race", async () => {
    const eventHarness = createEventHarness();
    const cancelResult = deferred<CancelRunAdapterResult>();
    const cancel = vi.fn(() => cancelResult.promise);
    const user = userEvent.setup();
    renderWithAuth(
      <RunDetailPage
        adapter={createRunsAdapter({ cancel })}
        eventSourceFactory={eventHarness.factory}
        runId={RUN_ID}
      />,
      `/dashboard/runs/${RUN_ID}`,
    );

    await screen.findByRole("heading", { level: 1, name: RUN_ID });
    const trigger = screen.getByRole("button", { name: "Request cancellation" });
    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Request cancellation?" });
    expect(within(dialog).getByRole("heading", { name: "Request cancellation?" })).toHaveFocus();
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(within(dialog).getByRole("button", { name: "Keep run" })).toHaveFocus();
    await user.keyboard("{Tab}");
    expect(within(dialog).getByRole("button", { name: "Close cancellation dialog" })).toHaveFocus();
    await user.click(within(dialog).getByRole("button", { name: "Request cancellation" }));

    expect(dialog).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Requesting cancellation" })).toBeDisabled();
    expect(cancel).toHaveBeenCalledTimes(1);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);

    await act(async () => cancelResult.resolve({
      kind: "already_terminal",
      run: succeededRun,
    }));
    expect(await screen.findByText("Run already terminal")).toBeInTheDocument();
    expect(screen.getByText(/finished as succeeded before cancellation took effect/i))
      .toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request cancellation" }))
      .not.toBeInTheDocument();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps cancellation pending when it supersedes an in-flight detail refresh", async () => {
    const eventHarness = createEventHarness();
    const refreshResult = deferred<GetRunAdapterResult>();
    const cancelResult = deferred<CancelRunAdapterResult>();
    const get = vi.fn()
      .mockResolvedValueOnce({ kind: "found" as const, run: runningRun })
      .mockReturnValueOnce(refreshResult.promise);
    const cancel = vi.fn(() => cancelResult.promise);
    const user = userEvent.setup();
    renderWithAuth(
      <RunDetailPage
        adapter={createRunsAdapter({ get, cancel })}
        eventSourceFactory={eventHarness.factory}
        runId={RUN_ID}
      />,
      `/dashboard/runs/${RUN_ID}`,
    );

    await screen.findByRole("heading", { level: 1, name: RUN_ID });
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Request cancellation" }));
    const dialog = screen.getByRole("dialog", { name: "Request cancellation?" });
    await user.click(within(dialog).getByRole("button", { name: "Request cancellation" }));

    const refreshSignal = get.mock.calls[1]?.[1];
    expect(refreshSignal).toBeInstanceOf(AbortSignal);
    expect((refreshSignal as AbortSignal).aborted).toBe(true);
    await act(async () => refreshResult.resolve({ kind: "found", run: succeededRun }));
    expect(within(dialog).getByRole("button", { name: "Requesting cancellation" }))
      .toBeDisabled();

    await act(async () => cancelResult.resolve({
      kind: "already_terminal",
      run: succeededRun,
    }));
    expect(await screen.findByText("Run already terminal")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("waits for resync, refetches durable detail, and reconnects after permission changes", async () => {
    const eventHarness = createEventHarness();
    const get = vi.fn()
      .mockResolvedValueOnce({ kind: "found" as const, run: runningRun })
      .mockResolvedValueOnce({ kind: "found" as const, run: runningRun })
      .mockResolvedValueOnce({ kind: "found" as const, run: succeededRun })
      .mockResolvedValue({ kind: "found" as const, run: succeededRun });
    renderWithAuth(
      <RunDetailPage
        adapter={createRunsAdapter({ get })}
        eventSourceFactory={eventHarness.factory}
        runId={RUN_ID}
      />,
      `/dashboard/runs/${RUN_ID}`,
    );

    expect((await screen.findAllByText("Running")).length).toBeGreaterThan(0);
    await waitFor(() => expect(eventHarness.factory).toHaveBeenCalledTimes(1));
    act(() => eventHarness.state({ kind: "reconnecting", attempt: 2 }));
    expect(screen.getByText("Reconnecting · attempt 2")).toBeInTheDocument();

    act(() => eventHarness.event(workspaceEvent("1", {
      type: "run.status_changed",
      runId: RUN_ID,
      status: "failed",
    })));
    expect(get).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);

    act(() => eventHarness.resynchronize("1"));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Resynchronized · durable state refreshed")).toBeInTheDocument();
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);

    act(() => eventHarness.event(workspaceEvent("2", {
      type: "run.status_changed",
      runId: RUN_ID,
      status: "failed",
    })));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    expect((await screen.findAllByText("Succeeded")).length).toBeGreaterThan(0);
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();

    act(() => eventHarness.event(workspaceEvent("3", {
      type: "session.permission_changed",
      reason: "role_changed",
    })));
    expect(eventHarness.connection.reconnect).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(get.mock.calls.length).toBeGreaterThanOrEqual(4));
  });

  it("ignores a detail response that resolves after the route changes", async () => {
    const eventHarness = createEventHarness();
    const first = deferred<GetRunAdapterResult>();
    const secondRun: RunDetail = { ...runningRun, id: SECOND_RUN_ID, status: "queued" };
    const get = vi.fn((requestedRunId: string) => requestedRunId === RUN_ID
      ? first.promise
      : Promise.resolve({ kind: "found" as const, run: secondRun }));
    const user = userEvent.setup();
    renderWithAuth(
      <DetailRouteHarness
        adapter={createRunsAdapter({ get })}
        eventSourceFactory={eventHarness.factory}
      />,
      `/dashboard/runs/${RUN_ID}`,
    );

    await waitFor(() => expect(get).toHaveBeenCalledWith(RUN_ID, expect.any(AbortSignal)));
    await user.click(screen.getByRole("button", { name: "Switch run route" }));
    expect(await screen.findByRole("heading", { level: 1, name: SECOND_RUN_ID }))
      .toBeInTheDocument();

    await act(async () => first.resolve({ kind: "found", run: runningRun }));
    expect(screen.getByRole("heading", { level: 1, name: SECOND_RUN_ID }))
      .toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: RUN_ID })).not.toBeInTheDocument();
  });

  it("renders malformed IDs as not found without requesting them", async () => {
    const eventHarness = createEventHarness();
    const adapter = createRunsAdapter();
    renderWithAuth(
      <RunDetailPage
        adapter={adapter}
        eventSourceFactory={eventHarness.factory}
        runId="not-a-run"
      />,
      "/dashboard/runs/not-a-run",
    );

    expect(await screen.findByRole("heading", { name: "Run not found" })).toBeInTheDocument();
    expect(adapter.get).not.toHaveBeenCalled();
  });
});

describe("run session ownership", () => {
  function SessionController() {
    const { refreshSession, session } = useAuth();
    return (
      <div>
        <button type="button" onClick={() => void refreshSession()}>Switch session</button>
        <output aria-label="Current session">
          {session.status === "authenticated" ? session.identity.session.id : session.status}
        </output>
      </div>
    );
  }

  it("does not let a late 401 from an old page expire the replacement session", async () => {
    const secondIdentity: RelayIdentity = {
      ...identity,
      session: { ...identity.session, id: "session-runs-two" },
    };
    let sessionRead = 0;
    const baseAuth = createTestAuthAdapter({ identity, activeWorkspace: workspace });
    const authAdapter: AuthAdapter = {
      ...baseAuth,
      getSession: vi.fn(async () => {
        sessionRead += 1;
        return sessionRead === 1 ? identity : secondIdentity;
      }),
    };
    const firstList = deferred<ListRunsAdapterResult>();
    let listRead = 0;
    const list = vi.fn(() => {
      listRead += 1;
      return listRead === 1
        ? firstList.promise
        : Promise.resolve({
            kind: "ok" as const,
            items: [secondSummary],
            nextCursor: null,
          });
    });
    const eventHarness = createEventHarness();

    render(
      <MemoryRouter initialEntries={["/dashboard/runs"]}>
        <AuthProvider adapter={authAdapter}>
          <SessionController />
          <Routes>
            <Route path="/sign-in" element={<SignInProbe />} />
            <Route element={<ProtectedRoute />}>
              <Route
                path="/dashboard/runs"
                element={
                  <RunsPage
                    adapter={createRunsAdapter({ list })}
                    eventSourceFactory={eventHarness.factory}
                  />
                }
              />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await userEvent.setup().click(screen.getByRole("button", { name: "Switch session" }));
    expect(await screen.findByLabelText("Current session")).toHaveTextContent("session-runs-two");
    expect(await screen.findByRole("link", { name: `Open run ${SECOND_RUN_ID}` }))
      .toBeInTheDocument();

    await act(async () => firstList.resolve({ kind: "auth-expired" }));
    expect(screen.getByLabelText("Current session")).toHaveTextContent("session-runs-two");
    expect(screen.queryByRole("heading", { name: /Sign in/i })).not.toBeInTheDocument();
  });

  it("expires the owning session when the run adapter returns 401", async () => {
    const eventHarness = createEventHarness();
    renderProtected(
      <RunsPage
        adapter={createRunsAdapter({
          list: vi.fn(async () => ({ kind: "auth-expired" as const })),
        })}
        eventSourceFactory={eventHarness.factory}
      />,
      "/dashboard/runs",
      "/dashboard/runs",
    );

    expect(await screen.findByRole("heading", { name: /Sign in .*reason=session-expired/i }))
      .toBeInTheDocument();
  });
});
