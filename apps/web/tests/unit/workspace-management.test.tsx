import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { RelayIdentity } from "../../src/auth/types";
import { WorkspaceManagement } from "../../src/features/settings/WorkspaceManagement";
import {
  httpWorkspaceAdapter,
  type ManagedWorkspace,
  type WorkspaceAdapter,
} from "../../src/lib/api/workspaces";

const personal: ManagedWorkspace = {
  id: "601a0c31-cd29-4e8f-8ef2-f3b63f936621",
  name: "Amber Meadow",
  slug: "amber-meadow-4821",
  role: "owner",
  personal: true,
};
const created: ManagedWorkspace = {
  id: "971a0c31-cd29-4e8f-8ef2-f3b63f936621",
  name: "Design team",
  slug: "design-team",
  role: "owner",
  personal: false,
};
const identity: RelayIdentity = {
  session: {
    id: "workspace-test-session",
    userId: "workspace-test-user",
    activeWorkspaceId: personal.id,
    expiresAt: new Date("2031-01-01T00:00:00Z"),
  },
  user: {
    id: "workspace-test-user",
    name: "Morgan",
    email: "morgan@example.test",
    image: null,
  },
};

function setup(initial = [personal]) {
  let items = initial.map((item) => ({ ...item }));
  let selected = items[0]?.id ?? null;
  const auth = createTestAuthAdapter();
  auth.getSession = vi.fn(async () => ({
    ...identity,
    session: { ...identity.session, activeWorkspaceId: selected },
  }));
  auth.getActiveWorkspace = vi.fn(async () =>
    items.find((item) => item.id === selected) ?? null
  );
  auth.setActiveWorkspace = vi.fn(async (id: string) => {
    selected = id;
  });
  const api: WorkspaceAdapter = {
    remove: vi.fn(async (id) => {
      items = items.filter((item) => item.id !== id);
      selected = items[0]?.id ?? null;
    }),
    list: vi.fn(async () => ({ items, maxOwnedWorkspaces: 20 })),
    propose: vi.fn(async () => ({
      name: "Quiet Forest",
      slug: "quiet-forest-5281",
    })),
    create: vi.fn(async (details) => {
      const workspace = { ...created, ...details };
      items = [...items, workspace];
      return { workspace, replayed: false };
    }),
    update: vi.fn(async (id, details) => {
      const workspace = {
        ...items.find((item) => item.id === id)!,
        ...details,
      };
      items = items.map((item) => item.id === id ? workspace : item);
      return workspace;
    }),
  };
  const mount = () =>
    render(
      <MemoryRouter>
        <AuthProvider adapter={auth}>
          <Routes>
            <Route element={<ProtectedRoute />}>
              <Route
                path="/"
                element={
                  <main>
                    <WorkspaceManagement adapter={api} />
                  </main>
                }
              />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
  return { auth, api, mount };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("allows editing the suggested name and handle, retries one creation, and switches to its workspace", async () => {
  const user = userEvent.setup();
  const { api, auth, mount } = setup();
  vi.mocked(api.create).mockRejectedValueOnce(new TypeError("connection lost"));
  mount();
  await user.click(
    await screen.findByRole("button", { name: "New workspace" }),
  );
  expect(await screen.findByRole("textbox", { name: "Workspace name" }))
    .toHaveValue("Quiet Forest");
  expect(screen.getByRole("textbox", { name: "Workspace handle" })).toHaveValue(
    "quiet-forest-5281",
  );
  expect(
    screen.getByText(
      /A superadmin must grant execution access and a usage allowance/,
    ),
  ).toBeInTheDocument();
  await user.clear(screen.getByRole("textbox", { name: "Workspace name" }));
  await user.type(
    screen.getByRole("textbox", { name: "Workspace name" }),
    "Design team",
  );
  await user.clear(screen.getByRole("textbox", { name: "Workspace handle" }));
  await user.type(
    screen.getByRole("textbox", { name: "Workspace handle" }),
    "Design-Team",
  );
  await user.click(
    screen.getByRole("button", { name: "Create workspace", exact: true }),
  );
  expect(await screen.findByText(/Relay could not confirm this change/))
    .toBeInTheDocument();
  expect(auth.setActiveWorkspace).not.toHaveBeenCalled();
  await user.click(
    screen.getByRole("button", { name: "Create workspace", exact: true }),
  );
  await screen.findByText("@design-team");
  expect(api.create).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.create).mock.calls[1]).toEqual(
    vi.mocked(api.create).mock.calls[0],
  );
  expect(api.create).toHaveBeenCalledWith({
    name: "Design team",
    slug: "design-team",
  }, expect.any(String));
  expect(auth.setActiveWorkspace).toHaveBeenCalledWith(created.id);
  expect(screen.getByRole("combobox", { name: "Active workspace" }))
    .toHaveValue(created.id);
});

it("lets an owner rename a workspace and copy its handle while preserving its ID", async () => {
  const user = userEvent.setup();
  const { api, mount } = setup();
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  mount();
  await user.click(await screen.findByRole("button", { name: "Edit details" }));
  expect(screen.getByRole("textbox", { name: "Workspace name" })).toHaveValue(
    personal.name,
  );
  await user.clear(screen.getByRole("textbox", { name: "Workspace name" }));
  await user.type(
    screen.getByRole("textbox", { name: "Workspace name" }),
    "Print studio",
  );
  expect(screen.getByRole("textbox", { name: "Workspace handle" }))
    .toHaveAttribute("readonly");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(`@${personal.slug}`);
  expect(api.update).toHaveBeenCalledWith(personal.id, {
    name: "Print studio",
    slug: personal.slug,
    logo: null,
  });
  expect(screen.getByText("Personal workspace")).toBeInTheDocument();
  expect(screen.getByRole("combobox", { name: "Active workspace" }))
    .toHaveValue(personal.id);
  expect(screen.getByText(personal.id).closest("details")).not.toHaveAttribute(
    "open",
  );
  await user.click(screen.getByRole("button", { name: "Copy handle" }));
  expect(copy).toHaveBeenCalledWith(personal.slug);
});

it("shows member context without editing and switches through the authenticated session", async () => {
  const member = { ...personal, role: "member", personal: false };
  const { auth, mount } = setup([member, created]);
  const user = userEvent.setup();
  mount();
  const select = await screen.findByRole("combobox", {
    name: "Active workspace",
  });
  expect(await screen.findByText("Member", { exact: true }))
    .toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Edit details" })).not
    .toBeInTheDocument();
  await user.selectOptions(select, created.id);
  expect(await screen.findByText("@design-team")).toBeInTheDocument();
  expect(auth.setActiveWorkspace).toHaveBeenCalledWith(created.id);
  expect(await screen.findByRole("button", { name: "Edit details" }))
    .toBeEnabled();
});

it("recovers workspace discovery after a failed request without hiding the active identity", async () => {
  const { api, mount } = setup();
  const user = userEvent.setup();
  vi.mocked(api.list).mockRejectedValueOnce(new TypeError("offline"));
  mount();
  expect(await screen.findByText("@amber-meadow-4821")).toBeInTheDocument();
  const notice = await screen.findByRole("alert");
  expect(within(notice).getByText(/Your workspaces could not be loaded/))
    .toBeInTheDocument();
  await user.click(
    within(notice).getByRole("button", { name: "Refresh workspaces" }),
  );
  expect(await screen.findByRole("button", { name: "New workspace" }))
    .toBeEnabled();
  await waitFor(() =>
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  );
});

it("rejects malformed server receipts so uncertain creations are never presented as successful", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ workspace: created }), {
        headers: { "content-type": "application/json" },
      })
    ),
  );
  await expect(
    httpWorkspaceAdapter.create(
      { name: created.name, slug: created.slug },
      "test-workspace-key-1234",
    ),
  ).rejects.toThrow("Invalid workspace receipt");
});
