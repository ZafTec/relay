import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App, createRelayMemoryRouter } from "../../src/app/App";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { RelayIdentity, RelayWorkspace } from "../../src/auth/types";

const identity: RelayIdentity = {
  session: { id: "s", userId: "u", expiresAt: null, activeWorkspaceId: "w" },
  user: { id: "u", name: "Test Operator", email: "operator@example.test", image: null },
};
const workspace: RelayWorkspace = { id: "w", name: "Operator workspace", slug: "operator" };

describe("dashboard state boundaries", () => {
  it("renders a degraded state when the real API adapter cannot connect", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    render(
      <App
        router={createRelayMemoryRouter(["/dashboard"])}
        adapter={createTestAuthAdapter({ identity, activeWorkspace: workspace })}
      />,
    );

    expect(await screen.findByText("Overview unavailable")).toBeInTheDocument();
    expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
  });

  it("redirects when the overview API reports an expired session", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "unauthorized", message: "expired" } }),
      { status: 401, headers: { "content-type": "application/json" } },
    )));
    const router = createRelayMemoryRouter(["/dashboard"]);
    render(
      <App
        router={router}
        adapter={createTestAuthAdapter({ identity, activeWorkspace: workspace })}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Sign in to Relay" })).toBeInTheDocument();
    expect(router.state.location.search).toContain("reason=session-expired");
  });
});
