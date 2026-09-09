import { render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { RelayIdentity } from "../../src/auth/types";
import { WorkspaceSwitcher } from "../../src/components/layout/WorkspaceSwitcher";
import { httpWorkspaceAdapter, type ManagedWorkspace } from "../../src/lib/api/workspaces";

vi.mock("../../src/lib/api/workspaces", async (original) => ({
  ...await original<typeof import("../../src/lib/api/workspaces")>(),
  httpWorkspaceAdapter: { list: vi.fn(), propose: vi.fn(), create: vi.fn(), update: vi.fn() },
}));

const personal: ManagedWorkspace = { id: "ws-personal", name: "Euael Eshete's Workspace", slug: "euael", role: "owner", personal: true };
const gabi: ManagedWorkspace = { id: "ws-gabi", name: "Gabi", slug: "gabi", role: "member", personal: false };
const zaftech: ManagedWorkspace = { id: "ws-zaftech", name: "Zaftech", slug: "zaftech", role: "owner", personal: false };
const items = [personal, gabi, zaftech];
const identity: RelayIdentity = {
  session: { id: "switcher-session", userId: "switcher-user", activeWorkspaceId: zaftech.id, expiresAt: new Date("2031-01-01T00:00:00Z") },
  user: { id: "switcher-user", name: "Operator", email: "operator@example.test", image: null },
};

function setup() {
  let selected = zaftech.id;
  const auth = createTestAuthAdapter();
  auth.getSession = vi.fn(async () => ({ ...identity, session: { ...identity.session, activeWorkspaceId: selected } }));
  auth.getActiveWorkspace = vi.fn(async () => items.find((item) => item.id === selected) ?? null);
  auth.setActiveWorkspace = vi.fn(async (id: string) => { selected = id; });
  const mount = () => render(
    <StrictMode><MemoryRouter>
      <AuthProvider adapter={auth}>
        <Routes>
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<main><WorkspaceSwitcher /><input aria-label="Outside field" /></main>} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter></StrictMode>,
  );
  return { auth, mount };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows the active workspace collapsed, avatar and name only", async () => {
  vi.mocked(httpWorkspaceAdapter.list).mockResolvedValue({ items, maxOwnedWorkspaces: 20 });
  const { mount } = setup();
  mount();
  expect(await screen.findByRole("button", { name: "Zaftech" })).toBeInTheDocument();
  expect(httpWorkspaceAdapter.list).not.toHaveBeenCalled();
});

it("opens to list every workspace and marks the active one", async () => {
  vi.mocked(httpWorkspaceAdapter.list).mockResolvedValue({ items, maxOwnedWorkspaces: 20 });
  const user = userEvent.setup();
  const { mount } = setup();
  mount();
  await user.click(await screen.findByRole("button", { name: "Zaftech" }));
  expect(await screen.findByRole("listbox", { name: "Your workspaces" })).toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(3);
  expect(screen.getByRole("option", { name: /Zaftech/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByRole("option", { name: /Gabi/ })).toHaveAttribute("aria-selected", "false");
  expect(screen.getByRole("link", { name: /Create workspace/ })).toBeInTheDocument();
});

it("switches the active workspace when another one is chosen", async () => {
  vi.mocked(httpWorkspaceAdapter.list).mockResolvedValue({ items, maxOwnedWorkspaces: 20 });
  const user = userEvent.setup();
  const { auth, mount } = setup();
  mount();
  await user.click(await screen.findByRole("button", { name: "Zaftech" }));
  await user.click(await screen.findByRole("option", { name: /Gabi/ }));
  expect(auth.setActiveWorkspace).toHaveBeenCalledWith(gabi.id);
  await waitFor(() => expect(screen.getByRole("button", { name: "Gabi" })).toBeInTheDocument());
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("closes the panel on Escape without switching, and returns focus to the trigger", async () => {
  vi.mocked(httpWorkspaceAdapter.list).mockResolvedValue({ items, maxOwnedWorkspaces: 20 });
  const user = userEvent.setup();
  const { auth, mount } = setup();
  mount();
  const trigger = await screen.findByRole("button", { name: "Zaftech" });
  await user.click(trigger);
  await screen.findByRole("listbox");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  expect(auth.setActiveWorkspace).not.toHaveBeenCalled();
  expect(trigger).toHaveFocus();
});

it("closes on an outside click without stealing focus from the clicked field", async () => {
  vi.mocked(httpWorkspaceAdapter.list).mockResolvedValue({ items, maxOwnedWorkspaces: 20 });
  const user = userEvent.setup();
  const { auth, mount } = setup();
  mount();
  const trigger = await screen.findByRole("button", { name: "Zaftech" });
  await user.click(trigger);
  await screen.findByRole("listbox");
  const field = screen.getByRole("textbox", { name: "Outside field" });
  await user.click(field);
  await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  expect(auth.setActiveWorkspace).not.toHaveBeenCalled();
  expect(field).toHaveFocus();
  await user.type(field, "Still typing");
  expect(field).toHaveValue("Still typing");
});

it("supports arrow, Home, and End keys and returns focus after selecting the current workspace", async () => {
  vi.mocked(httpWorkspaceAdapter.list).mockResolvedValue({ items, maxOwnedWorkspaces: 20 });
  const user = userEvent.setup();
  const { mount } = setup();
  mount();
  const trigger = await screen.findByRole("button", { name: "Zaftech" });
  trigger.focus();
  await user.keyboard("{ArrowDown}");
  await screen.findByRole("option", { name: /Gabi/ });
  expect(screen.getByRole("option", { name: /Zaftech/ })).toHaveFocus();
  await user.keyboard("{Home}");
  expect(screen.getByRole("option", { name: /Euael/ })).toHaveFocus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("option", { name: /Gabi/ })).toHaveFocus();
  await user.keyboard("{End}{Enter}");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("recovers from a failed switch in Strict Mode and allows retry", async () => {
  vi.mocked(httpWorkspaceAdapter.list).mockResolvedValue({ items, maxOwnedWorkspaces: 20 });
  const user = userEvent.setup();
  const { auth, mount } = setup();
  vi.mocked(auth.setActiveWorkspace).mockRejectedValueOnce(new Error("Network unavailable"));
  mount();
  await user.click(await screen.findByRole("button", { name: "Zaftech" }));
  await user.click(await screen.findByRole("option", { name: /Gabi/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("could not be changed");
  const option = screen.getByRole("option", { name: /Gabi/ });
  expect(option).toBeEnabled();
  await user.click(option);
  expect(await screen.findByRole("button", { name: "Gabi" })).toBeInTheDocument();
});

it("refreshes the workspace list after the panel is reopened", async () => {
  vi.mocked(httpWorkspaceAdapter.list).mockResolvedValueOnce({ items, maxOwnedWorkspaces: 20 })
    .mockResolvedValue({ items: [...items, { ...gabi, id: "new-workspace", name: "New project" }], maxOwnedWorkspaces: 20 });
  const user = userEvent.setup();
  const { mount } = setup();
  mount();
  await user.click(await screen.findByRole("button", { name: "Zaftech" }));
  await screen.findByRole("option", { name: /Gabi/ });
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "Zaftech" }));
  expect(await screen.findByRole("option", { name: /New project/ })).toBeInTheDocument();
});
