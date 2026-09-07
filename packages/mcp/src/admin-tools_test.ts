import { assert, assertEquals, assertRejects } from "@std/assert";
import { Client } from "@modelcontextprotocol/client";
import { z } from "zod/v4";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { RELAY_MCP_ADMIN_SCOPES } from "@relay/contracts";
import {
  registerRelayAdminTools,
  type RelayMcpAdminContext,
  RelayMcpAdminError,
  type RelayMcpAdminOperation,
  type RelayMcpAdminServices,
} from "./admin-tools.ts";

async function fixture(
  options: { session?: string; scopes?: readonly string[] } = {},
) {
  const calls: {
    operation: RelayMcpAdminOperation;
    context: RelayMcpAdminContext;
    input: unknown;
  }[] = [];
  let allowed = true;
  let failure: Error | undefined;
  const services: RelayMcpAdminServices = {
    authorize: () => Promise.resolve(allowed),
    invoke: (operation, context, input) => {
      if (failure) throw failure;
      calls.push({ operation, context, input });
      return Promise.resolve({ ok: true });
    },
  };
  const server = new McpServer({ name: "admin-tools-test", version: "1.0.0" });
  server.registerTool(
    "test.ping",
    { inputSchema: z.object({}).strict() },
    () => ({ content: [{ type: "text" as const, text: "ok" }] }),
  );
  registerRelayAdminTools(server, services, {
    adminSessionId: options.session,
    actorUserId: "verified-admin",
    scopes: options.scopes ?? RELAY_MCP_ADMIN_SCOPES,
  });
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const client = new Client({ name: "admin-client-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    calls,
    revoke: () => {
      allowed = false;
    },
    fail: (error: Error) => {
      failure = error;
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

Deno.test("admin tools require a verified admin session and expose only consented operations", async () => {
  for (
    const options of [{}, {
      session: "trusted-session",
      scopes: ["tools:read"],
    }]
  ) {
    const test = await fixture(options);
    try {
      const { tools } = await test.client.listTools();
      assertEquals(
        tools.filter((tool) => tool.name.startsWith("relay.admin.")).length,
        0,
      );
      assertEquals(test.calls.length, 0);
    } finally {
      await test.close();
    }
  }
  const reader = await fixture({
    session: "trusted-session",
    scopes: ["admin:allowances:read"],
  });
  try {
    const { tools } = await reader.client.listTools();
    assert(
      tools.some((tool) => tool.name === "relay.admin.allowances.workspaces"),
    );
    assert(
      tools.every((tool) =>
        !tool.name.includes(".grant") || tool.name.endsWith(".grants")
      ),
    );
    await assertRejects(() =>
      reader.client.callTool({
        name: "relay.admin.allowances.grant",
        arguments: {},
      })
    );
    assertEquals(reader.calls.length, 0);
  } finally {
    await reader.close();
  }
});

const grant = {
  workspaceId: "target-workspace",
  key: "images.generated",
  mode: "finite",
  amount: "5",
  effectiveAt: null,
  expiresAt: null,
  reason: "Explicitly approved test allowance",
};
const metadata = { "io.relay/idempotency-key": "admin-test-change-0001" };

Deno.test("admin mutations preserve trusted identity, require stable keys and reject injected authority", async () => {
  const test = await fixture({ session: "trusted-session" });
  try {
    const missing = await test.client.callTool({
      name: "relay.admin.allowances.grant",
      arguments: grant,
    });
    assertEquals(missing.isError, true);
    assertEquals(test.calls.length, 0);
    const forged = await test.client.callTool({
      name: "relay.admin.allowances.grant",
      arguments: {
        ...grant,
        sessionId: "forged-session",
        actorUserId: "other",
      },
      _meta: metadata,
    });
    assertEquals(forged.isError, true);
    assertEquals(test.calls.length, 0);
    const granted = await test.client.callTool({
      name: "relay.admin.allowances.grant",
      arguments: grant,
      _meta: metadata,
    });
    assertEquals(granted.isError, undefined);
    assertEquals(test.calls[0].operation, "allowances.grant");
    assertEquals(test.calls[0].context.sessionId, "trusted-session");
    assertEquals(test.calls[0].context.actorUserId, "verified-admin");
    assertEquals(
      test.calls[0].context.idempotencyKey,
      metadata["io.relay/idempotency-key"],
    );
    assertEquals(test.calls[0].input, grant);
    test.revoke();
    const denied = await test.client.callTool({
      name: "relay.admin.allowances.get",
      arguments: { workspaceId: "target-workspace" },
    });
    assertEquals(denied.isError, true);
    assertEquals(
      (denied.structuredContent as { error: { code: string } }).error.code,
      "authorization_denied",
    );
    assertEquals(test.calls.length, 1);
  } finally {
    await test.close();
  }
});

Deno.test("admin tools report reauthentication without leaking unexpected service errors", async () => {
  const test = await fixture({ session: "trusted-session" });
  try {
    test.fail(
      new RelayMcpAdminError("reauthentication_required", "Sign in again."),
    );
    const stale = await test.client.callTool({
      name: "relay.admin.capacity.list",
      arguments: {},
    });
    assertEquals(stale.isError, true);
    assertEquals(
      (stale.structuredContent as { error: { code: string } }).error.code,
      "reauthentication_required",
    );
    test.fail(new Error("private-database-credential"));
    const unexpected = await test.client.callTool({
      name: "relay.admin.capacity.list",
      arguments: {},
    });
    assertEquals(unexpected.isError, true);
    assertEquals(
      JSON.stringify(unexpected).includes("private-database-credential"),
      false,
    );
  } finally {
    await test.close();
  }
});

Deno.test("official MCP client validates each administrative workflow schema", async () => {
  const test = await fixture({ session: "trusted-session" });
  const draft = {
    version: "1.2.3",
    slug: "release-1-2-3",
    title: "Test release",
    items: [],
  };
  const client = {
    client_name: "Local agent",
    redirect_uris: ["http://localhost:8123/callback"],
    scopes: ["tools:read"],
    token_endpoint_auth_method: "none",
  };
  const cases: [RelayMcpAdminOperation, Record<string, unknown>][] = [
    ["allowances.workspaces", { search: "studio" }],
    ["allowances.get", { workspaceId: "workspace" }],
    ["allowances.grants", { workspaceId: "workspace", before: null }],
    ["allowances.audit", { workspaceId: "workspace" }],
    ["allowances.grant", grant],
    ["allowances.revoke", {
      workspaceId: "workspace",
      grantId: "grant",
      reason: "Revoke test",
    }],
    ["capacity.list", { includeHistory: true }],
    ["capacity.get", { scopeType: "global", scopeId: "global", revision: 1 }],
    ["capacity.revise", {
      scopeType: "global",
      scopeId: "global",
      expectedRevision: 0,
      configuration: {},
      effectiveAt: "2026-09-07T00:00:00Z",
    }],
    ["superadmins.list", {}],
    ["superadmins.invite", { email: "colleague@example.test" }],
    ["superadmins.revoke_invitation", {
      invitationId: "sinv_" + "a".repeat(32),
    }],
    ["changelog.list", { limit: 20 }],
    ["changelog.get", { releaseId: "1" }],
    ["changelog.create", { draft }],
    ["changelog.revise", { releaseId: "1", expectedRevision: 1, draft }],
    ["changelog.publish", { releaseId: "1", expectedRevision: 1 }],
    ["changelog.unpublish", { releaseId: "1", expectedPublishedRevision: 1 }],
    ["oauth.list", {}],
    ["oauth.get", { client_id: "client-1" }],
    ["oauth.create", client],
    ["oauth.update", {
      client_id: "client-1",
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      scopes: client.scopes,
    }],
    ["oauth.rotate", { client_id: "client-1" }],
    ["oauth.delete", { client_id: "client-1" }],
  ];
  try {
    for (const [operation, input] of cases) {
      const result = await test.client.callTool({
        name: "relay.admin." + operation,
        arguments: input,
        _meta: metadata,
      });
      assertEquals(
        result.isError,
        undefined,
        operation + ": " + JSON.stringify(result.content),
      );
    }
    assertEquals(
      test.calls.map((call) => call.operation),
      cases.map(([operation]) => operation),
    );
    const { tools } = await test.client.listTools();
    assertEquals(
      tools.find((tool) => tool.name === "relay.admin.oauth.rotate")
        ?.annotations?.idempotentHint,
      false,
    );
  } finally {
    await test.close();
  }
});
