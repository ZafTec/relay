import axe from "axe-core";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { AuthAdapter, RelayIdentity, RelayWorkspace } from "../../src/auth/types";
import { SettingsPage } from "../../src/features/settings/SettingsPage";

const SETTINGS_IDENTITY_FIXTURE: RelayIdentity = {
  session: {
    id: "session-settings-fixture",
    userId: "user-settings-fixture",
    expiresAt: new Date("2031-04-12T15:30:00.000Z"),
    activeWorkspaceId: "workspace-northstar-fixture",
  },
  user: {
    id: "user-settings-fixture",
    name: "Morgan Lee",
    email: "morgan@example.test",
    image: null,
  },
};

const SETTINGS_WORKSPACE_FIXTURE: RelayWorkspace = {
  id: "workspace-northstar-fixture",
  name: "Northstar fixture workspace",
  slug: "northstar-fixture",
};

function renderSettings(adapter: AuthAdapter) {
  return render(
    <MemoryRouter initialEntries={["/dashboard/settings"]}>
      <AuthProvider adapter={adapter}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route
              path="/dashboard/settings"
              element={(
                <main className="product-surface">
                  <SettingsPage />
                </main>
              )}
            />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("workspace settings page", () => {
  it("renders real ready-state facts and the implemented MCP contract without editable data", async () => {
    const { container } = renderSettings(createTestAuthAdapter({
      identity: SETTINGS_IDENTITY_FIXTURE,
      activeWorkspace: SETTINGS_WORKSPACE_FIXTURE,
    }));

    expect(await screen.findByRole("heading", { level: 1, name: "Workspace settings" }))
      .toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    const workspaceSection = screen.getByRole("region", { name: "Active workspace" });
    expect(within(workspaceSection).getByText("Northstar fixture workspace")).toBeInTheDocument();
    expect(within(workspaceSection).getByText("northstar-fixture")).toBeInTheDocument();
    expect(within(workspaceSection).getByText("workspace-northstar-fixture")).toBeInTheDocument();
    expect(within(workspaceSection).getByText("Current")).toBeInTheDocument();

    const sessionSection = screen.getByRole("region", { name: "Current session" });
    expect(within(sessionSection).getByText("Morgan Lee")).toBeInTheDocument();
    expect(within(sessionSection).getByText("morgan@example.test")).toBeInTheDocument();
    expect(sessionSection.querySelector('time[datetime="2031-04-12T15:30:00.000Z"]'))
      .toBeInTheDocument();

    const mcpSection = screen.getByRole("region", { name: "MCP connection" });
    expect(within(mcpSection).getByText("POST /mcp")).toBeInTheDocument();
    expect(within(mcpSection).getByText("/.well-known/oauth-protected-resource/mcp"))
      .toBeInTheDocument();
    expect(within(mcpSection).getByText(/browser session cookies alone are rejected/i))
      .toBeInTheDocument();

    expect(within(mcpSection).getByText("Contract defined")).toBeInTheDocument();
    expect(within(mcpSection).getByText(/without claiming that every deployment/i))
      .toBeInTheDocument();
    const scopeTable = within(mcpSection).getByRole("table", {
      name: "Supported MCP authorization scopes",
    });
    for (const scope of [
      "tools:read",
      "tools:execute",
      "runs:read",
      "runs:cancel",
      "artifacts:read",
      "artifacts:write",
      "artifacts:share",
      "usage:read",
    ]) {
      expect(within(scopeTable).getByText(scope)).toBeInTheDocument();
    }

    expect(container.querySelector("input, select, textarea")).not.toBeInTheDocument();
    expect(screen.queryByText(/Halide XL|Aurora Fast|Claude MCP client|CI pipeline/i))
      .not.toBeInTheDocument();
    expect(screen.queryByText(/API key|billing plan|member count/i)).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("shows workspace loading before resolving the explicit fixture", async () => {
    let resolveWorkspace!: (workspace: RelayWorkspace | null) => void;
    const pendingWorkspace = new Promise<RelayWorkspace | null>((resolve) => {
      resolveWorkspace = resolve;
    });
    const adapter = createTestAuthAdapter({
      identity: SETTINGS_IDENTITY_FIXTURE,
      activeWorkspace: SETTINGS_WORKSPACE_FIXTURE,
    });
    adapter.getActiveWorkspace = vi.fn().mockReturnValueOnce(pendingWorkspace);

    renderSettings(adapter);

    expect(await screen.findByText("Loading active workspace")).toBeInTheDocument();
    expect(screen.getByText("Resolving active workspace")).toBeInTheDocument();

    await act(async () => {
      resolveWorkspace(SETTINGS_WORKSPACE_FIXTURE);
      await pendingWorkspace;
    });

    expect(await screen.findByText("Northstar fixture workspace")).toBeInTheDocument();
    expect(adapter.getActiveWorkspace).toHaveBeenCalledTimes(1);
  });

  it("shows an honest empty state when the session has no active workspace", async () => {
    const identityWithoutWorkspace: RelayIdentity = {
      ...SETTINGS_IDENTITY_FIXTURE,
      session: {
        ...SETTINGS_IDENTITY_FIXTURE.session,
        activeWorkspaceId: null,
      },
    };

    renderSettings(createTestAuthAdapter({
      identity: identityWithoutWorkspace,
      activeWorkspace: null,
    }));

    expect(await screen.findByText("No active workspace is attached to this session.", {
      exact: false,
    })).toBeInTheDocument();
    expect(screen.getByText("No active workspace selected")).toBeInTheDocument();
    expect(screen.getByText("No active workspace", { selector: ".settings-mcp__binding strong" }))
      .toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry workspace" })).not.toBeInTheDocument();
  });

  it("reports degraded workspace context and retries through AuthProvider", async () => {
    const user = userEvent.setup();
    const adapter = createTestAuthAdapter({
      identity: SETTINGS_IDENTITY_FIXTURE,
      activeWorkspace: SETTINGS_WORKSPACE_FIXTURE,
    });
    adapter.getActiveWorkspace = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(SETTINGS_WORKSPACE_FIXTURE);

    renderSettings(adapter);

    expect(await screen.findByText("Workspace settings unavailable")).toBeInTheDocument();
    expect(screen.getByText(/No workspace was changed/i)).toBeInTheDocument();
    expect(screen.getByText("Workspace unavailable", { selector: ".settings-mcp__binding strong" }))
      .toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry workspace" }));

    expect(await screen.findByText("Northstar fixture workspace")).toBeInTheDocument();
    expect(adapter.getActiveWorkspace).toHaveBeenCalledTimes(2);
  });
});
