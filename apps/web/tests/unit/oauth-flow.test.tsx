import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App, createRelayMemoryRouter } from "../../src/app/App";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { RelayIdentity, RelayWorkspace } from "../../src/auth/types";

const workspace: RelayWorkspace = {
  id: "workspace-oauth",
  name: "OAuth workspace",
  slug: "oauth-workspace",
};

const identity: RelayIdentity = {
  session: {
    id: "session-oauth",
    userId: "user-oauth",
    expiresAt: null,
    activeWorkspaceId: workspace.id,
  },
  user: {
    id: "user-oauth",
    name: "OAuth Operator",
    email: "oauth.operator@example.test",
    image: null,
  },
};

describe("MCP OAuth screens", () => {
  it("submits consent through the Better Auth adapter with requested scopes", async () => {
    const user = userEvent.setup();
    const adapter = createTestAuthAdapter({
      identity,
      activeWorkspace: workspace,
      oauthClient: { id: "client", name: "CLI client", uri: null },
    });
    adapter.submitOAuthConsent = vi.fn().mockResolvedValue(undefined);

    render(
      <App
        adapter={adapter}
        router={createRelayMemoryRouter([
          "/oauth/consent?client_id=client&scope=openid%20mcp%3Atools",
        ])}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Authorize client" }, { timeout: 5000 }));
    expect(adapter.submitOAuthConsent).toHaveBeenCalledWith({
      accept: true,
      scope: "openid mcp:tools",
    });
  });

  it("retries a failed workspace list without also showing an empty state", async () => {
    const user = userEvent.setup();
    const adapter = createTestAuthAdapter({
      identity,
      activeWorkspace: workspace,
      workspaces: [workspace],
    });
    adapter.listWorkspaces = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce([workspace]);

    render(
      <App
        adapter={adapter}
        router={createRelayMemoryRouter(["/oauth/workspace?oauth_query=signed"])}
      />,
    );

    expect(await screen.findByText("Workspace selection unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No eligible workspace")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry workspace list" }));

    expect(await screen.findByRole("radio", { name: /OAuth workspace/ })).toBeChecked();
    expect(adapter.listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("continues with the already-active workspace without exposing a switcher mutation", async () => {
    const user = userEvent.setup();
    const adapter = createTestAuthAdapter({
      identity,
      activeWorkspace: workspace,
      workspaces: [workspace],
    });
    adapter.setActiveWorkspace = vi.fn().mockResolvedValue(undefined);
    adapter.continueOAuthWorkspace = vi.fn().mockResolvedValue(undefined);

    render(
      <App
        adapter={adapter}
        router={createRelayMemoryRouter(["/oauth/workspace?oauth_query=signed"])}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Continue with workspace" }));
    expect(adapter.setActiveWorkspace).not.toHaveBeenCalled();
    expect(adapter.continueOAuthWorkspace).toHaveBeenCalledOnce();
  });
});
