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

const toolId = `tool_${"1".repeat(32)}`;
const toolVersionId = `tver_${"2".repeat(32)}`;
const artifactId = `art_${"3".repeat(32)}`;
const artifactVersionId = `aver_${"4".repeat(32)}`;
const runId = `run_${"5".repeat(32)}`;

const browserTool = {
  id: toolId,
  key: "test.image.fixture",
  name: "Test-only image tool",
  category: "image",
  summary: "A browser-test contract fixture.",
  lifecycle: "published",
  activeVersionId: toolVersionId,
  version: 1,
};

const browserArtifactVersion = {
  id: artifactVersionId,
  sequence: 1,
  sha256: "a".repeat(64),
  contentMd5: `${"A".repeat(22)}==`,
  sizeBytes: 4096,
  mimeType: "image/png",
  width: 64,
  height: 64,
  durationMs: null,
  source: "generated",
  sourceRunId: runId,
  parentVersionId: null,
  metadata: {},
  verificationStatus: "cryptographically_verified",
  createdAt: "2030-01-01T00:00:00.000Z",
};

const browserArtifact = {
  id: artifactId,
  name: "Test-only artifact",
  mediaKind: "image",
  sourceRunId: runId,
  currentVersion: browserArtifactVersion,
  shared: false,
  createdAt: "2030-01-01T00:00:00.000Z",
};

const browserRun = {
  id: runId,
  tool: {
    key: browserTool.key,
    name: browserTool.name,
    versionId: toolVersionId,
    version: 1,
  },
  status: "succeeded",
  resultCompleteness: "complete",
  acceptedAt: "2030-01-01T00:00:00.000Z",
  startedAt: "2030-01-01T00:00:01.000Z",
  terminalAt: "2030-01-01T00:00:02.000Z",
  input: { prompt: "browser-test input" },
  reservation: {
    id: `reservation_${"6".repeat(32)}`,
    metric: "test.outputs",
    unit: "output",
    amount: "1",
    status: "committed",
    expiresAt: "2030-01-01T00:05:00.000Z",
  },
  outputSet: {
    id: `outset_${"7".repeat(32)}`,
    requestedCount: 1,
    producedCount: 1,
    completeness: "complete",
    warnings: [],
    items: [{
      ordinal: 0,
      name: "primary",
      status: "succeeded",
      artifactId,
      artifactVersionId,
      errorCode: null,
    }],
  },
};

const browserUsage = {
  generatedAt: "2030-01-01T00:03:00.000Z",
  items: [{
    metric: "test.outputs",
    unit: "output",
    period: "calendar_month",
    periodStartsAt: "2030-01-01T00:00:00.000Z",
    periodEndsAt: "2030-02-01T00:00:00.000Z",
    consumedAmount: "1",
    reservedAmount: "0",
  }],
  truncated: false,
};

const adminReleaseId = "42";
const browserAdminSnapshot = {
  version: "1.2.3-test",
  slug: "browser-test-release",
  title: "Browser test release",
  summary: "A test-only stored release snapshot.",
  gitTag: "v1.2.3-test",
  commitSha: "b".repeat(40),
  releasedAt: "2030-01-01T00:00:00.000Z",
  items: [{
    category: "improved",
    area: "Web",
    title: "Admin changelog browser coverage",
    description: "The browser test exercises stored release state.",
    sortOrder: 0,
  }],
  contentSha256: "c".repeat(64),
};

const browserAdminRelease = {
  releaseId: adminReleaseId,
  status: "draft",
  latestRevision: 1,
  publishedRevision: null,
  hasUnpublishedChanges: true,
  firstPublishedAt: null,
  lastPublishedAt: null,
  latest: browserAdminSnapshot,
  published: null,
};

const browserPublicRelease = {
  ...browserAdminSnapshot,
  slug: "browser-public-release",
  title: "Browser public release",
  summary: "A test-only published release used for responsive browser coverage.",
  items: [
    ...browserAdminSnapshot.items,
    {
      category: "security",
      area: "Web",
      title: "Forced-colors category coverage",
      description: "A test-only item verifies non-color category treatment.",
      sortOrder: 1,
    },
  ],
  revision: 1,
  publishedAt: "2030-01-01T00:05:00.000Z",
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

async function mockAuthenticatedWorkspace(
  page: Page,
  options: { readonly adminAccess?: boolean } = {},
) {
  await mockSession(page, true);
  await page.route("**/api/v1/admin/changelog**", async (route) => {
    if (!options.adminAccess) {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        headers: { "x-request-id": "req_browser-admin-denied" },
        body: JSON.stringify({
          error: {
            code: "authorization_denied",
            message: "You are not authorized to perform this action.",
            retryable: false,
            requestId: "req_browser-admin-denied",
            details: {},
          },
        }),
      });
      return;
    }

    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "GET" && pathname === "/api/v1/admin/changelog") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          releases: [{
            releaseId: browserAdminRelease.releaseId,
            version: browserAdminRelease.latest.version,
            slug: browserAdminRelease.latest.slug,
            status: browserAdminRelease.status,
            latestRevision: browserAdminRelease.latestRevision,
            publishedRevision: browserAdminRelease.publishedRevision,
            hasUnpublishedChanges: browserAdminRelease.hasUnpublishedChanges,
            updatedAt: "2030-01-01T00:01:00.000Z",
          }],
        }),
      });
      return;
    }
    if (
      request.method() === "GET"
      && pathname === `/api/v1/admin/changelog/${adminReleaseId}`
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(browserAdminRelease),
      });
      return;
    }
    await route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  });
  await page.route("**/api/auth/organization/get-organization**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(workspace) });
  });
  await page.route("**/api/auth/organization/list**", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([workspace]) });
  });
}

async function mockRegistryResources(page: Page) {
  await page.route("**/api/v1/tools**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === "/api/v1/tools"
      ? { kind: "ok", items: [browserTool], nextCursor: null }
      : {
        kind: "found",
        tool: {
          ...browserTool,
          executionMode: "async",
          maxDurationSeconds: 300,
          inputSchema: { type: "object", properties: { prompt: { type: "string" } } },
          outputSchema: { type: "object", properties: { artifactIds: { type: "array" } } },
        },
      };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/v1/artifacts**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === "/api/v1/artifacts"
      ? { kind: "ok", items: [browserArtifact], nextCursor: null }
      : { kind: "found", artifact: { ...browserArtifact, versions: [browserArtifactVersion], shares: [] } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/v1/runs**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const body = pathname === "/api/v1/runs"
      ? { kind: "ok", items: [{
        id: browserRun.id,
        tool: browserRun.tool,
        status: browserRun.status,
        resultCompleteness: browserRun.resultCompleteness,
        acceptedAt: browserRun.acceptedAt,
        startedAt: browserRun.startedAt,
        terminalAt: browserRun.terminalAt,
      }], nextCursor: null }
      : { kind: "found", run: browserRun };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/v1/events", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ': connected\n\nevent: relay.resynchronized\ndata: {"lastEventId":null}\nretry: 60000\n\n',
    });
  });
  await page.route("**/api/v1/usage**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ kind: "ok", usage: browserUsage }),
    });
  });
}

async function mockPublicInformation(page: Page) {
  await page.route("**/api/v1/changelog**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        pathname === `/api/v1/changelog/${browserPublicRelease.slug}`
          ? browserPublicRelease
          : { entries: [], nextCursor: null },
      ),
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
    const layout = [
      "html",
      "body",
      "#root",
      ".product-shell",
      ".product-main",
      ".product-content",
      ".product-tabs",
      ".artifact-detail-page",
      ".artifact-detail-body",
      ".artifact-ledger-section",
      ".artifact-table-scroll",
      ".artifact-table",
      ".admin-shell",
      ".admin-main",
      ".admin-content",
      ".admin-changelog-table-region",
      ".admin-changelog-table",
      ".admin-editor-layout",
      ".admin-preview-paper",
    ].flatMap((selector) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return [];
      const style = getComputedStyle(element);
      return [{
        selector,
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        width: Math.round(element.getBoundingClientRect().width),
        overflowX: style.overflowX,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth,
        gridTemplateColumns: style.gridTemplateColumns,
      }];
    });
    return {
      clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      offenders,
      layout,
    };
  });
  expect(
    overflow.scrollWidth,
    `Horizontal overflow: ${JSON.stringify({ offenders: overflow.offenders, layout: overflow.layout })}`,
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
      await expect(mobileSoonLabels).toHaveCount(0);
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

test("product resource routes expose real contract data across required widths", async ({ page }) => {
  test.setTimeout(90_000);
  await mockAuthenticatedWorkspace(page);
  await mockRegistryResources(page);

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });

    await page.goto("/dashboard/tools");
    await expect(page.getByRole("heading", { level: 1, name: "Tools" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Test-only image tool/ })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto(`/dashboard/tools/${browserTool.key}`);
    await expect(page.getByRole("heading", { level: 1, name: browserTool.key })).toBeVisible();
    await expect(page.getByText(/Execution is unavailable until a real provider/i)).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto("/dashboard/runs");
    await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
    await expect(page.getByRole("link", { name: `Open run ${runId}` })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto(`/dashboard/runs/${runId}`);
    await expect(page.getByRole("heading", { level: 1, name: runId })).toBeVisible();
    await expect(page.getByRole("link", { name: artifactId })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto("/dashboard/artifacts");
    await expect(page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open artifact Test-only artifact" })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto(`/dashboard/artifacts/${artifactId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Test-only artifact" })).toBeVisible();
    await expect(page.getByRole("table", { name: /Immutable versions/ })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto("/dashboard/usage");
    await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
    await expect(page.getByRole("table", { name: /Current consumed and reserved usage/ }))
      .toBeVisible();
    await expect(page.getByText("Receipt and breakdown data is not exposed by the current contract."))
      .toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto("/dashboard/settings");
    await expect(page.getByRole("heading", { level: 1, name: "Workspace settings" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Active workspace" }).getByText("Browser workspace"),
    ).toBeVisible();
    await expect(page.getByText("Contract defined")).toBeVisible();
    await expectNoPageOverflow(page);
  }

  for (const route of ["tools", "runs", "artifacts", "usage", "settings"] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/dashboard/${route}`);
    await waitForFonts(page);
    await expectNoSeriousAxeViolations(page);
    await page.screenshot({
      path: path.join(process.cwd(), "artifacts", "screenshots", `${route}-1440.png`),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/dashboard/${route}`);
    await page.screenshot({
      path: path.join(process.cwd(), "artifacts", "screenshots", `${route}-390.png`),
      fullPage: true,
    });
  }
});

test("admin changelog routes stay platform-scoped and responsive", async ({ page }) => {
  test.setTimeout(120_000);
  await mockAuthenticatedWorkspace(page, { adminAccess: true });

  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });

    await page.goto("/admin/changelog");
    await expect(page.getByRole("heading", { level: 1, name: "Releases" }))
      .toBeVisible();
    await expect(page.getByRole("table", {
      name: "Admin changelog releases, newest first",
    })).toBeVisible();
    await expect(page.getByText("Browser test release")).toHaveCount(0);
    const visibleScope = page.locator(".admin-scope:visible, .admin-mobile-scope:visible");
    await expect(visibleScope.getByText(/No workspace/)).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto(`/admin/changelog/${adminReleaseId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Edit 1.2.3-test" }))
      .toBeVisible();
    await expect(page.getByRole("textbox", { name: /^Title/ }))
      .toHaveValue("Browser test release");
    await expectNoPageOverflow(page);

    await page.goto(`/admin/changelog/${adminReleaseId}/preview`);
    await expect(page.getByRole("heading", { level: 1, name: "1.2.3-test" }))
      .toBeVisible();
    await expect(page.getByText("This preview is not a public page.")).toBeVisible();
    await expectNoPageOverflow(page);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/admin/changelog/${adminReleaseId}`);
  await waitForFonts(page);
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("dialog", {
    name: "Publish 1.2.3-test to the public changelog?",
  })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "admin-changelog-editor-1440.png"),
    fullPage: true,
  });

  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/admin/changelog/${adminReleaseId}/preview`);
  await waitForFonts(page);
  await expectNoSeriousAxeViolations(page);
  await page.screenshot({
    path: path.join(process.cwd(), "artifacts", "screenshots", "admin-changelog-preview-390.png"),
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
  test.setTimeout(75_000);
  await mockSession(page, false);
  await mockPublicInformation(page);

  const routes = [
    { path: "/changelog", heading: "Changelog" },
    { path: `/changelog/${browserPublicRelease.slug}`, heading: "1.2.3-test" },
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
  await mockAuthenticatedWorkspace(page, { adminAccess: true });
  await mockPublicInformation(page);
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/");
  const animationName = await page.locator(".landing-hero__diagram img").evaluate((element) =>
    getComputedStyle(element).animationName
  );
  expect(animationName).toBe("none");

  await page.goto(`/changelog/${browserPublicRelease.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: "1.2.3-test" }))
    .toBeVisible();
  await expect(page.getByText("Security", { exact: true }).first()).toBeVisible();
  await expectNoPageOverflow(page);
  await expectNoSeriousAxeViolations(page);

  await page.goto(`/admin/changelog/${adminReleaseId}`);
  await expect(page.getByRole("heading", { name: "Edit 1.2.3-test" })).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const transitionDuration = await dialog.evaluate((element) =>
    getComputedStyle(element).transitionDuration
  );
  expect(Number.parseFloat(transitionDuration)).toBeLessThanOrEqual(0.00001);
  await expectNoSeriousAxeViolations(page);
  await page.keyboard.press("Escape");

  await page.goto(`/admin/changelog/${adminReleaseId}/preview`);
  await expect(page.getByText("This preview is not a public page.")).toBeVisible();
  await expectNoPageOverflow(page);

  // Browser automation does not expose toolbar zoom. Halving the CSS viewport
  // exercises the same 200% reflow condition without the inaccurate CSS zoom property.
  await page.setViewportSize({ width: 512, height: 450 });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "1.2.3-test" }))
    .toBeVisible();
  await expectNoPageOverflow(page);
});
