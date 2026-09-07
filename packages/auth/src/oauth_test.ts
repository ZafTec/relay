import { mcp } from "@better-auth/mcp";
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins/jwt";
import type { Queryable, WorkspaceRole } from "./authorization.ts";
import {
  authorizeMcpAccessTokenClaims,
  createMcpOAuthOptions,
  parseMcpAccessTokenClaims,
  RELAY_AUTHORIZATION_SCOPES,
  RELAY_MCP_RESOURCE_SCOPES,
  RELAY_OAUTH_SCOPES,
  RELAY_WORKSPACE_ID_CLAIM,
  relayMcpResource,
  requireCurrentVerifiedEmail,
  requireMcpScopes,
} from "./oauth.ts";

function membershipFixture(role: WorkspaceRole | null): {
  queryable: Queryable;
  calls: Array<{ text: string; params?: unknown[] }>;
} {
  const calls: Array<{ text: string; params?: unknown[] }> = [];
  return {
    calls,
    queryable: {
      query<T>(text: string, params?: unknown[]) {
        calls.push({ text, params });
        const rows = role === null ? [] : [{ role }];
        return Promise.resolve({ rows: rows as unknown as T[] });
      },
    },
  };
}

Deno.test("current provider response must contain a verified usable email", async () => {
  let response = {
    user: { email: "person@example.com", emailVerified: true },
    data: { provider: "fixture" },
  };
  const getUserInfo = requireCurrentVerifiedEmail(() =>
    Promise.resolve(response)
  );

  assertEquals(await getUserInfo(), response);

  response = {
    user: { email: "person@example.com", emailVerified: false },
    data: { provider: "fixture" },
  };
  assertEquals(await getUserInfo(), null);

  response = {
    user: { email: "   ", emailVerified: true },
    data: { provider: "fixture" },
  };
  assertEquals(await getUserInfo(), null);
});

Deno.test("provider verification is evaluated again on every callback", async () => {
  let verified = true;
  let calls = 0;
  const getUserInfo = requireCurrentVerifiedEmail(() => {
    calls += 1;
    return Promise.resolve({
      user: { email: "person@example.com", emailVerified: verified },
      data: {},
    });
  });

  assertEquals((await getUserInfo())?.user.emailVerified, true);
  verified = false;
  assertEquals(await getUserInfo(), null);
  assertEquals(calls, 2);
});

Deno.test("Relay MCP OAuth constants and resource policy are exact", () => {
  const { queryable } = membershipFixture("member");
  const baseUrl = new URL("http://localhost:8000/nested/base");
  const resource = "http://localhost:8000/mcp";
  const options = createMcpOAuthOptions(queryable, baseUrl);

  assertEquals(RELAY_AUTHORIZATION_SCOPES, [
    "openid",
    "profile",
    "email",
    "offline_access",
  ]);
  assertEquals(RELAY_MCP_RESOURCE_SCOPES, [
    "tools:read",
    "tools:execute",
    "runs:read",
    "runs:cancel",
    "artifacts:read",
    "artifacts:write",
    "artifacts:share",
    "usage:read",
    "notifications:read",
    "notifications:write",
  ]);
  assertEquals(RELAY_OAUTH_SCOPES, [
    ...RELAY_AUTHORIZATION_SCOPES,
    ...RELAY_MCP_RESOURCE_SCOPES,
  ]);
  assertEquals(
    RELAY_WORKSPACE_ID_CLAIM,
    "urn:relay:workspace_id",
  );
  assertEquals(relayMcpResource(baseUrl), resource);
  assertEquals(options.resource, resource);
  assertEquals(options.resources, [{
    identifier: resource,
    allowedScopes: [...RELAY_MCP_RESOURCE_SCOPES],
  }]);
});

Deno.test("MCP access-token claims are strict and current authorization is rechecked", async () => {
  const claims = {
    sub: "user_1",
    client_id: "client_1",
    scope: "tools:read runs:read tools:read",
    [RELAY_WORKSPACE_ID_CLAIM]: "workspace_1",
  };
  assertEquals(parseMcpAccessTokenClaims(claims), {
    actorUserId: "user_1",
    workspaceId: "workspace_1",
    clientId: "client_1",
    scopes: ["tools:read", "runs:read"],
  });
  assertEquals(
    parseMcpAccessTokenClaims({ ...claims, scope: ["tools:read"] }),
    null,
  );
  assertEquals(parseMcpAccessTokenClaims({ ...claims, client_id: "" }), null);
  requireMcpScopes(["tools:read", "runs:read"], ["runs:read"]);
  assertThrows(() => requireMcpScopes(["tools:read"], ["runs:read"]));

  const calls: Array<{ text: string; params?: unknown[] }> = [];
  const queryable: Queryable = {
    query<T>(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return Promise.resolve({ rows: [{ authorized: true }] as T[] });
    },
  };
  const resource = "https://relay.example.test/mcp";
  assertEquals(
    await authorizeMcpAccessTokenClaims(queryable, resource, claims),
    parseMcpAccessTokenClaims(claims),
  );
  assertEquals(calls[0].params, [
    "client_1",
    "workspace_1",
    "user_1",
    resource,
  ]);
  assertEquals(calls[0].text.includes("client.disabled is not true"), true);
  assertEquals(calls[0].text.includes("resource.disabled is not true"), true);
  assertEquals(calls[0].text.includes("auth.member"), true);

  const denied: Queryable = {
    query<T>() {
      return Promise.resolve({ rows: [{ authorized: false }] as T[] });
    },
  };
  assertEquals(
    await authorizeMcpAccessTokenClaims(denied, resource, claims),
    null,
  );
});

Deno.test("pinned MCP discovery disables DCR and the legacy token route", async () => {
  const { queryable } = membershipFixture("member");
  const baseUrl = new URL("http://localhost:8000");
  const resource = relayMcpResource(baseUrl);
  const auth = betterAuth({
    baseURL: baseUrl.toString(),
    basePath: "/api/auth",
    secret: "test-only-secret-" + "x".repeat(24),
    disabledPaths: ["/token"],
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      mcp(createMcpOAuthOptions(queryable, baseUrl)),
    ],
  });

  const authorizationMetadataResponse = await auth.handler(
    new Request(
      "http://localhost:8000/.well-known/oauth-authorization-server/api/auth",
    ),
  );
  assertEquals(authorizationMetadataResponse.status, 200);
  const authorizationMetadata = await authorizationMetadataResponse
    .json() as Record<string, unknown>;
  assertEquals(authorizationMetadata.registration_endpoint, undefined);
  assertEquals(authorizationMetadata.grant_types_supported, [
    "authorization_code",
    "refresh_token",
  ]);
  assertEquals(
    authorizationMetadata.scopes_supported,
    [...RELAY_OAUTH_SCOPES],
  );

  const resourceMetadataResponse = await auth.handler(
    new Request(
      "http://localhost:8000/.well-known/oauth-protected-resource/mcp",
    ),
  );
  assertEquals(resourceMetadataResponse.status, 200);
  assertEquals(await resourceMetadataResponse.json(), {
    resource,
    authorization_servers: ["http://localhost:8000/api/auth"],
    bearer_methods_supported: ["header"],
    dpop_signing_alg_values_supported: [
      "EdDSA",
      "ES256",
      "ES512",
      "PS256",
      "RS256",
    ],
    scopes_supported: [...RELAY_MCP_RESOURCE_SCOPES],
  });

  const registrationResponse = await auth.handler(
    new Request("http://localhost:8000/api/auth/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://localhost:3000/callback"],
      }),
    }),
  );
  assertEquals(registrationResponse.status, 403);
  assertEquals(await registrationResponse.json(), {
    error: "access_denied",
    error_description: "Client registration is disabled",
  });

  const tokenResponse = await auth.handler(
    new Request("http://localhost:8000/api/auth/token"),
  );
  assertEquals(tokenResponse.status, 404);
});

Deno.test("Relay resource scopes require workspace selection and membership", async () => {
  const member = membershipFixture("admin");
  const options = createMcpOAuthOptions(
    member.queryable,
    new URL("http://localhost:8000"),
  );
  const postLogin = options.postLogin!;
  const now = new Date();
  const resourceContext: Parameters<typeof postLogin.shouldRedirect>[0] = {
    headers: new Headers(),
    user: {
      id: "user_1",
      createdAt: now,
      updatedAt: now,
      email: "person@example.com",
      emailVerified: true,
      name: "Test User",
    },
    session: {
      id: "session_1",
      createdAt: now,
      updatedAt: now,
      userId: "user_1",
      expiresAt: new Date(now.getTime() + 60_000),
      token: "session-token",
      activeOrganizationId: "workspace_1",
    },
    scopes: [...RELAY_MCP_RESOURCE_SCOPES],
  };
  const identityContext = {
    ...resourceContext,
    scopes: [...RELAY_AUTHORIZATION_SCOPES],
  } as Parameters<typeof postLogin.shouldRedirect>[0];

  assertEquals(postLogin.page, "/oauth/workspace");
  assertEquals(await postLogin.shouldRedirect(resourceContext), false);
  assertEquals(await postLogin.shouldRedirect(identityContext), false);
  assertEquals(
    await postLogin.consentReferenceId(resourceContext),
    "workspace_1",
  );
  assertEquals(member.calls.length, 2);
  assertEquals(member.calls[0].params, ["workspace_1", "user_1"]);
  assertEquals(await postLogin.consentReferenceId(identityContext), undefined);
  assertEquals(member.calls.length, 2);

  const missingWorkspaceContext = {
    ...resourceContext,
    session: { ...resourceContext.session, activeOrganizationId: null },
  } as Parameters<typeof postLogin.consentReferenceId>[0];
  assertEquals(
    await postLogin.shouldRedirect({
      ...missingWorkspaceContext,
      headers: new Headers(),
    }),
    true,
  );
  await assertRejects(async () =>
    await postLogin.consentReferenceId(missingWorkspaceContext)
  );

  const nonmember = membershipFixture(null);
  const nonmemberPostLogin = createMcpOAuthOptions(
    nonmember.queryable,
    new URL("http://localhost:8000"),
  ).postLogin!;
  assertEquals(await nonmemberPostLogin.shouldRedirect(resourceContext), true);
  await assertRejects(async () =>
    await nonmemberPostLogin.consentReferenceId(resourceContext)
  );
});

Deno.test("workspace access-token claims fail closed on stale context", async () => {
  const member = membershipFixture("owner");
  const options = createMcpOAuthOptions(
    member.queryable,
    new URL("http://localhost:8000"),
  );
  const claimsCallback = options.customAccessTokenClaims!;
  const validContext = {
    user: { id: "user_1" },
    referenceId: "workspace_1",
    scopes: [...RELAY_MCP_RESOURCE_SCOPES],
    resources: ["http://localhost:8000/mcp"],
  } as Parameters<typeof claimsCallback>[0];

  assertEquals(await claimsCallback(validContext), {
    [RELAY_WORKSPACE_ID_CLAIM]: "workspace_1",
  });
  assertEquals(member.calls[0].params, ["workspace_1", "user_1"]);

  const identityOnlyContext = {
    ...validContext,
    referenceId: undefined,
    scopes: [...RELAY_AUTHORIZATION_SCOPES],
  } as Parameters<typeof claimsCallback>[0];
  assertEquals(await claimsCallback(identityOnlyContext), {});
  assertEquals(
    await claimsCallback({
      ...validContext,
      resources: ["http://localhost:8000/another-resource"],
    }),
    {},
  );

  await assertRejects(async () =>
    await claimsCallback({ ...validContext, user: null })
  );
  await assertRejects(async () =>
    await claimsCallback({ ...validContext, referenceId: undefined })
  );

  const nonmember = membershipFixture(null);
  const nonmemberClaims = createMcpOAuthOptions(
    nonmember.queryable,
    new URL("http://localhost:8000"),
  ).customAccessTokenClaims!;
  await assertRejects(async () => await nonmemberClaims(validContext));
});
