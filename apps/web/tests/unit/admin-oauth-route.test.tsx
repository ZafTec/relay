import { render, screen } from "@testing-library/react";
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

it("opens OAuth clients using platform access independently of changelog permissions", async () => {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    fetched.push(path);
    if (path === "/api/v1/admin/access") return Response.json({ allowed: true });
    if (path === "/api/auth/oauth2/get-clients") return Response.json([]);
    return Response.json({ error: { code: "authorization_denied" } }, { status: 403 });
  }));
  render(<App adapter={adapter()} router={createRelayMemoryRouter(["/admin/oauth-clients"])} />);
  expect(await screen.findByRole("heading", { name: "OAuth clients" }, { timeout: 5000 })).toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Create client", exact: true })).toBeEnabled();
  expect(fetched).toContain("/api/v1/admin/access");
  expect(fetched.some((path) => path.includes("changelog"))).toBe(false);
});

it("shows access-check failure as unavailable instead of denying a superadmin", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  render(<App adapter={adapter()} router={createRelayMemoryRouter(["/admin/oauth-clients"])} />);
  expect(await screen.findByRole("heading", { name: "Admin access check unavailable" })).toBeInTheDocument();
  expect(screen.queryByText("Access denied")).not.toBeInTheDocument();
});

it("denies an account without a current role before fetching client data", async () => {
  const fetchMock = vi.fn(async () => Response.json({ error: { code: "authorization_denied" } }, { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<App adapter={adapter()} router={createRelayMemoryRouter(["/admin/oauth-clients"])} />);
  expect(await screen.findByRole("heading", { name: "Admin access unavailable" })).toBeInTheDocument();
  expect(fetchMock.mock.calls.length).toBe(1);
});
