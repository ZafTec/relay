import axe from "axe-core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { AuthAdapter, RelayIdentity, RelayWorkspace } from "../../src/auth/types";
import { ProfilePage } from "../../src/features/profile/ProfilePage";

const identity: RelayIdentity = {
  session: {
    id: "session-profile",
    userId: "user-profile",
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    activeWorkspaceId: "workspace-atlas",
  },
  user: {
    id: "user-profile",
    name: "Avery Torres",
    email: "avery@example.test",
    image: "https://images.example.test/avery.png",
  },
};

const workspace: RelayWorkspace = {
  id: "workspace-atlas",
  name: "Atlas workspace",
  slug: "atlas",
};

function renderProfile(adapter: AuthAdapter) {
  return render(
    <MemoryRouter initialEntries={["/profile"]}>
      <AuthProvider adapter={adapter}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/profile" element={<ProfilePage />} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("profile page", () => {
  it("renders only OAuth identity, current session, and active workspace facts", async () => {
    const { container } = renderProfile(createTestAuthAdapter({
      identity,
      activeWorkspace: workspace,
    }));

    expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Avery Torres" })).toBeInTheDocument();
    expect(screen.getByText("avery@example.test")).toBeInTheDocument();
    expect(screen.getByText("OAuth provider")).toBeInTheDocument();

    const avatar = screen.getByRole("img", { name: "Profile image for Avery Torres" });
    expect(avatar.querySelector("img")).toHaveAttribute("src", identity.user.image);

    expect(screen.getByText("Atlas workspace")).toBeInTheDocument();
    expect(screen.getByText("atlas")).toBeInTheDocument();
    expect(screen.getByText("workspace-atlas")).toBeInTheDocument();

    const expiry = container.querySelector('time[datetime="2030-01-01T00:00:00.000Z"]');
    expect(expiry).toBeInTheDocument();
    expect(expiry).not.toHaveTextContent("");

    expect(screen.getByRole("heading", { name: "No Relay password" })).toBeInTheDocument();
    expect(screen.getByText(/does not store a password for this account/i)).toBeInTheDocument();

    expect(screen.queryByText(/google.*connected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/github.*connected/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/superadmin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/active sessions/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/notifications/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\bGB\b/i)).not.toBeInTheDocument();

    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("uses initials when the provider image is absent and stays honest about missing context", async () => {
    const fallbackIdentity: RelayIdentity = {
      ...identity,
      session: { ...identity.session, expiresAt: null, activeWorkspaceId: null },
      user: { ...identity.user, name: "Mina Park", image: null },
    };

    renderProfile(createTestAuthAdapter({ identity: fallbackIdentity, activeWorkspace: null }));

    expect(await screen.findByRole("img", {
      name: "Profile initials MP for Mina Park",
    })).toHaveTextContent("MP");
    expect(screen.getByText("Not provided by this session")).toBeInTheDocument();
    expect(screen.getByText("No active workspace is attached to this session.")).toBeInTheDocument();
    expect(document.querySelector("time")).not.toBeInTheDocument();
  });

  it("does not present mismatched workspace details as active", async () => {
    renderProfile(createTestAuthAdapter({
      identity,
      activeWorkspace: {
        id: "workspace-other",
        name: "Other workspace",
        slug: "other",
      },
    }));

    expect(await screen.findByText("Active workspace unavailable")).toBeInTheDocument();
    expect(screen.getByText(/does not match the current session/i)).toBeInTheDocument();
    expect(screen.queryByText("Other workspace")).not.toBeInTheDocument();
  });

  it("falls back to initials when a provider image cannot load", async () => {
    renderProfile(createTestAuthAdapter({ identity, activeWorkspace: workspace }));

    const avatar = await screen.findByRole("img", { name: "Profile image for Avery Torres" });
    const image = avatar.querySelector("img");
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);

    expect(screen.getByRole("img", {
      name: "Profile initials AT for Avery Torres",
    })).toHaveTextContent("AT");
  });

  it("leaves session loading and degradation to the protected auth boundary", async () => {
    const user = userEvent.setup();
    const adapter = createTestAuthAdapter({ identity, activeWorkspace: workspace });
    let resolveSession!: (value: RelayIdentity | null) => void;
    const pendingSession = new Promise<RelayIdentity | null>((resolve) => {
      resolveSession = resolve;
    });
    adapter.getSession = vi.fn().mockReturnValueOnce(pendingSession);

    const { unmount } = renderProfile(adapter);
    expect(screen.getByRole("heading", { name: "Checking Relay session" })).toBeInTheDocument();

    await act(async () => {
      resolveSession(identity);
      await pendingSession;
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeInTheDocument();
    unmount();

    adapter.getSession = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(identity);

    renderProfile(adapter);
    expect(await screen.findByRole("heading", { name: "Session check unavailable" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Profile" })).toBeInTheDocument();
  });

  it("reports an unavailable workspace and retries through the auth context", async () => {
    const user = userEvent.setup();
    const adapter = createTestAuthAdapter({ identity, activeWorkspace: workspace });
    adapter.getActiveWorkspace = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(workspace);

    renderProfile(adapter);

    expect(await screen.findByText("Active workspace unavailable")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry active workspace" }));

    expect(await screen.findByText("Atlas workspace")).toBeInTheDocument();
    expect(adapter.getActiveWorkspace).toHaveBeenCalledTimes(2);
  });
});
