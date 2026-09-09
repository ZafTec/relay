import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App, createRelayMemoryRouter } from "../../src/app/App";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";

const signedIn = () => createTestAuthAdapter({
  identity: {
    user: { id: "status-user", email: "user@example.test", name: "Status user", image: null },
    session: { id: "status-session", userId: "status-user", expiresAt: null, activeWorkspaceId: null },
  },
});
afterEach(() => vi.unstubAllGlobals());

it.each(["/", "/docs"])("keeps operational status out of public navigation on %s", async (path) => {
  render(<App adapter={createTestAuthAdapter({ identity: null })} router={createRelayMemoryRouter([path])} />);
  await screen.findByRole("heading", { level: 1 });
  expect(screen.queryByRole("link", { name: /status/i })).not.toBeInTheDocument();
});

it("retires the public status route", async () => {
  render(<App adapter={createTestAuthAdapter({ identity: null })} router={createRelayMemoryRouter(["/status"])} />);
  expect(await screen.findByRole("heading", { name: "This Relay route does not exist" })).toBeInTheDocument();
});

it("requires sign-in for the admin status route", async () => {
  render(<App adapter={createTestAuthAdapter({ identity: null })} router={createRelayMemoryRouter(["/admin/status"])} />);
  expect(await screen.findByRole("heading", { name: "Sign in to Relay" })).toBeInTheDocument();
});

it("denies regular users before fetching operational data", async () => {
  const fetchMock = vi.fn(async () => Response.json({ allowed: false }, { status: 403 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<App adapter={signedIn()} router={createRelayMemoryRouter(["/admin/status"])} />);
  expect(await screen.findByRole("heading", { name: "Admin access unavailable" })).toBeInTheDocument();
  expect(fetchMock.mock.calls).toHaveLength(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/v1/admin/access", expect.anything());
});

it("loads service status after confirming superadmin access", async () => {
  const fetched: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    fetched.push(path);
    if (path === "/api/v1/admin/access") return Response.json({ allowed: true });
    if (path === "/health/ready") return Response.json({ service: "api", status: "ok", checks: [] });
    if (path === "/version") return Response.json({ version: "test", revision: "review" });
    return Response.json({}, { status: 404 });
  }));
  render(<App adapter={signedIn()} router={createRelayMemoryRouter(["/admin/status"])} />);
  expect(await screen.findByRole("heading", { name: "All reported checks operational" })).toBeInTheDocument();
  expect(fetched[0]).toBe("/api/v1/admin/access");
  expect(fetched).toContain("/health/ready");
  expect(fetched).toContain("/version");
});
