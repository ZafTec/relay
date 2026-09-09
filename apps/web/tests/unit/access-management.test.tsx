import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { OAuthClientsPage } from "../../src/features/oauth-clients/OAuthClientsPage";
import { SuperadminsPage } from "../../src/features/admin-access/SuperadminsPage";
import { AcceptSuperadminInvitationPage } from "../../src/features/admin-access/AcceptSuperadminInvitationPage";
import { oauthClients } from "../../src/lib/api/oauth-clients";
import { superadminAccess } from "../../src/lib/api/superadmin-access";
import { checkAdminAccess } from "../../src/lib/api/admin-access";
import { ApiError } from "../../src/lib/api/client";

const { expireSession, reportAccessFailure } = vi.hoisted(() => ({ expireSession: vi.fn(), reportAccessFailure: vi.fn() }));
vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: () => ({ session: { status: "authenticated", identity: { session: { id: "session-one" }, user: { id: "user-one" } } }, expireSession }) }));
vi.mock("../../src/features/admin-changelog/AdminChangelogContext", () => ({ useAdminChangelog: () => ({ reportAccessFailure }) }));
vi.mock("../../src/lib/api/admin-access", () => ({ checkAdminAccess: vi.fn(async () => ({ kind: "ok" })) }));
vi.mock("../../src/lib/api/oauth-clients", async (original) => ({ ...await original<typeof import("../../src/lib/api/oauth-clients")>(), oauthClients: { list: vi.fn(), create: vi.fn(), rotate: vi.fn(), remove: vi.fn() } }));
vi.mock("../../src/lib/api/superadmin-access", () => ({ superadminAccess: { list: vi.fn(), invite: vi.fn(), revoke: vi.fn(), invitation: vi.fn() } }));
const client = { client_id: "test-client", client_name: "My agent", redirect_uris: ["https://agent.example.test/callback"], token_endpoint_auth_method: "client_secret_post" };
const invitation = { id: `sinv_${"a".repeat(32)}`, email: "colleague@example.test", expiresAt: "2030-01-01T00:00:00Z" };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(oauthClients.list).mockResolvedValue([]);
  vi.mocked(superadminAccess.list).mockResolvedValue({ admins: [], invitations: [] });
  vi.mocked(checkAdminAccess).mockResolvedValue({ kind: "ok" });
});
const mountClients = () => render(<MemoryRouter><OAuthClientsPage /></MemoryRouter>);

it("creates an agent with explicit permissions and displays the secret only until acknowledged", async () => {
  const user = userEvent.setup();
  vi.mocked(oauthClients.create).mockResolvedValue({ ...client, client_secret: "one-time-test-secret" });
  mountClients();
  await screen.findByRole("heading", { name: "No registered clients" });
  await user.click(screen.getByRole("button", { name: "Create client", exact: true }));
  await user.type(screen.getByLabelText("Client name"), "My agent");
  await user.type(screen.getByLabelText("Redirect URLs"), client.redirect_uris[0]);
  expect(screen.getByRole("checkbox", { name: "Run tools" })).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "Run tools" }));
  await user.click(screen.getAllByRole("button", { name: "Create client", exact: true }).at(-1)!);
  await screen.findByRole("heading", { name: "Save your client secret" });
  expect(screen.getByLabelText("Client secret")).toHaveAttribute("type", "password");
  expect(oauthClients.create).toHaveBeenCalledWith(expect.objectContaining({ name: "My agent", redirectUris: client.redirect_uris, scopes: ["tools:read", "runs:read", "artifacts:read", "tools:execute"] }));
  await user.click(screen.getByRole("button", { name: "Reveal secret" }));
  expect(screen.getByLabelText("Client secret")).toHaveValue("one-time-test-secret");
  await user.click(screen.getByRole("button", { name: "I’ve saved the credentials" }));
  expect(screen.queryByLabelText("Client secret")).not.toBeInTheDocument();
});

it("requires confirmation and refresh after an ambiguous rotation", async () => {
  const user = userEvent.setup();
  vi.mocked(oauthClients.list).mockResolvedValue([client]);
  vi.mocked(oauthClients.rotate).mockRejectedValue(new Error("Connection lost"));
  mountClients();
  await user.click(await screen.findByText("Manage client"));
  await user.click(await screen.findByRole("button", { name: "Rotate secret" }));
  expect(oauthClients.rotate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Replace secret" }));
  await screen.findByRole("button", { name: "Refresh clients" });
  expect(screen.getByRole("button", { name: "Rotate secret" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Refresh clients" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Rotate secret" })).toBeEnabled());
});

it.each([[401, "reauthentication_required"], [403, "SESSION_TOO_OLD"]] as const)("expires the session when client management gets a %s %s response", async (status, code) => {
  vi.mocked(oauthClients.list).mockRejectedValue(new ApiError("Fresh session required", status, code));
  mountClients();
  await waitFor(() => expect(expireSession).toHaveBeenCalledWith("session-one"));
});

it("retries an uncertain invitation using the original idempotency key", async () => {
  const user = userEvent.setup();
  vi.mocked(superadminAccess.invite).mockRejectedValueOnce(new Error("Connection lost")).mockResolvedValue(invitation);
  render(<MemoryRouter><SuperadminsPage /></MemoryRouter>);
  await waitFor(() => expect(screen.getByRole("button", { name: "Create invitation link" })).toBeEnabled());
  await user.type(screen.getByLabelText("Email address"), invitation.email);
  await user.click(screen.getByRole("button", { name: "Create invitation link" }));
  await screen.findByRole("alert");
  const first = vi.mocked(superadminAccess.invite).mock.calls[0];
  await user.click(screen.getByRole("button", { name: "Create invitation link" }));
  const receipt = await screen.findByRole("region", { name: "New superadmin invitation" });
  expect(within(receipt).getByLabelText("Invitation URL")).toHaveValue(new URL(`/superadmin-invitations/${invitation.id}`, window.location.origin).href);
  expect(vi.mocked(superadminAccess.invite).mock.calls[1]).toEqual(first);
});

it("requires the recipient to explicitly accept a superadmin invitation", async () => {
  const user = userEvent.setup();
  vi.mocked(superadminAccess.invitation).mockImplementation(async (_id, accept) => ({ email: invitation.email, accepted: !!accept }));
  render(<MemoryRouter initialEntries={[`/superadmin-invitations/${invitation.id}`]}><Routes><Route path="/superadmin-invitations/:id" element={<AcceptSuperadminInvitationPage />} /></Routes></MemoryRouter>);
  const accept = await screen.findByRole("button", { name: "Accept superadmin invitation" });
  expect(superadminAccess.invitation).not.toHaveBeenCalledWith(invitation.id, true);
  await user.click(accept);
  await screen.findByRole("heading", { name: "Invitation accepted" });
  expect(superadminAccess.invitation).toHaveBeenCalledWith(invitation.id, true);
});
