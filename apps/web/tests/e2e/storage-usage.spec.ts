import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import path from "node:path";

const storage = {
  generatedAt: "2030-04-12T15:30:00.000Z",
  storedBytes: "1073741824",
  reservedBytes: "314572800",
  cleanupPendingBytes: "104857600",
  limitBytes: "2147483648",
  availableBytes: "759169024",
};

for (
  const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]
) {
  test(`workspace storage is independent of tool usage at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let unavailable = false;
    await page.route(
      (url) => url.pathname.startsWith("/api/"),
      async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === "/api/auth/get-session") {
          await route.fulfill({
            json: {
              session: {
                id: "session-storage-browser",
                userId: "user-storage-browser",
                token: "test-session",
                expiresAt: "2099-01-01T00:00:00.000Z",
                activeOrganizationId: "ws_storage_browser",
              },
              user: {
                id: "user-storage-browser",
                name: "Storage Operator",
                email: "storage@example.test",
                emailVerified: true,
              },
            },
          });
        } else if (pathname === "/api/auth/organization/get-organization") {
          await route.fulfill({
            json: {
              id: "ws_storage_browser",
              name: "Field notes",
              slug: "field-notes",
            },
          });
        } else if (pathname === "/api/v1/usage/storage") {
          await route.fulfill({
            status: unavailable ? 503 : 200,
            json: unavailable
              ? { kind: "unavailable" }
              : { kind: "ok", storage },
          });
        } else if (pathname === "/api/v1/usage") {
          await route.fulfill({
            json: {
              kind: "ok",
              usage: {
                generatedAt: storage.generatedAt,
                items: [],
                truncated: false,
              },
            },
          });
        } else {
          await route.fulfill({
            status: 403,
            json: {
              error: {
                code: "authorization_denied",
                message: "Unavailable in this browser test.",
                retryable: false,
                requestId: "req_storage-browser",
                details: {},
              },
            },
          });
        }
      },
    );
    await page.goto("/dashboard/usage");
    const panel = page.getByRole("region", { name: "Storage", exact: true });
    await expect(panel.getByRole("meter")).toBeVisible();
    await expect(panel.getByText("1.0 GiB", { exact: true })).toBeVisible();
    await expect(panel.getByText("200.0 MiB", { exact: true })).toBeVisible();
    await expect(panel.getByText("100.0 MiB", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "No current tool usage", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(
        "artifacts",
        "screenshots",
        `storage-usage-${viewport.width}.png`,
      ),
      fullPage: true,
    });
    expect(
      (await new AxeBuilder({ page }).include(".usage-storage").analyze())
        .violations,
    ).toEqual([]);
    expect(
      await page.evaluate(() =>
        document.documentElement.scrollWidth <=
          document.documentElement.clientWidth
      ),
    ).toBe(true);
    unavailable = true;
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(panel.getByText("Storage usage unavailable", { exact: true }))
      .toBeVisible();
    await expect(panel.getByText("0 B", { exact: true })).toHaveCount(0);
    unavailable = false;
    await panel.getByRole("button", { name: "Retry storage" }).click();
    await expect(panel.getByText("724.0 MiB", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
