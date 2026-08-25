import { describe, expect, it } from "vitest";
import { safeReturnPath, signInPathFor } from "../../src/auth/return-url";

 describe("safeReturnPath", () => {
  it("keeps an internal path with query and hash", () => {
    expect(safeReturnPath("/oauth/consent?client_id=relay#permissions"))
      .toBe("/oauth/consent?client_id=relay#permissions");
  });

  it.each([
    "https://evil.example/dashboard",
    "//evil.example/dashboard",
    "javascript:alert(1)",
    "/\\evil.example/dashboard",
    "/sign-in",
    "dashboard",
    "",
  ])("rejects unsafe or recursive value %s", (value) => {
    expect(safeReturnPath(value)).toBe("/dashboard");
  });

  it("encodes a protected return path in the sign-in URL", () => {
    expect(signInPathFor("/dashboard?view=runs", "session-expired"))
      .toBe("/sign-in?returnTo=%2Fdashboard%3Fview%3Druns&reason=session-expired");
  });
});
