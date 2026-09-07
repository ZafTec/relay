import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import type { ProtectMcpOptions } from "@relay/auth";
import { RELAY_MCP_PROTOCOL_VERSION, RELAY_MCP_TOOL_NAMES } from "@relay/mcp";
import {
  createStubServices,
  RUN_ID,
  TOOL,
  TOOL_KEY,
  USER_ID,
  WORKSPACE_ID,
} from "../routes/test_support.ts";
import { createRelayMcpHttpHandler, type McpHttpAuth } from "./mcp.ts";

const MCP_RESOURCE = "https://relay.test/mcp";
const RESOURCE_METADATA =
  "https://relay.test/.well-known/oauth-protected-resource/mcp";
const MODERN_META = {
  [PROTOCOL_VERSION_META_KEY]: RELAY_MCP_PROTOCOL_VERSION,
  [CLIENT_INFO_META_KEY]: { name: "relay-http-test", version: "1.0.0" },
  [CLIENT_CAPABILITIES_META_KEY]: {},
};

class FakeInsufficientScopeError extends Error {
  constructor(readonly scopes: readonly string[]) {
    super("insufficient scope");
  }
}

interface FakeAuthOptions {
  readonly scopes?: readonly string[];
  readonly current?: boolean;
  readonly onProtect?: () => void;
  readonly onAuthorize?: () => void;
  readonly onProtectedRequest?: (request: Request) => void;
}

function challenge(
  status: 401 | 403,
  error?: "insufficient_scope",
  scopes: readonly string[] = [],
): Response {
  const attributes = [
    `resource_metadata="${RESOURCE_METADATA}"`,
    ...(error === undefined ? [] : [`error="${error}"`]),
    ...(scopes.length === 0 ? [] : [`scope="${scopes.join(" ")}"`]),
  ];
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Authentication required" },
    },
    {
      status,
      headers: { "www-authenticate": `Bearer ${attributes.join(", ")}` },
    },
  );
}

function fakeAuth(options: FakeAuthOptions = {}): McpHttpAuth {
  const scopes = options.scopes ?? ["tools:read"];
  const claims = {
    sub: USER_ID,
    client_id: "client_test",
    scope: scopes.join(" "),
    "urn:relay:workspace_id": WORKSPACE_ID,
  };
  return {
    mcpResource: MCP_RESOURCE,
    authorizeMcpClaims: () => {
      options.onAuthorize?.();
      return Promise.resolve(
        options.current === false ? null : {
          actorUserId: USER_ID,
          workspaceId: WORKSPACE_ID,
          clientId: "client_test",
          scopes,
        },
      );
    },
    requireMcpScopes(grantedScopes, requiredScopes) {
      const missing = requiredScopes.filter((scope) =>
        !grantedScopes.includes(scope)
      );
      if (missing.length > 0) throw new FakeInsufficientScopeError(missing);
    },
    protectMcp:
      (handler, protectOptions?: ProtectMcpOptions) => async (request) => {
        options.onProtect?.();
        options.onProtectedRequest?.(request);
        const authorization = request.headers.get("authorization");
        if (
          authorization !== "Bearer valid-token" &&
          authorization !== "DPoP valid-token"
        ) {
          return challenge(401, undefined, protectOptions?.challengeScopes);
        }
        try {
          return await handler(request, claims);
        } catch (error) {
          if (error instanceof FakeInsufficientScopeError) {
            return challenge(403, "insufficient_scope", error.scopes);
          }
          throw error;
        }
      },
  };
}

function jsonRequest(
  body: unknown,
  headers: HeadersInit = {},
): Request {
  return new Request(MCP_RESOURCE, {
    method: "POST",
    headers: {
      host: "relay.test",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer valid-token",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

for (
  const mode of [
    "default",
    "2025-06-18",
    "2025-03-26",
    RELAY_MCP_PROTOCOL_VERSION,
  ] as const
) {
  Deno.test(`official v2 HTTP client (${mode}) discovers and calls Relay tools without sessions`, async () => {
    const responses: Response[] = [];
    const requests: Request[] = [];
    const authState = { current: true };
    const handler = createRelayMcpHttpHandler({
      auth: fakeAuth(authState),
      services: createStubServices(),
      allowedHostnames: ["relay.test"],
      allowedOrigins: ["https://app.relay.test"],
      serverInfo: { name: "relay-test", version: "1.0.0" },
    });
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const original = input instanceof Request
        ? input
        : new Request(input, init);
      const headers = new Headers(original.headers);
      headers.set("host", "relay.test");
      const request = new Request(original, { headers });
      requests.push(request.clone());
      const response = await handler.fetch(request);
      responses.push(response.clone());
      return response;
    };
    const transport = new StreamableHTTPClientTransport(
      new URL(MCP_RESOURCE),
      {
        fetch,
        authProvider: { token: () => Promise.resolve("valid-token") },
        onInsufficientScope: "throw",
      },
    );
    const client = new Client(
      { name: "relay-http-test", version: "1.0.0" },
      mode === "default"
        ? {}
        : mode === RELAY_MCP_PROTOCOL_VERSION
        ? { versionNegotiation: { mode: { pin: mode } } }
        : { supportedProtocolVersions: [mode] },
    );

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assertEquals(
        listed.tools.map((tool) => tool.name).sort(),
        Object.values(RELAY_MCP_TOOL_NAMES).sort(),
      );
      const result = await client.callTool({
        name: RELAY_MCP_TOOL_NAMES.listTools,
        arguments: {},
      });
      assertEquals(result.isError, undefined);
      assertEquals(result.structuredContent, {
        kind: "ok",
        items: [],
        nextCursor: null,
      });
      assert(requests.length >= 3);
      assert(
        requests.some((request) =>
          request.headers.get("mcp-protocol-version") ===
            (mode === "default" ? "2025-11-25" : mode)
        ),
      );
      assertEquals(
        responses.some((response) => response.headers.has("mcp-session-id")),
        false,
      );
      // A successful initialization never replaces current-membership checks.
      authState.current = false;
      const revoked = await handler.fetch(jsonRequest({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/list",
        params: mode === RELAY_MCP_PROTOCOL_VERSION
          ? { _meta: MODERN_META }
          : {},
      }, {
        "mcp-protocol-version": mode === "default" ? "2025-11-25" : mode,
      }));
      assertEquals(revoked.status, 403);
    } finally {
      await client.close();
      await handler.close();
    }
  });
}

Deno.test("MCP rejects Host, Origin, and oversized bodies before authentication", async () => {
  let protectedCalls = 0;
  const handler = createRelayMcpHttpHandler({
    auth: fakeAuth({ onProtect: () => protectedCalls += 1 }),
    services: createStubServices(),
    allowedHostnames: ["relay.test"],
    allowedOrigins: ["https://app.relay.test"],
    maxBodyBytes: 32,
  });

  const invalidHost = await handler.fetch(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: { host: "attacker.test", "content-type": "application/json" },
      body: "{}",
    }),
  );
  assertEquals(invalidHost.status, 403);

  const invalidOrigin = await handler.fetch(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: {
        host: "relay.test",
        origin: "https://attacker.test",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  assertEquals(invalidOrigin.status, 403);

  const oversized = await handler.fetch(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: {
        host: "relay.test",
        "content-type": "application/json",
        "content-length": "33",
      },
      body: "{}",
    }),
  );
  assertEquals(oversized.status, 413);

  const streamedOversized = await handler.fetch(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: {
        host: "relay.test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ payload: "x".repeat(64) }),
    }),
  );
  assertEquals(streamedOversized.status, 413);
  assertEquals(protectedCalls, 0);
  await handler.close();
});

Deno.test("MCP method, content, and authentication failures are explicit", async () => {
  let protectedCalls = 0;
  const handler = createRelayMcpHttpHandler({
    auth: fakeAuth({ onProtect: () => protectedCalls += 1 }),
    services: createStubServices(),
    allowedHostnames: ["relay.test"],
  });

  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await handler.fetch(
      new Request(MCP_RESOURCE, { method, headers: { host: "relay.test" } }),
    );
    assertEquals(response.status, 405);
    assertEquals(response.headers.get("allow"), "POST");
    assertEquals(response.headers.has("mcp-session-id"), false);
  }

  const unsupportedType = await handler.fetch(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: { host: "relay.test", "content-type": "text/plain" },
      body: "{}",
    }),
  );
  assertEquals(unsupportedType.status, 415);

  const malformed = await handler.fetch(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: { host: "relay.test", "content-type": "application/json" },
      body: "{",
    }),
  );
  assertEquals(malformed.status, 400);

  const cookieOnly = await handler.fetch(
    new Request(MCP_RESOURCE, {
      method: "POST",
      headers: {
        host: "relay.test",
        "content-type": "application/json",
        cookie: "better-auth.session_token=browser-session",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
  );
  assertEquals(cookieOnly.status, 401);
  assertStringIncludes(
    cookieOnly.headers.get("www-authenticate") ?? "",
    `resource_metadata="${RESOURCE_METADATA}"`,
  );
  assertEquals(protectedCalls, 1);
  await handler.close();
});

Deno.test("MCP notifications, Accept negotiation, and legacy initialization remain stateless", async () => {
  const handler = createRelayMcpHttpHandler({
    auth: fakeAuth(),
    services: createStubServices(),
    allowedHostnames: ["relay.test"],
  });

  const notification = await handler.fetch(jsonRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: { _meta: MODERN_META },
  }));
  assertEquals(notification.status, 202);
  assertEquals(notification.headers.has("mcp-session-id"), false);

  const unacceptable = await handler.fetch(jsonRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: { _meta: MODERN_META },
    },
    { accept: "text/plain" },
  ));
  assertEquals(unacceptable.status, 400);

  const legacy = await handler.fetch(jsonRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "legacy-test", version: "1.0.0" },
    },
  }));
  assertEquals(legacy.status, 200);
  assertEquals(legacy.headers.has("mcp-session-id"), false);
  await handler.close();
});

Deno.test("MCP returns an operation-specific insufficient-scope challenge", async () => {
  let called = false;
  const handler = createRelayMcpHttpHandler({
    auth: fakeAuth({ scopes: ["tools:read"] }),
    services: createStubServices({
      tools: {
        get: (_identity, toolKey) =>
          Promise.resolve(
            toolKey === TOOL_KEY
              ? { kind: "found", tool: TOOL }
              : { kind: "not_found" },
          ),
      },
      runs: {
        get: () => {
          called = true;
          return Promise.resolve({ kind: "not_found" });
        },
      },
    }),
    allowedHostnames: ["relay.test"],
  });
  const response = await handler.fetch(jsonRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: RELAY_MCP_TOOL_NAMES.getRun,
      arguments: { runId: RUN_ID },
    },
  }));

  assertEquals(response.status, 403);
  const header = response.headers.get("www-authenticate") ?? "";
  assertStringIncludes(header, 'error="insufficient_scope"');
  assertStringIncludes(header, 'scope="runs:read"');
  assertEquals(called, false);

  const executable = await handler.fetch(jsonRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: TOOL_KEY, arguments: {} },
  }));
  assertEquals(executable.status, 403);
  assertStringIncludes(
    executable.headers.get("www-authenticate") ?? "",
    'scope="tools:execute"',
  );

  const unknown = await handler.fetch(jsonRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "image.typo", arguments: {} },
  }));
  assertEquals(unknown.status === 403, false);
  assertEquals(unknown.headers.get("www-authenticate"), null);
  await handler.close();
});

Deno.test("MCP preserves DPoP headers and abort propagation through body buffering", async () => {
  let protectedRequest: Request | undefined;
  const handler = createRelayMcpHttpHandler({
    auth: fakeAuth({
      current: false,
      onProtectedRequest: (request) => protectedRequest = request,
    }),
    services: createStubServices(),
    allowedHostnames: ["relay.test"],
  });
  const controller = new AbortController();
  const request = jsonRequest(
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { authorization: "DPoP valid-token", dpop: "proof-canary" },
  );
  const response = await handler.fetch(
    new Request(request, { signal: controller.signal }),
  );
  assertEquals(response.status, 403);
  assertEquals(
    protectedRequest?.headers.get("authorization"),
    "DPoP valid-token",
  );
  assertEquals(protectedRequest?.headers.get("dpop"), "proof-canary");
  controller.abort();
  await Promise.resolve();
  assertEquals(protectedRequest?.signal.aborted, true);
  await handler.close();
});

Deno.test("MCP denies stale clients or workspace membership without step-up", async () => {
  let authorized = 0;
  const handler = createRelayMcpHttpHandler({
    auth: fakeAuth({
      current: false,
      scopes: ["runs:read"],
      onAuthorize: () => authorized += 1,
    }),
    services: createStubServices(),
    allowedHostnames: ["relay.test"],
  });
  const response = await handler.fetch(jsonRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: RELAY_MCP_TOOL_NAMES.getRun,
      arguments: { runId: RUN_ID },
    },
  }));

  assertEquals(response.status, 403);
  assertEquals(response.headers.get("www-authenticate"), null);
  assertEquals(authorized, 1);
  await handler.close();
});
