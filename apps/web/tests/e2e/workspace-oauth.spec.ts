import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const consentScopes = ["openid", "tools:read", "tools:execute", "usage:read", "admin:allowances:write"];
const signedQuery = new URLSearchParams({
  client_id: "browser-agent", scope: consentScopes.join(" "), sig: "browser-fixture-signature", ba_iat: "1900000000",
});
for (const name of ["client_id", "scope", "ba_iat", "ba_param"]) signedQuery.append("ba_param", name);
const consentPath = `/oauth/consent?${signedQuery}`;

async function workspaceFixture(page: Page) {
  const workspaces = [
    { id: "ws_field_notes", name: "Field notes", slug: "field-notes", role: "owner", personal: true },
    { id: "ws_design_studio", name: "Design studio", slug: "design-studio", role: "member", personal: false },
  ];
  const state = {
    activeId: workspaces[0].id,
    created: [] as { name: string; slug: string; key: string | undefined }[],
    updated: [] as { id: string; name: string; slug: string }[],
    clients: [] as Record<string, unknown>[],
    consent: [] as { accept: boolean; scope?: string; oauth_query?: string }[],
    continued: [] as { postLogin: boolean; oauth_query?: string }[],
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: async (value: string) => { copied = value; }, readText: async () => copied,
    } });
  });
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const active = () => workspaces.find((item) => item.id === state.activeId)!;
    if (pathname === "/api/auth/get-session") {
      return route.fulfill({ json: {
        session: { id: "session-workspace-browser", userId: "user-workspace-browser", token: "browser-fixture", expiresAt: "2099-01-01T00:00:00.000Z", activeOrganizationId: state.activeId },
        user: { id: "user-workspace-browser", name: "Morgan Lee", email: "morgan@example.test", emailVerified: true },
      } });
    }
    if (pathname === "/api/auth/organization/get-organization") return route.fulfill({ json: active() });
    if (pathname === "/api/auth/organization/list") return route.fulfill({ json: workspaces });
    if (pathname === "/api/auth/organization/set-active") {
      state.activeId = route.request().postDataJSON().organizationId;
      return route.fulfill({ json: active() });
    }
    if (pathname === "/api/v1/workspaces/suggestion") return route.fulfill({ json: { name: "Quiet meadow", slug: "quiet-meadow" } });
    if (pathname === "/api/v1/workspaces" && method === "GET") return route.fulfill({ json: { items: workspaces, maxOwnedWorkspaces: 6 } });
    if (pathname === "/api/v1/workspaces" && method === "POST") {
      const details = route.request().postDataJSON();
      state.created.push({ ...details, key: route.request().headers()["idempotency-key"] });
      const workspace = { ...details, id: "ws_product_archive", personal: false, role: "owner" };
      workspaces.push(workspace);
      return route.fulfill({ status: 201, json: { workspace, replayed: false } });
    }
    if (pathname.startsWith("/api/v1/workspaces/") && method === "PATCH") {
      const id = pathname.split("/").at(-1)!;
      const details = route.request().postDataJSON();
      state.updated.push({ id, ...details });
      const workspace = workspaces.find((item) => item.id === id)!;
      Object.assign(workspace, details);
      return route.fulfill({ json: { workspace } });
    }
    if (pathname === "/api/v1/notifications") return route.fulfill({ json: { notifications: { configured: true, completed: false, failed: false, deliveries: [] } } });
    if (pathname === "/api/v1/admin/access") return route.fulfill({ json: { allowed: true } });
    if (pathname === "/api/auth/oauth2/get-clients") return route.fulfill({ json: state.clients });
    if (pathname === "/api/auth/oauth2/create-client") {
      const client = { ...route.request().postDataJSON(), client_id: "browser-manual-client" };
      state.clients.push(client);
      return route.fulfill({ status: 201, json: { ...client, client_secret: "browser-only-fixture-secret" } });
    }
    if (pathname === "/api/auth/oauth2/public-client") return route.fulfill({ json: { client_id: "browser-agent", client_name: "Research assistant", client_uri: "https://agent.example.test" } });
    if (pathname === "/api/auth/oauth2/continue") {
      state.continued.push(route.request().postDataJSON());
      return route.fulfill({ json: { redirect: true, url: new URL(consentPath, route.request().url()).href } });
    }
    if (pathname === "/api/auth/oauth2/consent") {
      state.consent.push(route.request().postDataJSON());
      return route.fulfill({ json: { redirect: false } });
    }
    return route.fulfill({ status: 403, json: { error: { code: "authorization_denied", message: "Unavailable in this browser fixture.", retryable: false, requestId: "req_workspace_browser", details: {} } } });
  });
  return { state, errors };
}

async function checkSurface(page: Page, selector: string, screenshot: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: path.join("artifacts", "screenshots", screenshot), fullPage: true });
  if (selector === ".workspace-management") {
    await page.locator(selector).screenshot({ path: path.join("artifacts", "screenshots", screenshot.replace(".png", "-panel.png")) });
  }
  expect((await new AxeBuilder({ page }).include(selector).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`workspace create, edit and switch keep the correct identity at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const { state, errors } = await workspaceFixture(page);
    await page.goto("/dashboard/settings#workspaces");
    const panel = page.getByRole("region", { name: "Your workspaces" });
    await expect(panel.getByRole("combobox", { name: "Active workspace" })).toHaveValue("ws_field_notes");
    await expect(panel.getByText("@field-notes", { exact: true })).toBeVisible();
    await expect(panel.getByText("ws_field_notes", { exact: true })).not.toBeVisible();
    await checkSurface(page, ".settings-context", `workspace-settings-${viewport.width}.png`);

    await panel.getByRole("button", { name: "Edit details" }).click();
    await expect(panel.getByRole("heading", { name: "Edit workspace details" })).toBeFocused();
    await panel.getByRole("textbox", { name: "Workspace name" }).fill("Field research");
    await panel.getByRole("textbox", { name: "Workspace handle" }).fill("field-research");
    await checkSurface(page, ".workspace-management", `workspace-edit-${viewport.width}.png`);
    await panel.getByRole("button", { name: "Save changes" }).click();
    await expect(panel.getByText("@field-research", { exact: true })).toBeVisible();
    expect(state.updated).toEqual([{ id: "ws_field_notes", name: "Field research", slug: "field-research" }]);
    await expect(page.getByRole("region", { name: "Current session" }).getByText("@field-research")).toBeVisible();
    await expect(page.getByRole("region", { name: "MCP connection" }).getByText("@field-research")).toBeVisible();

    await panel.getByRole("button", { name: "New workspace" }).click();
    await expect(panel.getByRole("heading", { name: "Create a workspace" })).toBeFocused();
    await expect(panel.getByRole("textbox", { name: "Workspace name" })).toHaveValue("Quiet meadow");
    await expect(panel.getByRole("textbox", { name: "Workspace handle" })).toHaveValue("quiet-meadow");
    await panel.getByRole("textbox", { name: "Workspace name" }).fill("Product archive");
    await panel.getByRole("textbox", { name: "Workspace handle" }).fill("product-archive");
    await expect(panel.getByText(/A superadmin must grant execution access and a usage allowance/)).toBeVisible();
    await checkSurface(page, ".workspace-management", `workspace-create-${viewport.width}.png`);
    await panel.getByRole("button", { name: "Create workspace", exact: true }).click();
    await expect(panel.getByRole("combobox", { name: "Active workspace" })).toHaveValue("ws_product_archive");
    expect(state.created).toEqual([{ name: "Product archive", slug: "product-archive", key: expect.stringMatching(/^[a-f0-9-]{36}$/) }]);
    await panel.getByRole("button", { name: "Copy handle" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("product-archive");

    await panel.getByRole("combobox", { name: "Active workspace" }).selectOption("ws_design_studio");
    await expect(panel.getByText("@design-studio", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Edit details" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "MCP connection" }).getByText("@design-studio")).toBeVisible();
    expect(state.activeId).toBe("ws_design_studio");
    expect(errors).toEqual([]);
  });

  test(`automatic connection preserves workspace and chosen permissions at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const { state, errors } = await workspaceFixture(page);
    await page.goto(`/oauth/workspace?${signedQuery}`);
    await expect(page.getByRole("radio", { name: /Field notes @field-notes/ })).toBeChecked();
    await expect(page.getByText("ws_field_notes", { exact: false })).toHaveCount(0);
    await page.getByText("Design studio", { exact: true }).click();
    await expect(page.getByRole("radio", { name: /Design studio @design-studio/ })).toBeChecked();
    await checkSurface(page, ".oauth-panel", `oauth-workspace-select-${viewport.width}.png`);
    await page.getByRole("button", { name: "Continue with workspace" }).click();
    await expect(page.getByRole("heading", { name: "Authorize Research assistant" })).toBeVisible();
    expect(state.activeId).toBe("ws_design_studio");
    expect(state.continued).toHaveLength(1);
    expect(state.continued[0].postLogin).toBe(true);
    expect(new URLSearchParams(state.continued[0].oauth_query).get("sig")).toBe("browser-fixture-signature");
    await expect(page.getByText(/on your behalf in Design studio/)).toBeVisible();
    const admin = page.getByRole("checkbox", { name: /Manage usage allowance grants and revocations/ });
    await expect(admin).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: /Run workspace tools/ })).toBeChecked();
    await page.getByRole("checkbox", { name: /Run workspace tools/ }).uncheck();
    await admin.check();
    await checkSurface(page, ".oauth-panel", `oauth-permissions-${viewport.width}.png`);
    const changeWorkspace = page.getByRole("link", { name: "Choose a different workspace" });
    await expect(changeWorkspace).toHaveAttribute("href", `/oauth/workspace?${signedQuery}`);
    await page.getByRole("button", { name: "Authorize client", exact: true }).click();
    await expect.poll(() => state.consent.length).toBe(1);
    expect(state.consent[0].accept).toBe(true);
    expect(state.consent[0].scope?.split(" ")).toEqual(["openid", "tools:read", "usage:read", "admin:allowances:write"]);
    expect(new URLSearchParams(state.consent[0].oauth_query).get("scope")).toBe(consentScopes.join(" "));
    await changeWorkspace.click();
    await expect(page.getByRole("radio", { name: /Design studio @design-studio/ })).toBeChecked();
    await page.getByRole("link", { name: "Manage your workspaces" }).click();
    await expect(page.getByRole("region", { name: "Your workspaces" })).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/settings#workspaces$/);
    expect(errors).toEqual([]);
  });

  test(`manual client setup distinguishes automatic registration and hides saved secrets at ${viewport.width}px`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize(viewport);
    const { state, errors } = await workspaceFixture(page);
    await page.goto("/dashboard/settings");
    const guide = page.getByRole("region", { name: "MCP connection" });
    await expect(guide.getByText(/Compatible agents register automatically/)).toBeVisible();
    await guide.getByRole("link", { name: "Manage OAuth clients" }).click();
    await expect(page.getByRole("heading", { name: "OAuth clients", exact: true })).toBeVisible();
    const mcpUrl = new URL("/mcp", page.url()).href;
    await expect(page.getByRole("textbox", { name: "MCP URL" })).toHaveValue(mcpUrl);
    await page.getByRole("button", { name: "Copy mcp url" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(mcpUrl);
    await expect(page.getByText(/Create a client here only if your agent asks/)).toBeVisible();
    await page.getByRole("button", { name: "Create client", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Client name" })).toBeFocused();
    await page.getByRole("textbox", { name: "Client name" }).fill("Research assistant");
    await page.getByRole("textbox", { name: "Redirect URLs" }).fill("https://agent.example.test/oauth/callback");
    await page.getByText("Platform admin permissions", { exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "Manage usage allowance grants and revocations", exact: true })).not.toBeChecked();
    await page.getByRole("checkbox", { name: "Read usage allowances", exact: true }).check();
    await checkSurface(page, ".oauth-clients-page", `oauth-client-setup-${viewport.width}.png`);
    await page.locator("form").getByRole("button", { name: "Create client", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Save your client secret" })).toBeFocused();
    await expect(page.getByLabel("Client secret", { exact: true })).toHaveAttribute("type", "password");
    await expect(page.getByLabel("Client ID", { exact: true })).toHaveValue("browser-manual-client");
    expect(state.clients[0].scope).toBe("openid offline_access tools:read runs:read artifacts:read admin:allowances:read");
    await page.getByRole("button", { name: "Copy client secret" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("browser-only-fixture-secret");
    await checkSurface(page, ".oauth-clients-page", `oauth-client-created-${viewport.width}.png`);
    await page.getByRole("button", { name: "I’ve saved the credentials" }).click();
    await expect(page.getByLabel("Client secret", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Research assistant", exact: true })).toBeVisible();
    await expect(page.getByLabel("Client secret", { exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
