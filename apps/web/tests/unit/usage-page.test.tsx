import axe from "axe-core";
import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { AuthAdapter, RelayIdentity, RelayWorkspace } from "../../src/auth/types";
import { UsagePage } from "../../src/features/usage/UsagePage";
import {
  httpUsageAdapter,
  parseUsageSummaryResponse,
  type UsageAdapter,
  type UsageAdapterResult,
  type UsageSummary,
  type UsageSummaryItem,
  type UsageSummaryRequest,
} from "../../src/lib/api/usage";

const TEST_ONLY_IDENTITY_FIXTURE: RelayIdentity = {
  session: {
    id: "session-usage-fixture-a",
    userId: "user-usage-fixture",
    expiresAt: null,
    activeWorkspaceId: "workspace-usage-fixture",
  },
  user: {
    id: "user-usage-fixture",
    name: "Usage Test Operator",
    email: "usage@example.test",
    image: null,
  },
};

const TEST_ONLY_REPLACEMENT_IDENTITY_FIXTURE: RelayIdentity = {
  ...TEST_ONLY_IDENTITY_FIXTURE,
  session: {
    ...TEST_ONLY_IDENTITY_FIXTURE.session,
    id: "session-usage-fixture-b",
  },
};

const TEST_ONLY_WORKSPACE_FIXTURE: RelayWorkspace = {
  id: "workspace-usage-fixture",
  name: "Usage fixture workspace",
  slug: "usage-fixture",
};

const TEST_ONLY_USAGE_ITEM_FIXTURE: UsageSummaryItem = {
  metric: "fixture.outputs",
  unit: "fixture_unit",
  period: "calendar_month",
  periodStartsAt: "2030-04-01T00:00:00.000Z",
  periodEndsAt: "2030-05-01T00:00:00.000Z",
  consumedAmount: "12.500",
  reservedAmount: "1.250",
};

const TEST_ONLY_SECOND_USAGE_ITEM_FIXTURE: UsageSummaryItem = {
  metric: "fixture.requests",
  unit: "fixture_request",
  period: "calendar_day",
  periodStartsAt: "2030-04-12T00:00:00.000Z",
  periodEndsAt: "2030-04-13T00:00:00.000Z",
  consumedAmount: "7",
  reservedAmount: "0",
};

const TEST_ONLY_USAGE_SUMMARY_FIXTURE: UsageSummary = {
  generatedAt: "2030-04-12T15:30:00.000Z",
  items: [TEST_ONLY_USAGE_ITEM_FIXTURE, TEST_ONLY_SECOND_USAGE_ITEM_FIXTURE],
  truncated: false,
};

function testOnlyUsageAdapter(result: UsageAdapterResult): UsageAdapter {
  return { getSummary: vi.fn().mockResolvedValue(result) };
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function SignInProbe() {
  const location = useLocation();
  return (
    <main>
      <h1>Test-only sign-in boundary</h1>
      <p>{location.search}</p>
    </main>
  );
}

function protectedUsageTree(
  page: React.ReactNode,
  authAdapter: AuthAdapter = createTestAuthAdapter({
    identity: TEST_ONLY_IDENTITY_FIXTURE,
    activeWorkspace: TEST_ONLY_WORKSPACE_FIXTURE,
  }),
) {
  return (
    <MemoryRouter initialEntries={["/dashboard/usage"]}>
      <AuthProvider adapter={authAdapter}>
        <Routes>
          <Route path="/sign-in" element={<SignInProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route
              path="/dashboard/usage"
              element={<main className="product-surface">{page}</main>}
            />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

function renderUsage(
  adapter: UsageAdapter,
  authAdapter?: AuthAdapter,
) {
  return render(protectedUsageTree(<UsagePage adapter={adapter} />, authAdapter));
}

function UsageUnmountHarness({ adapter }: { readonly adapter: UsageAdapter }) {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setVisible(false)}>Remove usage page</button>
      {visible ? <UsagePage adapter={adapter} /> : <p>Usage page removed</p>}
    </>
  );
}

function SessionRefreshHarness({ adapter }: { readonly adapter: UsageAdapter }) {
  const { refreshSession } = useAuth();
  return (
    <>
      <button type="button" onClick={() => void refreshSession()}>
        Replace test session
      </button>
      <UsagePage adapter={adapter} />
    </>
  );
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations).toEqual([]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("usage API adapter", () => {
  it("strictly parses the bounded contract and rejects unsupported or invalid fields", () => {
    expect(parseUsageSummaryResponse({
      kind: "ok",
      usage: TEST_ONLY_USAGE_SUMMARY_FIXTURE,
    })).toEqual({
      kind: "ok",
      usage: TEST_ONLY_USAGE_SUMMARY_FIXTURE,
    });

    expect(() => parseUsageSummaryResponse({
      kind: "ok",
      usage: {
        ...TEST_ONLY_USAGE_SUMMARY_FIXTURE,
        items: [{ ...TEST_ONLY_USAGE_ITEM_FIXTURE, totalAmount: "13.750" }],
      },
    })).toThrow(/totalAmount: is not supported/i);

    expect(() => parseUsageSummaryResponse({
      kind: "ok",
      usage: {
        ...TEST_ONLY_USAGE_SUMMARY_FIXTURE,
        items: [{ ...TEST_ONLY_USAGE_ITEM_FIXTURE, consumedAmount: "01.0" }],
      },
    })).toThrow(/consumedAmount: has an invalid format/i);

    expect(() => parseUsageSummaryResponse({
      kind: "ok",
      usage: {
        ...TEST_ONLY_USAGE_SUMMARY_FIXTURE,
        items: [{
          ...TEST_ONLY_USAGE_ITEM_FIXTURE,
          periodEndsAt: TEST_ONLY_USAGE_ITEM_FIXTURE.periodStartsAt,
        }],
      },
    })).toThrow(/periodStartsAt must precede periodEndsAt/i);
  });

  it("sends only supported filters and degrades an unreadable response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: "ok",
        usage: TEST_ONLY_USAGE_SUMMARY_FIXTURE,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: "ok",
        usage: {
          ...TEST_ONLY_USAGE_SUMMARY_FIXTURE,
          unsupportedField: "test-only",
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpUsageAdapter.getSummary({
      metric: "fixture.outputs",
      period: "calendar_month",
    })).resolves.toEqual({
      kind: "ok",
      usage: TEST_ONLY_USAGE_SUMMARY_FIXTURE,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/usage?metric=fixture.outputs&period=calendar_month",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      cache: "no-store",
      credentials: "include",
    }));

    await expect(httpUsageAdapter.getSummary()).resolves.toEqual({
      kind: "degraded",
      message: "Relay returned an unreadable usage summary. No usage data was shown.",
    });
  });

  it("maps 404 and 401 responses to explicit adapter states", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "not_found", message: "not found" },
      }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "unauthorized", message: "expired" },
      }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpUsageAdapter.getSummary()).resolves.toEqual({
      kind: "not-found",
    });
    await expect(httpUsageAdapter.getSummary()).resolves.toEqual({
      kind: "auth-expired",
    });
  });
});

describe("usage page", () => {
  it("renders exact current consumed and reserved buckets in an axe-clean semantic table", async () => {
    const { container } = renderUsage(testOnlyUsageAdapter({
      kind: "ok",
      usage: TEST_ONLY_USAGE_SUMMARY_FIXTURE,
    }));

    const table = await screen.findByRole("table", {
      name: "Current consumed and reserved usage, 2 active buckets",
    });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
    expect(within(table).getAllByRole("columnheader").map((header) => header.textContent))
      .toEqual(["Metric", "Unit", "Period", "Current window", "Consumed", "Reserved"]);
    expect(within(table).getByText("fixture.outputs")).toBeVisible();
    expect(within(table).getByText("12.500")).toBeVisible();
    expect(within(table).getByText("1.250")).toBeVisible();
    expect(container.querySelector(
      'time[datetime="2030-04-01T00:00:00.000Z"]',
    )).toBeInTheDocument();
    expect(screen.getByText(
      "Receipt and breakdown data is not exposed by the current contract.",
    )).toBeVisible();
    expect(container).not.toHaveTextContent(
      /balance|price|quota|provider cost|billing plan|chart|grand total/i,
    );
    await expectNoAxeViolations(container);
  });

  it("applies metric and period filters and distinguishes a no-match result", async () => {
    const user = userEvent.setup();
    const getSummary = vi.fn(async (request: UsageSummaryRequest = {}) => ({
      kind: "ok" as const,
      usage: request.metric === undefined && request.period === undefined
        ? TEST_ONLY_USAGE_SUMMARY_FIXTURE
        : {
          generatedAt: TEST_ONLY_USAGE_SUMMARY_FIXTURE.generatedAt,
          items: [],
          truncated: false,
        },
    }));
    renderUsage({ getSummary });

    await screen.findByRole("table", {
      name: "Current consumed and reserved usage, 2 active buckets",
    });
    await user.type(screen.getByLabelText("Metric"), "fixture.missing");
    await user.selectOptions(screen.getByLabelText("Period"), "calendar_day");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByRole("heading", {
      name: "No current usage matches these filters",
    })).toBeVisible();
    expect(getSummary).toHaveBeenLastCalledWith(
      { metric: "fixture.missing", period: "calendar_day" },
      expect.any(AbortSignal),
    );
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("names loading, empty, not-found, degraded, and truncated states", async () => {
    const pending = deferred<UsageAdapterResult>();
    const loadingRender = renderUsage({ getSummary: () => pending.promise });

    expect(await screen.findByText("Loading usage summary")).toBeInTheDocument();
    await act(async () => pending.resolve({
      kind: "ok",
      usage: {
        generatedAt: TEST_ONLY_USAGE_SUMMARY_FIXTURE.generatedAt,
        items: [],
        truncated: false,
      },
    }));
    expect(await screen.findByRole("heading", { name: "No current usage" })).toBeVisible();
    loadingRender.unmount();

    const notFoundRender = renderUsage(testOnlyUsageAdapter({ kind: "not-found" }));
    expect(await screen.findByText("Usage summary not found")).toBeVisible();
    notFoundRender.unmount();

    const degradedRender = renderUsage(testOnlyUsageAdapter({
      kind: "degraded",
      message: "Test-only usage service failure. No usage data was shown.",
    }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Usage summary unavailable");
    expect(alert).toHaveTextContent("Test-only usage service failure");
    degradedRender.unmount();

    renderUsage(testOnlyUsageAdapter({
      kind: "ok",
      usage: { ...TEST_ONLY_USAGE_SUMMARY_FIXTURE, truncated: true },
    }));
    expect(await screen.findByText("Usage response truncated")).toBeVisible();
    expect(screen.getByText(/omitted additional metric dimensions/i)).toBeVisible();
  });

  it("expires the owning session when a late 401 arrives after page removal", async () => {
    const user = userEvent.setup();
    const pending = deferred<UsageAdapterResult>();
    const adapter: UsageAdapter = { getSummary: vi.fn(() => pending.promise) };
    render(protectedUsageTree(<UsageUnmountHarness adapter={adapter} />));

    await waitFor(() => expect(adapter.getSummary).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Remove usage page" }));
    expect(screen.getByText("Usage page removed")).toBeVisible();
    await act(async () => pending.resolve({ kind: "auth-expired" }));

    expect(await screen.findByRole("heading", { name: "Test-only sign-in boundary" }))
      .toBeVisible();
    expect(screen.getByText(/reason=session-expired/)).toBeVisible();
  });

  it("does not let an old-session late 401 expire a replacement session", async () => {
    const user = userEvent.setup();
    const pending = deferred<UsageAdapterResult>();
    const getSummary = vi.fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({
        kind: "ok",
        usage: TEST_ONLY_USAGE_SUMMARY_FIXTURE,
      } satisfies UsageAdapterResult);
    const usageAdapter: UsageAdapter = { getSummary };
    const authAdapter = createTestAuthAdapter({
      identity: TEST_ONLY_IDENTITY_FIXTURE,
      activeWorkspace: TEST_ONLY_WORKSPACE_FIXTURE,
    });
    authAdapter.getSession = vi.fn()
      .mockResolvedValueOnce(TEST_ONLY_IDENTITY_FIXTURE)
      .mockResolvedValue(TEST_ONLY_REPLACEMENT_IDENTITY_FIXTURE);

    render(protectedUsageTree(
      <SessionRefreshHarness adapter={usageAdapter} />,
      authAdapter,
    ));

    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Replace test session" }));
    await waitFor(() => expect(getSummary).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("table", {
      name: "Current consumed and reserved usage, 2 active buckets",
    })).toBeVisible();

    await act(async () => pending.resolve({ kind: "auth-expired" }));

    expect(screen.queryByRole("heading", { name: "Test-only sign-in boundary" }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
  });
});
