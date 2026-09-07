import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

const artifactId = `art_${"3".repeat(32)}`;
const versionId = `aver_${"4".repeat(32)}`;
const token = "A".repeat(43);
const sharePath = `/s/${token}`;
const workspace = { id: "ws_share_browser", name: "Field notes", slug: "field-notes" };
const version = {
  id: versionId,
  sequence: 1,
  sha256: "a".repeat(64),
  contentMd5: `${"A".repeat(22)}==`,
  sizeBytes: 4096,
  mimeType: "image/png",
  width: 64,
  height: 64,
  durationMs: null,
  source: "upload",
  sourceRunId: null,
  parentVersionId: null,
  metadata: {},
  verificationStatus: "cryptographically_verified",
  createdAt: "2026-09-01T00:00:00.000Z",
};

async function mockShareWorkspace(page: Page) {
  const requests: { body: unknown; key: string | undefined }[] = [];
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/auth/get-session") {
      await route.fulfill({ json: {
        session: {
          id: "session-share-browser", userId: "user-share-browser", token: "browser-test-session",
          expiresAt: "2099-01-01T00:00:00.000Z", activeOrganizationId: workspace.id,
        },
        user: { id: "user-share-browser", name: "Browser Operator", email: "operator@example.test", emailVerified: true },
      } });
    } else if (pathname === "/api/auth/organization/get-organization") {
      await route.fulfill({ json: workspace });
    } else if (pathname === "/api/auth/organization/list") {
      await route.fulfill({ json: [workspace] });
    } else if (pathname === `/api/v1/artifacts/${artifactId}/share-links`) {
      requests.push({ body: request.postDataJSON(), key: request.headers()["idempotency-key"] });
      await route.fulfill({ status: 201, headers: { location: sharePath }, json: {
        kind: "created", shareLinkId: `share_${"5".repeat(32)}`, token, publicPath: sharePath, replayed: false,
      } });
    } else if (pathname === `/api/v1/artifacts/${artifactId}`) {
      await route.fulfill({ json: { kind: "found", artifact: {
        id: artifactId, name: "Summer field notes.png", mediaKind: "image", sourceRunId: null,
        currentVersion: version, shared: false, createdAt: version.createdAt, versions: [version], shares: [],
      } } });
    } else {
      await route.fulfill({ status: 403, json: { error: {
        code: "authorization_denied", message: "Unavailable in this browser test.", retryable: false,
        requestId: "req_share-browser", details: {},
      } } });
    }
  });
  return requests;
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`share link defaults, copying, advanced controls and focus at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = await mockShareWorkspace(page);
    await page.goto(`/dashboard/artifacts/${artifactId}`);
    const trigger = page.getByRole("button", { name: "Create share link", exact: true }).first();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Create share link", exact: true });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(dialog.getByRole("combobox")).toHaveCount(0);
    await expect(dialog.getByText("Anyone with the link", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Create share link" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.locator("summary")).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(dialog.getByRole("button", { name: "Create link", exact: true })).toBeInViewport();
    await page.screenshot({ path: path.join("artifacts", "screenshots", `share-link-${viewport.width}.png`) });
    expect((await new AxeBuilder({ page }).include("[role='dialog']").analyze()).violations).toEqual([]);
    const bounds = await dialog.boundingBox();
    expect(bounds!.height).toBeLessThan(viewport.height - 24);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

    await dialog.getByText("Advanced options", { exact: true }).click();
    await expect(dialog.getByLabel("File version")).toHaveValue("follow");
    await expect(dialog.getByLabel("Link expiry")).toHaveValue("never");
    await expect(dialog.getByLabel("Open limit")).toHaveValue("unlimited");
    await expect(dialog.getByLabel("Link access")).toHaveValue("public");
    await dialog.getByText("Advanced options", { exact: true }).click();
    await dialog.getByRole("button", { name: "Create link", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Share link created" })).toBeFocused();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).toEqual({
      followCurrent: true, expiresAt: null, maxResolutions: null, requireAuth: false, contentDisposition: "inline",
    });
    expect(requests[0]!.key).toMatch(/^artifact-ui:share-create:/);
    const link = page.getByLabel("Share link", { exact: true });
    const expectedUrl = new URL(sharePath, page.url()).href;
    await expect(link).toHaveValue(expectedUrl);
    await expect(page.getByRole("button", { name: "Copy token" })).toHaveCount(0);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
        writeText: async () => { throw new Error("Clipboard disabled for this browser test"); },
      } });
    });
    await page.getByRole("button", { name: "Copy link", exact: true }).click();
    await expect(page.getByText("Copy failed. Link is selected so you can copy it manually.")).toBeVisible();
    await expect(link).toBeFocused();
    expect(await link.evaluate((input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!)).toBe(expectedUrl.length);
    await page.screenshot({ path: path.join("artifacts", "screenshots", `share-link-created-${viewport.width}.png`) });
    expect((await new AxeBuilder({ page }).include("[role='dialog']").analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(errors).toEqual([]);
  });
}
