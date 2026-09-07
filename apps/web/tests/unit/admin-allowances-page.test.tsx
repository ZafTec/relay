import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { AdminAllowancesPage } from "../../src/features/admin-allowances/AdminAllowancesPage";
import type { AdminAllowanceAdapter, AllowanceGrant, AllowanceSummary } from "../../src/lib/api/admin-allowances";
import { httpAdminAllowanceAdapter } from "../../src/lib/api/admin-allowances";
import { ApiError } from "../../src/lib/api/client";

vi.mock("../../src/auth/AuthProvider", () => ({ useAuth: () => ({ session: { status: "authenticated", identity: { user: { id: "operator-test" } } } }) }));
const workspace = { id: "workspace-one", name: "Studio", slug: "studio", owner: { name: "Morgan Lee", email: "morgan@example.test" } };
const summary: AllowanceSummary = { workspace, asOf: "2026-09-06T12:00:00Z", executionAllowed: false,
  periodStartsAt: "2026-09-01T00:00:00Z", periodEndsAt: "2026-10-01T00:00:00Z", limits: [
    { key: "images.generated", state: "limited", amount: "20", consumed: "3", reserved: "2", remaining: "15" },
    { key: "ocr.requests", state: "none", amount: null, consumed: "0", reserved: "0", remaining: null },
  ] };
const grant: AllowanceGrant = { id: "grant-one", key: "images.generated", amount: "20", sourceKind: "manual",
  effectiveAt: "2026-09-01T00:00:00Z", expiresAt: null, revokedAt: null, createdAt: "2026-09-01T00:00:00Z",
  operatorUserId: "operator-one", reason: "Initial pilot" };
function adapter(overrides: Partial<AdminAllowanceAdapter> = {}): AdminAllowanceAdapter {
  return { workspaces: vi.fn(async () => ({ items: [workspace], nextCursor: null })),
    summary: vi.fn(async () => summary), grants: vi.fn(async () => ({ items: [grant], nextCursor: null })),
    audit: vi.fn(async () => ({ items: [], nextCursor: null })),
    mutate: vi.fn(async (_id, operation) => ({ operation, grantId: "new-grant", replayed: false })), ...overrides };
}
function mount(api: AdminAllowanceAdapter) {
  return render(<MemoryRouter initialEntries={["/admin/allowances?workspace=workspace-one"]}><AdminAllowancesPage adapter={api} /></MemoryRouter>);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear(); });

it("identifies a workspace by handle and owner and searches by owner email", async () => {
  const api = adapter(); const user = userEvent.setup(); mount(api);
  const card = await screen.findByRole("button", { name: /Studio/ });
  expect(within(card).getByText("@studio")).toBeInTheDocument();
  expect(within(card).getByText("morgan@example.test")).toBeInTheDocument();
  expect(within(card).queryByText("workspace-one")).not.toBeInTheDocument();
  expect(card).toHaveAttribute("aria-pressed", "true");
  await user.type(screen.getByRole("searchbox", { name: "Workspace name, handle, or owner email" }), "morgan@example.test");
  await user.click(screen.getByRole("button", { name: "Search", exact: true }));
  await waitFor(() => expect(api.workspaces).toHaveBeenLastCalledWith("morgan@example.test", null, expect.any(AbortSignal)));
  expect(api.mutate).not.toHaveBeenCalled();
});

it("requires an explicit grant and uses exact string amounts for the selected workspace", async () => {
  const api = adapter(); const user = userEvent.setup(); mount(api);
  await screen.findByRole("heading", { name: "Add a grant" });
  expect(screen.getByText("Execution blocked")).toBeInTheDocument();
  const table = screen.getByRole("table"); expect(within(table).getByText("Not granted")).toBeInTheDocument();
  expect(screen.getByLabelText("Allowance")).toHaveValue("");
  await user.selectOptions(screen.getByLabelText("Allowance"), "images.generated");
  await user.selectOptions(screen.getByLabelText("Limit"), "finite");
  await user.type(screen.getByLabelText("Number of images"), "9007199254740993");
  await user.type(screen.getByLabelText("Reason for this change"), "Approved image budget");
  await user.click(screen.getByRole("button", { name: "Add grant", exact: true }));
  await screen.findByText("Grant added. Recorded usage is preserved.");
  expect(api.mutate).toHaveBeenCalledWith("workspace-one", "grant", {
    key: "images.generated", mode: "finite", amount: "9007199254740993", effectiveAt: null, expiresAt: null, reason: "Approved image budget",
  }, expect.any(String));
});
it("requires confirmation for unlimited usage and records a reason for revocation", async () => {
  const api = adapter(); const user = userEvent.setup(); mount(api);
  await screen.findByRole("heading", { name: "Add a grant" });
  await user.selectOptions(screen.getByLabelText("Allowance"), "ocr.requests");
  await user.selectOptions(screen.getByLabelText("Limit"), "unlimited");
  await user.type(screen.getByLabelText("Reason for this change"), "Approved OCR pilot");
  await user.click(screen.getByRole("button", { name: "Add grant", exact: true }));
  expect(api.mutate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("checkbox")); await user.click(screen.getByRole("button", { name: "Add grant", exact: true }));
  await screen.findByText("Grant added. Recorded usage is preserved.");
  await waitFor(() => expect(screen.getByRole("button", { name: "Revoke images" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "Revoke images" }));
  await user.type(screen.getByLabelText("Reason for this change"), "Pilot ended");
  await user.click(screen.getByRole("button", { name: "Revoke grant", exact: true }));
  await screen.findByText("Grant revoked. Recorded usage is preserved.");
  expect(api.mutate).toHaveBeenLastCalledWith("workspace-one", "revoke", { grantId: "grant-one", reason: "Pilot ended" }, expect.any(String));
});
it("preserves an uncertain request across reload and retries with the original key", async () => {
  const mutate = vi.fn().mockRejectedValueOnce(new TypeError("Network unavailable")).mockResolvedValue({ grantId: "new-grant", operation: "grant", replayed: true });
  const api = adapter({ mutate }); const user = userEvent.setup(); const first = mount(api);
  await screen.findByRole("heading", { name: "Add a grant" });
  await user.selectOptions(screen.getByLabelText("Allowance"), "tools.execute");
  await user.type(screen.getByLabelText("Reason for this change"), "Approved access");
  await user.click(screen.getByRole("button", { name: "Add grant", exact: true }));
  await screen.findByRole("button", { name: "Retry saved request" });
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry saved request" })).toBeEnabled());
  const original = mutate.mock.calls[0]; first.unmount(); mount(api);
  await user.click(await screen.findByRole("button", { name: "Retry saved request" }));
  await screen.findByText("Grant added (confirmed from the saved request). Recorded usage is preserved.");
  expect(mutate.mock.calls[1]).toEqual(original);
  expect(sessionStorage.getItem("relay:allowance-request:operator-test")).toBeNull();
});
it("removes the editor when authorization expires and offers reauthentication", async () => {
  const api = adapter({ summary: vi.fn().mockRejectedValue(new ApiError("Fresh session required", 401, "reauthentication_required")) });
  mount(api);
  expect(await screen.findByRole("link", { name: "Reauthenticate" })).toHaveAttribute("href", expect.stringContaining("returnTo="));
  expect(screen.queryByRole("button", { name: "Add grant", exact: true })).not.toBeInTheDocument();
});
it("does not display a late response from the previously selected workspace", async () => {
  let resolve!: (value: AllowanceSummary) => void;
  const api = adapter({ workspaces: vi.fn(async () => ({ items: [workspace, { ...workspace, id: "workspace-two", name: "Second workspace" }], nextCursor: null })),
    summary: vi.fn((id) => id === "workspace-one" ? new Promise((r) => { resolve = r; }) : Promise.resolve({ ...summary, workspace: { ...workspace, id, name: "Second workspace" } })),
  });
  mount(api);
  fireEvent.click(await screen.findByRole("button", { name: /Second workspace/ }));
  await screen.findByRole("heading", { name: "Second workspace" });
  resolve(summary);
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Studio" })).not.toBeInTheDocument());
});
it("treats malformed mutation receipts as uncertain instead of reporting success", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ grantId: "g", operation: "grant" }), { status: 200, headers: { "content-type": "application/json" } })));
  await expect(httpAdminAllowanceAdapter.mutate(workspace.id, "grant", { key: "tools.execute", mode: "enabled", amount: null, effectiveAt: null, expiresAt: null, reason: "Approved" }, "key-1234567890123456")).rejects.toThrow("Invalid allowance receipt");
});
