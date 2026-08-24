import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const identity = {
  session: {
    id: "session-browser",
    userId: "user-browser",
    token: "test-session-token",
    expiresAt: "2030-01-01T00:00:00.000Z",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    activeOrganizationId: "ws_browser",
  },
  user: {
    id: "user-browser",
    name: "Browser Operator",
    email: "browser.operator@example.test",
    emailVerified: true,
    image: null,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  },
};

const workspace = {
  id: "ws_browser",
  name: "Browser workspace",
  slug: "browser-workspace",
  createdAt: "2026-08-24T00:00:00.000Z",
  metadata: null,
  logo: null,
};

async function mockSession(page: Page, authenticated: boolean) {
  await page.route("**/api/auth/get-session**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(authenticated ? identity : null),
    });
  });
}

async function mockAuthenticatedWorkspace(page: Page) {
  await mockSession(page, true);
  await page.route("**/api/auth/organization/get-organization**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspace) });
  });
  await page.route("**/api/auth/organization/list**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([workspace]) });
  });
}

async function mockPublicInformation(page: Page) {
  await page.route("**/api/v1/changelog**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ entries: [], nextCursor: null }),
    });
  });
  await page.route("**/health/ready", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ service: "api", status: "ok", checks: [] }),
    });
  });
  await page.route("**/version", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ version: "test", revision: "browser-revision" }),
    });
  });
}

async function expectNoSeriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.filter((violation) =>
    violation.impact === "serious" || violation.impact === "critical"
  );
  expect(violations).toEqual([]);
}

async function expectNoPageOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > clientWidth + 1)
      .slice(0, 8)
      .map((element) => ({
        className: element.className,
        right: Math.round(element.getBoundingClientRect().right),
        tagName: element.tagName,
      }));
    return {
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders,
    };
  });
  expect(
    overflow.scrollWidth,
    `Horizontal overflow: ${JSON.stringify(overflow.offenders)}`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

async function waitForFonts(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

test("landing explains the product honestly across required widths", async ({ page }) => {
  await mockSession(page, false);
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Metered tools for agents/);
    await expect(page.getByText("Planned, not shipped")).toBeVisible();
    await expectNoPageOverflow(page);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await waitForFonts(page);
  await expectNoSeriousAxeViolations(page);
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "landing-1440.png"),
    fullPage: true,
  });
});

test("sign-in is OAuth-only and anonymous dashboard navigation is protected", async ({ page }) => {
  await mockSession(page, false);
  await page.goto("/dashboard?view=current");
  await expect(page).toHaveURL(/\/sign-in\?returnTo=/);

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    await page.goto("/sign-in");
    await expect(page.getByRole("heading", { name: "Sign in to Relay" })).toBeVisible();
    await expect(page.locator(".auth-shell__story-title")).toBeVisible();
    await expect(page.getByRole("button", { name: /Continue with Google/ })).toBeEnabled();
    await expect(page.getByRole("button", { name: /Continue with GitHub/ })).toBeEnabled();
    await expectNoPageOverflow(page);
  }
  await expectNoSeriousAxeViolations(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/sign-in");
  await waitForFonts(page);
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "sign-in-390.png"),
    fullPage: true,
  });
});

test("dashboard uses session, workspace, and API responses without fake counts", async ({ page }) => {
  await mockAuthenticatedWorkspace(page);
  await page.route("**/api/v1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name: "Relay", status: "ok" }),
    });
  });

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.locator(".workspace-label:visible").getByText("Browser workspace")).toBeVisible();
    await expect(page.getByText("No overview data is exposed yet")).toBeVisible();
    await expect(page.getByText("Not requested")).toBeVisible();
    if (width <= 900) {
      const mobileSoonLabels = page.locator(".product-tabs .product-nav__soon");
      await expect(mobileSoonLabels).toHaveCount(5);
      await expect(mobileSoonLabels.first()).toBeVisible();
    }
    await expectNoPageOverflow(page);
  }
  await expectNoSeriousAxeViolations(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/dashboard");
  await waitForFonts(page);
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "dashboard-1440.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dashboard");
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "dashboard-390.png"),
    fullPage: true,
  });
});

test("MCP consent and workspace screens preserve signed-flow behavior", async ({ page }) => {
  await mockAuthenticatedWorkspace(page);
  await page.route("**/api/auth/oauth2/public-client**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        client_id: "https://client.example/metadata.json",
        client_name: "Approved MCP client",
        client_uri: "https://client.example",
      }),
    });
  });

  const consentPath = "/oauth/consent?client_id=https%3A%2F%2Fclient.example%2Fmetadata.json&scope=openid%20mcp%3Atools";
  const workspacePath = "/oauth/workspace?oauth_query=signed-by-server";
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    await page.goto(consentPath);
    await expect(page.getByRole("heading", { name: "Authorize Approved MCP client" })).toBeVisible();
    await expect(page.getByText("mcp:tools")).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto(workspacePath);
    await expect(page.getByRole("heading", { name: "Choose where this MCP client can act" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /Browser workspace/ })).toBeChecked();
    await expectNoPageOverflow(page);
  }
  await expectNoSeriousAxeViolations(page);

  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto(consentPath);
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "oauth-consent-1024.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(workspacePath);
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "oauth-workspace-390.png"),
    fullPage: true,
  });
});

test("public information routes stay factual, searchable, and responsive", async ({ page }) => {
  await mockSession(page, false);
  await mockPublicInformation(page);

  const routes = [
    { path: "/changelog", heading: "Changelog" },
    { path: "/docs", heading: "Quickstart" },
    { path: "/status", heading: "All reported checks operational" },
  ] as const;

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    for (const route of routes) {
      await page.goto(route.path);
      await expect(page.getByRole("heading", { level: 1, name: route.heading })).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expectNoPageOverflow(page);
    }
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/changelog");
  await expect(page.getByText("No releases published yet")).toBeVisible();
  await expect(page.getByText(/RSS/i)).toHaveCount(0);
  await page.getByText("Menu", { exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Docs" }),
  ).toBeVisible();

  await page.goto("/docs");
  await page.getByRole("searchbox", { name: "Search HTTP paths and MCP tool names" }).fill("runs:cancel");
  await expect(page.getByRole("link", { name: "relay.runs.cancel" })).toBeVisible();
  await expect(page.getByText("/api/v1/runs", { exact: true }).first()).toBeVisible();

  await page.goto("/status");
  await expect(page.getByText("test", { exact: true })).toBeVisible();
  await expect(page.getByText("browser-revision", { exact: true })).toBeVisible();
  await page.getByText("What this page can verify", { exact: true }).click();
  await expect(page.getByText(/historical uptime percentages/i)).toBeVisible();

  for (const route of routes) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(route.path);
    await waitForFonts(page);
    await expectNoSeriousAxeViolations(page);
    await page.screenshot({
      path: path.join(process.cwd(), "artifacts", "screenshots", `${route.path.slice(1)}-1440.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(route.path);
    await page.screenshot({
      path: path.join(process.cwd(), "artifacts", "screenshots", `${route.path.slice(1)}-390.png`),
      fullPage: true,
    });
  }
});

test("profile is protected and exposes only current account facts", async ({ page }) => {
  await mockAuthenticatedWorkspace(page);
  await page.route("**/api/v1", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ name: "Relay", status: "ok" }),
    });
  });

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    await page.goto("/dashboard");
    const profileLink = width <= 900
      ? page.getByRole("link", { name: "Profile", exact: true })
      : page.getByRole("link", { name: "Open profile for Browser Operator" });
    await expect(profileLink).toBeVisible();
    await profileLink.click();
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole("heading", { level: 1, name: "Profile" })).toBeVisible();
    await expect(page.getByText("Browser Operator")).toBeVisible();
    await expect(page.getByText("browser.operator@example.test")).toBeVisible();
    await expect(page.getByText("Browser workspace")).toBeVisible();
    await expect(page.getByText("ws_browser")).toBeVisible();
    await expectNoPageOverflow(page);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/profile");
  await waitForFonts(page);
  await expectNoSeriousAxeViolations(page);
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "profile-1440.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/profile");
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "profile-390.png"),
    fullPage: true,
  });
});

test("reduced motion, forced colors, and 200 percent zoom remain usable", async ({ page }) => {
  await mockSession(page, false);
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/");
  const animationName = await page.locator(".landing-hero__diagram img").evaluate((element) =>
    getComputedStyle(element).animationName
  );
  expect(animationName).toBe("none");

  // Browser automation does not expose toolbar zoom. Halving the CSS viewport
  // exercises the same 200% reflow condition without the inaccurate CSS zoom property.
  await page.setViewportSize({ width: 512, height: 450 });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expectNoPageOverflow(page);
});
