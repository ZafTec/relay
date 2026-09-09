import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App, createRelayMemoryRouter } from "../../src/app/App";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";

const adapter = () => createTestAuthAdapter({
  identity: {
    user: { id: "operator", email: "operator@example.test", name: "Operator", image: null },
    session: { id: "current-session", userId: "operator", expiresAt: null, activeWorkspaceId: "workspace" },
  },
  activeWorkspace: { id: "workspace", name: "My workspace", slug: "my-workspace" },
});
afterEach(() => vi.unstubAllGlobals());

it("opens OAuth clients from the dashboard for any signed-in user, without requiring admin access", async () => {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    fetched.push(path);
    if (path === "/api/v1/admin/access") return Response.json({ allowed: false }, { status: 403 });
    if (path === "/api/auth/oauth2/get-clients") return Response.json([]);
    return Response.json({ error: { code: "authorization_denied" } }, { status: 403 });
  }));
  render(<App adapter={adapter()} router={createRelayMemoryRouter(["/dashboard/oauth-clients"])} />);
  expect(await screen.findByRole("heading", { name: "OAuth clients" }, { timeout: 5000 })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Create client", exact: true })).toBeEnabled();
});

it("hides platform admin permissions from a non-superadmin creating a client", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/v1/admin/access") return Response.json({ allowed: false }, { status: 403 });
    if (path === "/api/auth/oauth2/get-clients") return Response.json([]);
    return Response.json({ error: { code: "authorization_denied" } }, { status: 403 });
  }));
  render(<App adapter={adapter()} router={createRelayMemoryRouter(["/dashboard/oauth-clients"])} />);
  const createButton = await screen.findByRole("button", { name: "Create client", exact: true });
  await waitFor(() => expect(createButton).toBeEnabled());
  createButton.click();
  expect(await screen.findByRole("heading", { name: "Create an OAuth client" })).toBeInTheDocument();
  expect(screen.queryByText("Platform admin permissions")).not.toBeInTheDocument();
});

it("shows platform admin permissions to a confirmed superadmin creating a client", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/v1/admin/access") return Response.json({ allowed: true });
    if (path === "/api/auth/oauth2/get-clients") return Response.json([]);
    return Response.json({ error: { code: "authorization_denied" } }, { status: 403 });
  }));
  render(<App adapter={adapter()} router={createRelayMemoryRouter(["/dashboard/oauth-clients"])} />);
  const createButton = await screen.findByRole("button", { name: "Create client", exact: true });
  await waitFor(() => expect(createButton).toBeEnabled());
  createButton.click();
  expect(await screen.findByText("Platform admin permissions")).toBeInTheDocument();
});

it("no longer serves OAuth clients from the retired admin route", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { code: "authorization_denied" } }, { status: 403 })));
  render(<App adapter={adapter()} router={createRelayMemoryRouter(["/admin/oauth-clients"])} />);
  expect(await screen.findByRole("heading", { name: "This Relay route does not exist" })).toBeInTheDocument();
});
