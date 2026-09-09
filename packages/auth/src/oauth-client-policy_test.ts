import {
  requireS256Authorization,
  safeClientRedirect,
  validateRelayClientMetadata,
} from "./oauth-client-policy.ts";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createMcpOAuthOptions } from "./oauth.ts";
import { APIError } from "better-auth/api";

Deno.test("OAuth self-service requires a session and fresh sign-in for mutations", async () => {
  const queryable = {
    query: <T>() => Promise.resolve({ rows: [] as T[] }),
  };
  const options = createMcpOAuthOptions(
    queryable,
    new URL("https://relay.test"),
  );
  const privileges = options.clientPrivileges!;
  type Input = Parameters<typeof privileges>[0];
  const request = {
    user: { id: "operator" },
    session: { createdAt: new Date() },
    headers: new Headers(),
    action: "create",
  } as Input;
  const stale = {
    ...request,
    session: { ...request.session, createdAt: new Date(0) },
  } as Input;
  for (const action of ["create", "update", "rotate", "delete"] as const) {
    assertEquals(await privileges({ ...request, action }), true);
    await assertRejects(
      async () => await privileges({ ...stale, action }),
      APIError,
    );
  }
  for (const action of ["read", "list"] as const) {
    assertEquals(await privileges({ ...stale, action }), true);
  }
  assertEquals(
    await privileges({
      ...request,
      action: "configure-client-credentials-scopes",
    }),
    false,
  );
  assertEquals(await privileges({ ...request, user: undefined }), false);
  assertEquals(await privileges({ ...request, session: undefined }), false);
  assertEquals(options.allowDynamicClientRegistration, true);
  assertEquals(options.storeClientSecret, "hashed");
});

Deno.test("OAuth client redirect policy accepts exact HTTPS and native loopback only", () => {
  for (
    const url of [
      "https://claude.ai/api/mcp/auth_callback",
      "https://agent.example.test/callback?mode=connect",
      "http://localhost:3210/callback",
      "http://127.0.0.1:3210/callback",
      "http://[::1]:3210/callback",
    ]
  ) {
    assertEquals(safeClientRedirect(url), true, url);
  }
  for (
    const url of [
      "http://agent.example.test/callback",
      "https://*.example.com/callback",
      "https://user:secret@example.com/cb",
      "https://agent.example.com/cb#",
      "https://127.0.0.1/cb",
      "http://127.1/cb",
      "http://0x7f000001/cb",
      "http://localhost.evil.test/cb",
      "http://localhost/cb path",
      "https://localhost/cb",
      "file:///callback",
    ]
  ) {
    assertEquals(safeClientRedirect(url), false, url);
  }
});

Deno.test("client registration refuses privilege overrides and remote metadata transports", () => {
  validateRelayClientMetadata({
    redirect_uris: ["https://agent.example.test/cb"],
    token_endpoint_auth_method: "none",
  });
  for (
    const payload of [
      { jwks_uri: "https://evil.test/keys" },
      { user_id: "admin" },
      { client_credentials_scopes: ["admin:oauth:write"] },
      { skip_consent: true },
      { require_pkce: false },
      { grant_types: ["client_credentials"] },
      { redirect_uris: [] },
      { token_endpoint_auth_method: "private_key_jwt" },
    ]
  ) {
    assertThrows(() => validateRelayClientMetadata(payload), APIError);
  }
  requireS256Authorization({
    code_challenge_method: "S256",
    code_challenge: "a".repeat(43),
  });
  for (
    const query of [undefined, {}, {
      code_challenge_method: "plain",
      code_challenge: "a".repeat(43),
    }, { code_challenge_method: "S256", code_challenge: "short" }]
  ) {
    assertThrows(() => requireS256Authorization(query), APIError);
  }
});
