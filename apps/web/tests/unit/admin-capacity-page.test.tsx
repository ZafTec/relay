import axe from "axe-core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, createRelayMemoryRouter } from "../../src/app/App";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { RelayIdentity, RelayWorkspace } from "../../src/auth/types";
import { AdminCapacityPage } from "../../src/features/admin-capacity";
import type {
  AdminCapacityAdapter,
  AdminCapacityPolicy,
  ListAdminCapacityPoliciesResult,
} from "../../src/lib/api/admin-capacity";

const SCOPE_TYPE = "tool";
const SCOPE_ID = "tool_0123456789abcdef0123456789abcdef";
const EFFECTIVE_AT = "2026-08-26T10:00:00.000Z";

const identity: RelayIdentity = {
  session: {
    id: "session-capacity",
    userId: "user-admin",
    expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    activeWorkspaceId: "workspace-admin",
  },
  user: {
    id: "user-admin",
    name: "Morgan Lee",
    email: "morgan@example.test",
    image: null,
  },
};

const workspace: RelayWorkspace = {
  id: "workspace-admin",
  name: "Admin test workspace",
  slug: "admin-test",
};

function capacityPolicy(overrides: Partial<AdminCapacityPolicy> = {}): AdminCapacityPolicy {
  const configuration = overrides.configuration ?? {
    leaseDefaults: { maxRunning: 50 },
    submissionRateDefaults: {
      providerPerMinute: 12,
      workspacePerProviderPerMinute: 4,
    },
    extensions: {
      futureControl: { enabled: true, strategy: "measured" },
    },
  };
  return {
    policyId: "42",
    scopeType: SCOPE_TYPE,
    scopeId: SCOPE_ID,
    revision: 1,
    configuration,
    canonicalJson: JSON.stringify(configuration),
    immutableHash: "a".repeat(64),
    effectiveAt: EFFECTIVE_AT,
    expiresAt: null,
    ...overrides,
  };
}

function capacityAdapter(overrides: Partial<AdminCapacityAdapter> = {}): AdminCapacityAdapter {
  return {
    list: vi.fn(async () => ({ kind: "ok", policies: [capacityPolicy()] })),
    get: vi.fn(async () => ({ kind: "found", policy: capacityPolicy() })),
    revise: vi.fn(async () => ({
      kind: "revised",
      value: capacityPolicy({ policyId: "43", revision: 2 }),
      replayed: false,
    })),
    ...overrides,
  };
}

function deferred<Result>() {
  let resolve!: (value: Result) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Result>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function renderCapacity(adapter: AdminCapacityAdapter) {
  return render(
    <MemoryRouter>
      <AdminCapacityPage adapter={adapter} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("admin capacity policy UI", () => {
  it("renders loading, raw policy coordinates, and values derived from stored JSON", async () => {
    const pending = deferred<ListAdminCapacityPoliciesResult>();
    const adapter = capacityAdapter({ list: vi.fn(() => pending.promise) });
    const { container } = renderCapacity(adapter);

    expect(screen.getByRole("heading", { name: "Loading capacity policies" })).toBeInTheDocument();
    await act(async () => pending.resolve({ kind: "ok", policies: [capacityPolicy()] }));

    const table = await screen.findByRole("table", { name: "Current capacity policies" });
    expect(within(table).getByText(SCOPE_ID)).toBeInTheDocument();
    expect(within(table).getByText("r1")).toBeInTheDocument();
    expect(within(table).getByText(EFFECTIVE_AT)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Policy detail" })).toBeInTheDocument();

    const storedValues = screen.getByRole("heading", { name: "Values from stored JSON" }).parentElement?.parentElement;
    expect(storedValues).toBeTruthy();
    expect(within(storedValues as HTMLElement).getByText("12")).toBeInTheDocument();
    expect(within(storedValues as HTMLElement).getByText("4")).toBeInTheDocument();
    expect(within(storedValues as HTMLElement).getByText("50")).toBeInTheDocument();
    expect((screen.getByRole("textbox", { name: "Complete policy JSON" }) as HTMLTextAreaElement).value)
      .toContain('"futureControl"');
    const accessibility = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(accessibility.violations).toEqual([]);
  });

  it("filters by exact scope and requests full revision history", async () => {
    const list = vi.fn(async () => ({ kind: "ok" as const, policies: [capacityPolicy()] }));
    const user = userEvent.setup();
    renderCapacity(capacityAdapter({ list }));
    await screen.findByRole("heading", { name: "Policy detail" });

    await user.type(screen.getByRole("textbox", { name: "Scope type" }), SCOPE_TYPE);
    await user.type(screen.getByRole("textbox", { name: "Raw scope ID" }), SCOPE_ID);
    await user.selectOptions(screen.getByRole("combobox", { name: "Revision view" }), "history");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => expect(list).toHaveBeenLastCalledWith({
      scopeType: SCOPE_TYPE,
      scopeId: SCOPE_ID,
      includeHistory: true,
      limit: 200,
    }, expect.any(AbortSignal)));
    expect(await screen.findByRole("table", { name: "Capacity policy revision history" }))
      .toBeInTheDocument();
  });

  it("preserves the complete configuration and reuses the exact request after an unknown outcome", async () => {
    const revisedPolicy = capacityPolicy({ policyId: "43", revision: 2 });
    const revise = vi.fn()
      .mockResolvedValueOnce({
        kind: "unknown-outcome" as const,
        message: "The write may have completed.",
        retryable: true as const,
        retryMode: "exact-request" as const,
        retryAfterSeconds: null,
      })
      .mockResolvedValueOnce({
        kind: "revised" as const,
        value: revisedPolicy,
        replayed: true,
      });
    const user = userEvent.setup();
    renderCapacity(capacityAdapter({ revise }));
    await screen.findByRole("heading", { name: "Policy detail" });

    await user.click(screen.getByRole("button", { name: "Create revision" }));
    expect(await screen.findByText("Revision outcome unknown")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Complete policy JSON" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Scope type" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply filters" })).toBeDisabled();

    const firstCall = revise.mock.calls[0];
    expect(firstCall?.[2]).toMatchObject({
      expectedRevision: 1,
      configuration: {
        extensions: { futureControl: { enabled: true, strategy: "measured" } },
      },
    });
    expect(firstCall?.[3]).toMatch(/^capacity:revise:/);

    await user.click(screen.getByRole("button", { name: "Retry exact request" }));
    expect(await screen.findByText("Replay confirmed")).toBeInTheDocument();
    expect(screen.getByText(/no duplicate revision was created/i)).toBeInTheDocument();
    expect(revise).toHaveBeenCalledTimes(2);
    expect(revise.mock.calls[1]?.slice(0, 4)).toEqual(firstCall?.slice(0, 4));
  });

  it("refreshes and rehydrates the latest complete policy after a revision conflict", async () => {
    const latest = capacityPolicy({
      policyId: "43",
      revision: 2,
      immutableHash: "b".repeat(64),
      configuration: {
        leaseDefaults: { maxRunning: 61 },
        extensions: { serverAdded: { retained: true } },
      },
    });
    const list = vi.fn()
      .mockResolvedValueOnce({ kind: "ok" as const, policies: [capacityPolicy()] })
      .mockResolvedValueOnce({ kind: "ok" as const, policies: [latest] });
    const revise = vi.fn(async () => ({ kind: "revision-conflict" as const, actualRevision: 2 }));
    const user = userEvent.setup();
    renderCapacity(capacityAdapter({ list, revise }));
    await screen.findByRole("heading", { name: "Policy detail" });

    await user.click(screen.getByRole("button", { name: "Create revision" }));

    expect(await screen.findByText("Revision conflict")).toBeInTheDocument();
    expect(screen.getByText(/latest policy was refreshed/i)).toBeInTheDocument();
    expect(screen.getByText("SELECTED / R2")).toBeInTheDocument();
    expect((screen.getByRole("textbox", { name: "Complete policy JSON" }) as HTMLTextAreaElement).value)
      .toContain('"serverAdded"');
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("surfaces an idempotency conflict without retrying automatically", async () => {
    const revise = vi.fn(async () => ({ kind: "idempotency-conflict" as const }));
    const user = userEvent.setup();
    renderCapacity(capacityAdapter({ revise }));
    await screen.findByRole("heading", { name: "Policy detail" });

    await user.click(screen.getByRole("button", { name: "Create revision" }));

    expect(await screen.findByText("Idempotency key conflict")).toBeInTheDocument();
    expect(screen.getByText(/submit a new request to generate a new key/i)).toBeInTheDocument();
    expect(revise).toHaveBeenCalledOnce();
  });

  it("validates bounded object JSON before sending a revision", async () => {
    const revise = vi.fn();
    const user = userEvent.setup();
    renderCapacity(capacityAdapter({ revise }));
    const editor = await screen.findByRole("textbox", { name: "Complete policy JSON" });

    fireEvent.change(editor, { target: { value: "[]" } });
    await user.click(screen.getByRole("button", { name: "Create revision" }));

    expect(screen.getByText("Policy JSON must have an object at its root.")).toBeInTheDocument();
    expect(revise).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "ok" as const, policies: [] }, "No capacity policies found"],
    [{ kind: "degraded" as const, message: "Capacity service unavailable." }, "Capacity policies unavailable"],
    [{ kind: "denied" as const }, "Capacity access denied"],
    [{ kind: "reauthentication-required" as const }, "Reauthentication required"],
    [{ kind: "auth-expired" as const }, "Reauthentication required"],
  ])("renders the %s read state", async (result, heading) => {
    renderCapacity(capacityAdapter({ list: vi.fn(async () => result) }));
    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
  });
});

describe("admin capacity route", () => {
  it("renders at /admin/capacity and exposes the superadmin navigation entry", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path.startsWith("/api/v1/admin/changelog")) {
        return new Response(JSON.stringify({ releases: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.startsWith("/api/v1/admin/capacity-policies")) {
        return new Response(JSON.stringify({ policies: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    }));
    const router = createRelayMemoryRouter(["/admin/capacity"]);

    render(
      <App
        router={router}
        adapter={createTestAuthAdapter({ identity, activeWorkspace: workspace })}
      />,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Capacity policies" }, { timeout: 5_000 }))
      .toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Capacity" })).not.toHaveLength(0);
    expect(router.state.location.pathname).toBe("/admin/capacity");
  });
});
