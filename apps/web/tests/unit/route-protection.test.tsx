import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, createRelayMemoryRouter } from "../../src/app/App";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import { AuthAdapterError, type RelayIdentity, type RelayWorkspace } from "../../src/auth/types";

const identity: RelayIdentity = {
  session: {
    id: "session-test",
    userId: "user-test",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    activeWorkspaceId: "workspace-test",
  },
  user: {
    id: "user-test",
    name: "Relay Tester",
    email: "relay.tester@example.test",
    image: null,
  },
};

const workspace: RelayWorkspace = {
  id: "workspace-test",
  name: "Relay test workspace",
  slug: "workspace-test",
};

function mockPublicEndpoints() {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
    const path = String(input);
    if (path === "/api/v1/changelog") {
      return new Response(JSON.stringify({ entries: [], nextCursor: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/health/ready") {
      return new Response(JSON.stringify({ service: "api", status: "ok", checks: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/version") {
      return new Response(JSON.stringify({ version: "test", revision: "test-revision" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected request: ${path}`);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("protected routing", () => {
  it("redirects an anonymous dashboard request and preserves its local return path", async () => {
    const router = createRelayMemoryRouter(["/dashboard?view=current"]);
    render(<App router={router} adapter={createTestAuthAdapter({ identity: null })} />);

    expect(await screen.findByRole("heading", { name: "Sign in to Relay" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toContain("returnTo=%2Fdashboard%3Fview%3Dcurrent");
  });

  it("protects profile and preserves it as the return path", async () => {
    const router = createRelayMemoryRouter(["/profile"]);
    render(<App router={router} adapter={createTestAuthAdapter({ identity: null })} />);

    expect(await screen.findByRole("heading", { name: "Sign in to Relay" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sign-in");
    expect(router.state.location.search).toContain("returnTo=%2Fprofile");
  });

  it("expires the protected route when workspace loading receives a 401", async () => {
    const adapter = createTestAuthAdapter({ identity, activeWorkspace: workspace });
    adapter.getActiveWorkspace = vi.fn().mockRejectedValue(
      new AuthAdapterError("unauthorized", { status: 401 }),
    );
    const router = createRelayMemoryRouter(["/profile"]);

    render(<App router={router} adapter={adapter} />);

    expect(await screen.findByRole("heading", { name: "Sign in to Relay" })).toBeInTheDocument();
    expect(router.state.location.search).toContain("reason=session-expired");
  });

  it("marks a previously authenticated anonymous session as expired", async () => {
    sessionStorage.setItem("relay.authenticated", "true");
    const router = createRelayMemoryRouter(["/dashboard"]);
    render(<App router={router} adapter={createTestAuthAdapter({ identity: null })} />);

    expect(await screen.findByText("Session expired")).toBeInTheDocument();
    expect(router.state.location.search).toContain("reason=session-expired");
  });

  it("labels unavailable providers and lets the user retry a degraded session check", async () => {
    const user = userEvent.setup();
    const adapter = createTestAuthAdapter({ identity: null });
    adapter.getSession = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(null);

    render(<App router={createRelayMemoryRouter(["/sign-in"])} adapter={adapter} />);

    expect(await screen.findByRole("button", { name: "Google unavailable" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "GitHub unavailable" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Retry session check" }));

    expect(await screen.findByRole("button", { name: "Continue with Google" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
    expect(adapter.getSession).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["/changelog", "Changelog"],
    ["/docs", "Quickstart"],
    ["/status", "All reported checks operational"],
  ])("renders public route %s without authentication", async (path, heading) => {
    mockPublicEndpoints();
    const router = createRelayMemoryRouter([path]);

    render(<App router={router} adapter={createTestAuthAdapter({ identity: null })} />);

    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(path);
  });

  it("renders the protected dashboard with real adapter data and no invented counts", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ name: "Relay", status: "ok" }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));
    const router = createRelayMemoryRouter(["/dashboard"]);
    render(
      <App
        router={router}
        adapter={createTestAuthAdapter({ identity, activeWorkspace: workspace })}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(await screen.findByText("No overview data is exposed yet")).toBeInTheDocument();
    expect(screen.getAllByText("Relay test workspace").length).toBeGreaterThan(0);
    expect(screen.getByText("Not requested")).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.pathname).toBe("/dashboard"));
  });
});
