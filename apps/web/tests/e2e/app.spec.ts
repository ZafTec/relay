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
  await page.route("**/api/v1/notifications", (route) => route.fulfill({
    json: { notifications: { configured: false, completed: false, failed: false, deliveries: [] } },
  }));
  await page.route("**/api/v1/admin/access", (route) => route.fulfill({
    status: options.adminAccess ? 200 : 403,
    json: options.adminAccess ? { allowed: true } : { error: { code: "authorization_denied" } },
  }));
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
  await page.route("**/api/v1/workspaces", (route) => route.fulfill({
    json: { items: [{ ...workspace, role: "owner", personal: true }], maxOwnedWorkspaces: 20 },
  }));
  await page.route("**/api/v1/notifications", (route) => route.fulfill({
    json: { notifications: { configured: true, completed: false, failed: false, deliveries: [] } },
  }));
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
    if (new URL(route.request().url()).pathname === "/api/v1/usage/storage") {
      await route.fulfill({ json: { kind: "ok", storage: {
        generatedAt: browserUsage.generatedAt, storedBytes: "1073741824", reservedBytes: "0",
        cleanupPendingBytes: "0", limitBytes: "2147483648", availableBytes: "1073741824",
      } } });
      return;
    }
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

const productionTools = [
  { key: "image.generate.gpt-image-2", name: "GPT Image 2", category: "image", summary: "Generate images from a text prompt." },
  { key: "image.generate.flux-2-pro", name: "FLUX.2 Pro", category: "image", summary: "Generate images with optional reference images." },
  { key: "document.ocr", name: "Document OCR", category: "document", summary: "Extract text, tables, and structured data from a document." },
  { key: "image.edit.gpt-image-2", name: "GPT Image 2 Edit", category: "image", summary: "Edit with reference images and an optional mask." },
  { key: "image.edit.flux-2-pro", name: "FLUX.2 Pro Edit", category: "image", summary: "Edit with reference images." },
  { key: "image.generate.mai-image-2.5", name: "MAI Image 2.5", category: "image", summary: "Generate a PNG image." },
  { key: "image.edit.mai-image-2.5", name: "MAI Image 2.5 Edit", category: "image", summary: "Edit a PNG or JPEG image." },
  { key: "image.generate.mai-image-2.5-flash", name: "MAI Image 2.5 Flash", category: "image", summary: "Generate a PNG image." },
  { key: "image.edit.mai-image-2.5-flash", name: "MAI Image 2.5 Flash Edit", category: "image", summary: "Edit a PNG or JPEG image." },
];

async function mockProductionTools(page: Page) {
  await mockAuthenticatedWorkspace(page, { adminAccess: true });
  await mockRegistryResources(page);
  await page.route("**/api/v1/tools**", async (route) => {
    const key = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-1) ?? "");
    const tools = productionTools.map((tool) => ({ ...browserTool, ...tool }));
    const selected = tools.find((tool) => tool.key === key);
    await route.fulfill({
      json: selected
        ? { kind: "found", tool: { ...selected, executionMode: "async", maxDurationSeconds: 300, inputSchema: { type: "object" }, outputSchema: { type: "object" } } }
        : { kind: "ok", items: tools, nextCursor: null },
    });
  });
}

async function captureReview(page: Page, name: string) {
  if (!process.env.RELAY_UI_REVIEW_PHASE) return;
  await waitForFonts(page);
  await page.screenshot({
    path: path.join("artifacts", `pr35-${process.env.RELAY_UI_REVIEW_PHASE}`, `${name}.png`),
    fullPage: true,
  });
}

test("MVP tool composers remain accessible and usable on desktop and mobile", async ({ page }) => {
  test.setTimeout(180_000);
  await mockProductionTools(page);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const tool of productionTools) {
      await page.goto(`/dashboard/tools/${tool.key}`);
      await expect(page.getByRole("heading", { name: "Create run", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Create run", exact: true })).toBeEnabled();
      await captureReview(page, `${tool.key}-${width}`);
      await expectNoPageOverflow(page);
      await expectNoSeriousAxeViolations(page);
    }
  }
});

test("creating a run brings an accessible confirmation into view", async ({ page }) => {
  await mockProductionTools(page);
  let calls = 0;
  let confirmRun: () => void = () => {};
  await page.route("**/api/v1/runs", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    calls += 1;
    await new Promise<void>((resolve) => { confirmRun = resolve; });
    await route.fulfill({ status: 202, headers: { location: `/api/v1/runs/${runId}` }, json: {
      kind: "accepted",
      replayed: false,
      queueReason: "awaiting_dispatch",
      run: {
        ...browserRun,
        tool: { ...browserRun.tool, key: "image.generate.gpt-image-2", name: "GPT Image 2" },
        input: route.request().postDataJSON().input,
        status: "queued", startedAt: null, terminalAt: null,
        resultCompleteness: null, outputSet: null, reservation: null,
      },
    } });
  });
  for (const colorScheme of ["light", "dark"] as const) {
    for (const width of [1440, 390]) {
      await page.emulateMedia({ colorScheme, reducedMotion: "reduce" });
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/dashboard/tools/image.generate.gpt-image-2");
      await page.getByLabel("Prompt", { exact: true }).fill("A quiet mountain lake");
      const submit = page.getByRole("button", { name: "Create run", exact: true });
      await submit.scrollIntoViewIfNeeded();
      await submit.focus();
      const previousCalls = calls;
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Creating run", exact: true })).toBeDisabled();
      await expect.poll(() => calls).toBe(previousCalls + 1);
      confirmRun();
      const confirmation = page.getByRole("region", { name: "Run accepted" });
      await expect(confirmation).toBeFocused();
      await expect(confirmation).toBeInViewport({ ratio: 1 });
      await expect(confirmation.getByText("Queued", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("A quiet mountain lake");
      await page.keyboard.press("Tab");
      await expect(confirmation.getByRole("link", { name: "View run" })).toBeFocused();
      await expectNoPageOverflow(page);
      await expectNoSeriousAxeViolations(page);
      await page.screenshot({ path: path.join("artifacts", "review", `run-accepted-${colorScheme}-${width}.png`) });
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/dashboard/runs/${runId}$`));
    }
  }
});

test("MVP upload and sign-out dialogs retain focus and fit small screens", async ({ page }) => {
  await mockProductionTools(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dashboard/artifacts");
    await page.getByRole("button", { name: "Upload artifact", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Upload artifact", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("File", { exact: true }).setInputFiles({ name: "quarterly-report.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nReview fixture") });
    await expect(dialog.getByLabel("Artifact name", { exact: true })).toHaveValue("quarterly-report.pdf");
    await expect(dialog.getByLabel("Media kind", { exact: true })).toHaveValue("document");
    await captureReview(page, `upload-${width}`);
    await expectNoPageOverflow(page);
    await expectNoSeriousAxeViolations(page);
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    const signOut = page.getByRole("button", { name: "Sign out", exact: true }).filter({ visible: true });
    await signOut.click();
    await expect(page.getByRole("alertdialog")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("alertdialog").getByRole("button", { name: "Sign out", exact: true })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(signOut).toBeFocused();
  }
});

test("MVP capacity policies remain readable across desktop and mobile", async ({ page }) => {
  test.setTimeout(90_000);
  await mockProductionTools(page);
  const configuration = { leaseDefaults: { maxRunning: 50 }, submissionRateDefaults: { providerPerMinute: 12, workspacePerProviderPerMinute: 4 } };
  const policy = { policyId: "42", scopeType: "tool", scopeId: toolId, revision: 1, configuration, canonicalJson: JSON.stringify(configuration), immutableHash: "a".repeat(64), effectiveAt: "2026-08-26T10:00:00.000Z", expiresAt: null };
  await page.route("**/api/v1/admin/capacity-policies**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    await route.fulfill({ json: pathname === "/api/v1/admin/capacity-policies" ? { policies: [policy] } : { policy } });
  });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/admin/capacity");
    await expect(page.getByRole("heading", { name: "Capacity policies", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Policy detail", exact: true })).toBeVisible();
    await captureReview(page, `capacity-${width}`);
    await expectNoPageOverflow(page);
    await expectNoSeriousAxeViolations(page);
  }
});

test("landing explains the product honestly across required widths", async ({ page }) => {
  await mockSession(page, false);
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Metered tools for agents/);
    await expect(page.getByRole("heading", { name: "Check your tool access" })).toBeVisible();
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

test("FAQ answers are keyboard accessible in both themes and on mobile", async ({ page }) => {
  await mockSession(page, false);
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const faq = page.getByRole("region", { name: "Frequently asked questions" });
      if (width === 390) await page.locator(".public-nav__menu > summary").click();
      await page.locator('.public-nav a[href="/#faq"]:visible').click();
      await expect(page.getByRole("heading", { name: "Frequently asked questions" })).toBeInViewport();
      const question = faq.locator("summary").filter({ hasText: "Does signing in give me tool access?" });
      const answer = faq.getByText(/Signing in creates or resumes your personal workspace/);
      await expect(answer).toBeHidden();
      await question.focus();
      await page.keyboard.press("Enter");
      await expect(answer).toBeVisible();
      await expectNoPageOverflow(page);
      await expectNoSeriousAxeViolations(page);
      await faq.screenshot({ path: path.join("artifacts", "review", `faq-${colorScheme}-${width}.png`) });
      await page.keyboard.press("Space");
      await expect(answer).toBeHidden();
    }
  }
});

test("compact settings and workspace switching preserve keyboard and mouse actions", async ({ page }) => {
  test.setTimeout(90_000);
  await mockAuthenticatedWorkspace(page, { adminAccess: false });
  await mockRegistryResources(page);
  const other = { ...workspace, id: "ws_other", name: "Second workspace", slug: "second-workspace" };
  let selected = workspace;
  let failSwitch = true;
  await page.route("**/api/v1/workspaces", (route) => route.fulfill({
    json: { items: [workspace, other].map((item) => ({ ...item, role: "owner", personal: item.id === workspace.id })), maxOwnedWorkspaces: 20 },
  }));
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({
    json: { ...identity, session: { ...identity.session, activeOrganizationId: selected.id } },
  }));
  await page.route("**/api/auth/organization/get-organization**", (route) => route.fulfill({ json: selected }));
  await page.route("**/api/auth/organization/set-active", (route) => {
    if (failSwitch) { failSwitch = false; return route.fulfill({ status: 503, json: { message: "Temporary failure" } }); }
    selected = route.request().postDataJSON().organizationId === other.id ? other : workspace;
    return route.fulfill({ json: selected });
  });
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/dashboard/settings");
      const rail = page.locator(".workspace-switcher:visible");
      await rail.getByRole("button", { name: selected.name, exact: true }).click();
      await expect(page.getByRole("option")).toHaveCount(2);
      await expectNoSeriousAxeViolations(page);
      await page.screenshot({ path: path.join("artifacts", "review", `switcher-${colorScheme}-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(rail.getByRole("button", { name: selected.name, exact: true })).toBeFocused();
      for (const label of ["Connection instructions", "Permission reference", "Current session", "Legal and privacy"]) {
        const summary = page.locator("summary").filter({ hasText: label });
        await summary.click();
        await expect(summary.locator("..")).toHaveAttribute("open", "");
      }
      await expect(page.getByRole("table", { name: "Supported MCP authorization scopes" })).toBeVisible();
      await expect(page.getByRole("checkbox", { name: /Run completed/ })).toBeEnabled();
      await expectNoPageOverflow(page);
      await expectNoSeriousAxeViolations(page);
      await page.screenshot({ path: path.join("artifacts", "review", `settings-expanded-${colorScheme}-${width}.png`), fullPage: true });
    }
  }
  await page.goto("/dashboard/settings");
  const trigger = page.locator(".workspace-switcher:visible").getByRole("button", { name: workspace.name, exact: true });
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("option")).toHaveCount(2);
  await page.keyboard.press("End");
  await expect(page.getByRole("option", { name: /Second workspace/ })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toHaveText(/could not be changed/);
  await page.getByRole("option", { name: /Second workspace/ }).click();
  await expect(page.locator(".workspace-switcher:visible").getByRole("button", { name: "Second workspace", exact: true })).toBeVisible();
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
    await expect(page.locator(".workspace-switcher:visible").getByText("Browser workspace")).toBeVisible();
    await expect(page.getByText("No overview data is exposed yet")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
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
    await expect(page.getByRole("heading", { level: 1, name: browserTool.name })).toBeVisible();
    await expect(page.getByText(/Execution is unavailable until a real provider/i)).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto("/dashboard/runs");
    await expect(page.getByRole("heading", { level: 1, name: "Runs" })).toBeVisible();
    await expect(page.getByRole("link", { name: `Open run ${runId}` })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto(`/dashboard/runs/${runId}`);
    await expect(page.getByRole("heading", { level: 1, name: browserRun.tool.name })).toBeVisible();
    await expect(page.getByRole("link", { name: artifactId })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto("/dashboard/artifacts");
    await expect(page.getByRole("heading", { level: 1, name: "Artifacts" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Open artifact Test-only artifact" })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto(`/dashboard/artifacts/${artifactId}`);
    await expect(page.getByRole("heading", { level: 1, name: "Test-only artifact" })).toBeVisible();
    await page.locator("summary").filter({ hasText: "Version history" }).click();
    await expect(page.getByRole("table", { name: /Immutable versions/ })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto("/dashboard/usage");
    await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
    await expect(page.getByRole("table", { name: /Current consumed and reserved usage/ }))
      .toBeVisible();
    await expect(page.getByText("Usage already recorded for this period."))
      .toBeVisible();
    await expectNoPageOverflow(page);

    await page.goto("/dashboard/settings");
    await expect(page.getByRole("heading", { level: 1, name: "Workspace settings" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Your workspaces" }).getByText("@browser-workspace"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Manage OAuth clients" })).toBeVisible();
    await expectNoPageOverflow(page);
  }

  for (const route of ["tools", "runs", "artifacts", "usage", "settings"] as const) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/dashboard/${route}`);
    if (route === "settings") {
      await expect(page.getByRole("heading", { level: 1, name: "Workspace settings" })).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("main")).toBeFocused();
      await page.keyboard.press("PageDown");
      await expect.poll(() => page.locator(".product-main").evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await page.locator(".product-main").evaluate((element) => element.scrollTo({ top: 0, behavior: "instant" }));
    }
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

test("operational status is available only inside the superadmin console", async ({ page }) => {
  await mockSession(page, false);
  for (const path of ["/", "/docs", "/status"]) {
    await page.goto(path);
    await expect(page.locator('a[href="/status"], a[href="/admin/status"]')).toHaveCount(0);
  }
  await expect(page.getByRole("heading", { name: "This Relay route does not exist" })).toBeVisible();
  await page.goto("/admin/status");
  await expect(page.getByRole("heading", { name: "Sign in to Relay" })).toBeVisible();
  await mockAuthenticatedWorkspace(page, { adminAccess: false });
  const diagnostics: string[] = [];
  page.on("request", (request) => { if (/\/(health\/ready|version)$/.test(request.url())) diagnostics.push(request.url()); });
  await page.goto("/admin/status");
  await expect(page.getByRole("heading", { name: "Admin access unavailable" })).toBeVisible();
  expect(diagnostics).toEqual([]);
  await mockAuthenticatedWorkspace(page, { adminAccess: true });
  await mockPublicInformation(page);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin/status");
    await expect(page.getByRole("heading", { name: "All reported checks operational" })).toBeVisible();
    await expect(page.getByText("browser-revision", { exact: true })).toBeVisible();
    await page.getByText("What this page can verify", { exact: true }).click();
    await expect(page.getByText(/historical uptime percentages/i)).toBeVisible();
    await expectNoPageOverflow(page);
    await expectNoSeriousAxeViolations(page);
    await page.screenshot({ path: path.join("artifacts", "review", `admin-status-${width}.png`), fullPage: true });
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
test("superadmin allowances support explicit grants, revocation and responsive history", async ({ page }) => {
  test.setTimeout(60_000);
  await mockAuthenticatedWorkspace(page, { adminAccess: true });
  const selected = { id: "ws_allowances_browser", name: "Relay studio", slug: "relay-studio" };
  const asOf = "2026-09-06T10:00:00.000Z";
  const grants = [
    { id: "grant-execution", key: "tools.execute", amount: null, sourceKind: "manual", effectiveAt: "2026-09-01T00:00:00.000Z", expiresAt: null, revokedAt: null as string | null, createdAt: "2026-09-01T00:00:00.000Z", operatorUserId: "operator-browser", reason: "Approved studio pilot" },
    { id: "grant-images", key: "images.generated", amount: "100.000000000", sourceKind: "manual", effectiveAt: "2026-09-01T00:00:00.000Z", expiresAt: null, revokedAt: null as string | null, createdAt: "2026-09-01T00:00:00.000Z", operatorUserId: "operator-browser", reason: "September image allowance" },
  ];
  const audit = [{ id: "2", at: asOf, action: "allowance.grant", grantId: "grant-images", operatorUserId: "operator-browser", reason: "September image allowance" }];
  let ocrAmount: string | null = null;
  await page.route("**/api/v1/admin/allowances/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST") {
      expect(request.headers()["idempotency-key"]).toBeTruthy();
      const input = request.postDataJSON();
      if (pathname.endsWith("/grant")) {
        expect(input).toEqual({ key: "ocr.requests", mode: "finite", amount: "25", effectiveAt: null, expiresAt: null, reason: "Approved OCR pilot" });
        ocrAmount = input.amount;
        await route.fulfill({ json: { grantId: "grant-ocr", operation: "grant", replayed: false } }); return;
      }
      expect(input).toEqual({ grantId: "grant-images", reason: "Image pilot ended" });
      grants[1]!.revokedAt = asOf;
      audit.unshift({ id: "3", at: asOf, action: "allowance.revoke", grantId: "grant-images", operatorUserId: "operator-browser", reason: input.reason });
      await route.fulfill({ json: { grantId: "grant-images", operation: "revoke", replayed: false } }); return;
    }
    if (pathname.endsWith("/workspaces")) { await route.fulfill({ json: { items: [selected], nextCursor: null } }); return; }
    if (pathname.endsWith("/grants")) { await route.fulfill({ json: { items: grants, nextCursor: null } }); return; }
    if (pathname.endsWith("/audit")) { await route.fulfill({ json: { items: audit, nextCursor: null } }); return; }
    await route.fulfill({ json: { workspace: selected, asOf, executionAllowed: true,
      periodStartsAt: "2026-09-01T00:00:00.000Z", periodEndsAt: "2026-10-01T00:00:00.000Z", limits: [
        { key: "images.generated", state: grants[1]!.revokedAt ? "none" : "limited", amount: grants[1]!.revokedAt ? null : "100", consumed: "12", reserved: "2", remaining: grants[1]!.revokedAt ? null : "86" },
        { key: "ocr.requests", state: ocrAmount === null ? "none" : "limited", amount: ocrAmount, consumed: "0", reserved: "0", remaining: ocrAmount },
      ] } });
  });
  for (const [name, width, height] of [["desktop", 1440, 1000], ["tablet", 900, 1100], ["mobile", 390, 844]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/admin/allowances?workspace=${selected.id}`);
    await expect(page.getByRole("heading", { name: "Allowances", exact: true })).toBeVisible();
    await expect(page.getByText("Execution enabled", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Allowance", exact: true }).selectOption("ocr.requests");
    await page.getByRole("combobox", { name: "Limit", exact: true }).selectOption("finite");
    await page.getByLabel("Number of OCR requests", { exact: true }).fill("25");
    await page.getByLabel("Reason for this change", { exact: true }).fill("Approved OCR pilot");
    await waitForFonts(page);
    await expectNoPageOverflow(page);
    expect(await page.locator(".allowance-table-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expectNoSeriousAxeViolations(page);
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, behavior: "instant" }); });
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: path.join(process.cwd(), "artifacts", "allowances", `${name}.png`), fullPage: true });
  }
  await page.getByRole("button", { name: "Add grant", exact: true }).click();
  await expect(page.getByText("Grant added. Recorded usage is preserved.")).toBeVisible();
  await expect(page.getByRole("row", { name: "OCR requests 25 0 0 25" })).toBeVisible();
  await page.getByRole("button", { name: "Revoke images", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Revoke images", exact: true })).toBeFocused();
  await page.getByLabel("Reason for this change", { exact: true }).fill("Image pilot ended");
  await page.getByRole("button", { name: "Revoke grant", exact: true }).click();
  await expect(page.getByText("Grant revoked. Recorded usage is preserved.")).toBeVisible();
  await expect(page.getByRole("row", { name: "Images Not granted 12 2 —" })).toBeVisible();
});

test("OAuth clients, superadmin invitations and notifications work across screen sizes", async ({ page }) => {
  test.setTimeout(120_000);
  await mockAuthenticatedWorkspace(page, { adminAccess: true });
  let clients: Record<string, unknown>[] = [];
  const invitationId = `sinv_${"a".repeat(32)}`;
  const invitation = { id: invitationId, email: "colleague@example.test", expiresAt: "2030-01-01T00:00:00Z" };
  let invitations: typeof invitation[] = [];
  let notifications = { configured: true, completed: false, failed: false, deliveries: [] };
  await page.route("**/api/auth/oauth2/**", async (route) => {
    if (route.request().url().endsWith("/get-clients")) return route.fulfill({ json: clients });
    if (route.request().url().endsWith("/create-client")) {
      const client = { ...route.request().postDataJSON(), client_id: "browser-fixture-client" };
      clients = [client];
      return route.fulfill({ status: 201, json: { ...client, client_secret: "browser-fixture-secret" } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.route("**/api/v1/admin/superadmins**", async (route) => {
    if (route.request().method() === "POST") { invitations = [invitation]; return route.fulfill({ json: invitation }); }
    return route.fulfill({ json: { admins: [{ userId: identity.user.id, name: identity.user.name, email: identity.user.email, grantedAt: "2026-09-07T00:00:00Z" }], invitations } });
  });
  await page.route("**/api/v1/notifications", async (route) => {
    if (route.request().method() === "PUT") notifications = { ...notifications, ...route.request().postDataJSON() };
    return route.fulfill({ json: { notifications } });
  });
  await page.route("**/api/v1/superadmin-invitations/*", (route) => route.fulfill({ json: { email: invitation.email, accepted: route.request().method() === "POST" } }));
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/dashboard/oauth-clients");
    await expect(page.getByRole("heading", { name: "OAuth clients", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Create client", exact: true }).click();
    await page.getByLabel("Client name").fill("Browser agent");
    await page.getByLabel("Redirect URLs").fill("https://agent.example.test/callback");
    await expectNoPageOverflow(page);
    await expectNoSeriousAxeViolations(page);
    await page.screenshot({ path: path.join("artifacts", "access-review", `oauth-client-${width}.png`), fullPage: true });
    await page.locator("form").getByRole("button", { name: "Create client", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Save your client secret" })).toBeFocused();
    await page.getByRole("button", { name: "I’ve saved the credentials" }).click();
    await expect(page.getByLabel("Client secret", { exact: true })).toHaveCount(0);
    await page.goto("/admin/superadmins");
    await expect(page.getByRole("heading", { name: "Superadmins", exact: true })).toBeVisible();
    await page.getByLabel("Email address").fill(invitation.email);
    await page.getByRole("button", { name: "Create invitation link" }).click();
    await expect(page.getByRole("heading", { name: "Share this invitation" })).toBeVisible();
    await expectNoPageOverflow(page);
    await expectNoSeriousAxeViolations(page);
    await page.screenshot({ path: path.join("artifacts", "access-review", `superadmins-${width}.png`), fullPage: true });
    await page.goto("/dashboard/settings");
    await expect(page.getByRole("heading", { name: "Email notifications" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: /Run completed/ })).toBeEnabled();
    await expectNoPageOverflow(page);
    await expectNoSeriousAxeViolations(page);
  }
  await page.getByRole("checkbox", { name: /Run completed/ }).check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Email preferences saved.")).toBeVisible();
  await page.goto(`/superadmin-invitations/${invitationId}`);
  await page.getByRole("button", { name: "Accept superadmin invitation" }).click();
  await expect(page.getByRole("heading", { name: "Invitation accepted" })).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});
