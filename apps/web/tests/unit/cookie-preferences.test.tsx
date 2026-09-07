import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CookiePreferences } from "../../src/components/layout/CookiePreferences";
import { LegalLinks } from "../../src/components/layout/LegalLinks";
import { CONSENT_MAX_AGE_MS, readAnalyticsChoice, saveAnalyticsChoice } from "../../src/lib/analytics-consent";

afterEach(() => { cleanup(); vi.restoreAllMocks(); saveAnalyticsChoice("denied"); window.localStorage.clear(); });

it("starts with essentials and allows an explicit choice to be changed from the footer", async () => {
  const user = userEvent.setup();
  render(<><CookiePreferences configured /><LegalLinks /></>);
  expect(readAnalyticsChoice()).toBeNull();
  await user.click(screen.getByRole("button", { name: "Essential only" }));
  expect(readAnalyticsChoice()).toBe("denied");
  expect(screen.queryByRole("region", { name: "Your privacy choices" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Cookie settings" }));
  await user.click(screen.getByRole("button", { name: "Allow analytics" }));
  expect(readAnalyticsChoice()).toBe("granted");
});

it("expires a saved choice after 180 days and rejects future or malformed timestamps", () => {
  window.localStorage.setItem("zaf_consent", "granted");
  for (const at of [String(Date.now() - CONSENT_MAX_AGE_MS), String(Date.now() + 60000), "not-a-date"]) {
    window.localStorage.setItem("zaf_consent_at", at);
    expect(readAnalyticsChoice()).toBeNull();
  }
});

it("honors withdrawal even when browser storage cannot be written", () => {
  saveAnalyticsChoice("granted");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  saveAnalyticsChoice("denied");
  expect(readAnalyticsChoice()).toBe("denied");
});
