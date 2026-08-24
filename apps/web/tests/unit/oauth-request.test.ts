import { describe, expect, it } from "vitest";
import { describeScope, readOAuthRequest } from "../../src/auth/oauth-request";

describe("readOAuthRequest", () => {
  it("reads client, deduplicated scopes, and signed claims", () => {
    const request = readOAuthRequest(
      "?client_id=https%3A%2F%2Fclient.example%2Fmetadata&scope=openid%20mcp%3Atools%20openid&claims=%7B%22userinfo%22%3A%7B%22email%22%3Anull%7D%7D",
    );

    expect(request).toMatchObject({
      clientId: "https://client.example/metadata",
      scopes: ["openid", "mcp:tools"],
      scopeValue: "openid mcp:tools openid",
    });
    expect(request?.claims).toEqual({ userinfo: { email: null } });
  });

  it("fails closed when required values or claims are malformed", () => {
    expect(readOAuthRequest("?scope=openid")).toBeNull();
    expect(readOAuthRequest("?client_id=client&claims=not-json")).toBeNull();
  });

  it("keeps unknown scopes visible instead of silently dropping them", () => {
    expect(describeScope("custom:scope")).toMatchObject({
      scope: "custom:scope",
      title: "Requested permission",
    });
  });
});
