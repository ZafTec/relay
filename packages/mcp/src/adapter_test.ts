import { assert, assertEquals } from "@std/assert";
import { Client } from "@modelcontextprotocol/client";
import {
  InMemoryTransport,
  type McpServer,
} from "@modelcontextprotocol/server";
import type { ApplicationServices } from "@relay/application/services";
import {
  type ArtifactDetail,
  errorEnvelopeSchema,
  type RunDetail,
  type ToolDetail,
} from "@relay/contracts";
import {
  createRelayMcpServer,
  RELAY_MCP_IDEMPOTENCY_META_KEY,
  RELAY_MCP_MANAGEMENT_TOOL_SCOPES,
  RELAY_MCP_PROTOCOL_VERSION,
  RELAY_MCP_SCOPES,
  RELAY_MCP_TOOL_NAMES,
} from "./adapter.ts";

const publicId = (prefix: string, character: string) =>
  `${prefix}_${character.repeat(32)}`;

const WORKSPACE_ID = "workspace_test";
const USER_ID = "user_test";
const TOOL_ID = publicId("tool", "1");
const TOOL_VERSION_ID = publicId("tver", "2");
const RUN_ID = publicId("run", "3");
const ARTIFACT_ID = publicId("art", "4");
const ARTIFACT_VERSION_ID = publicId("aver", "5");
const UPLOAD_ID = publicId("upl", "6");
const SHARE_LINK_ID = publicId("share", "7");
const NOW = "2026-08-24T10:00:00.000Z";

const TOOL: ToolDetail = {
  id: TOOL_ID,
  key: "relay.test.execute",
  name: "Deterministic Test Tool",
  category: "test",
  summary: "Execute deterministic test work.",
  lifecycle: "published",
  activeVersionId: TOOL_VERSION_ID,
  version: 1,
  executionMode: "async",
  maxDurationSeconds: 300,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: { type: "string", minLength: 1, maxLength: 1_000 },
    },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["artifactId"],
    properties: {
      artifactId: { type: "string" },
    },
  },
};

const RUN: RunDetail = {
  id: RUN_ID,
  tool: {
    key: TOOL.key,
    name: TOOL.name,
    versionId: TOOL_VERSION_ID,
    version: 1,
  },
  status: "queued",
  resultCompleteness: null,
  acceptedAt: NOW,
  startedAt: null,
  terminalAt: null,
  input: { prompt: "mountain" },
  outputSet: null,
  reservation: {
    id: publicId("reservation", "8"),
    metric: "images.generated",
    unit: "image",
    amount: "1",
    status: "active",
    expiresAt: "2026-08-24T10:05:00.000Z",
  },
};

const ARTIFACT: ArtifactDetail = {
  id: ARTIFACT_ID,
  name: "Image",
  mediaKind: "image",
  sourceRunId: null,
  currentVersion: {
    id: ARTIFACT_VERSION_ID,
    sequence: 1,
    sha256: "a".repeat(64),
    contentMd5: `${"A".repeat(22)}==`,
    sizeBytes: 4,
    mimeType: "image/png",
    width: 1,
    height: 1,
    durationMs: null,
    source: "upload",
    sourceRunId: null,
    parentVersionId: null,
    metadata: {},
    verificationStatus: "head_verified",
    createdAt: NOW,
  },
  shared: false,
  createdAt: NOW,
  versions: [],
  shares: [],
};

interface ServiceOverrides {
  readonly tools?: Partial<ApplicationServices["tools"]>;
  readonly runs?: Partial<ApplicationServices["runs"]>;
  readonly artifacts?: Partial<ApplicationServices["artifacts"]>;
  readonly usage?: Partial<ApplicationServices["usage"]>;
  readonly events?: Partial<ApplicationServices["events"]>;
}

function createServices(
  overrides: ServiceOverrides = {},
): ApplicationServices {
  const defaults: ApplicationServices = {
    tools: {
      list: () => Promise.resolve({ kind: "ok", items: [], nextCursor: null }),
      get: () => Promise.resolve({ kind: "not_found" }),
    },
    runs: {
      create: () =>
        Promise.resolve({
          kind: "accepted",
          run: RUN,
          replayed: false,
          queueReason: "awaiting_dispatch",
        }),
      list: () => Promise.resolve({ kind: "ok", items: [], nextCursor: null }),
      get: () => Promise.resolve({ kind: "found", run: RUN }),
      cancel: () => Promise.resolve({ kind: "cancel_requested", run: RUN }),
    },
    artifacts: {
      list: () => Promise.resolve({ kind: "ok", items: [], nextCursor: null }),
      get: () => Promise.resolve({ kind: "found", artifact: ARTIFACT }),
      createDownload: () => Promise.resolve({ kind: "not_found" }),
      createUpload: () => Promise.resolve({ kind: "not_found" }),
      completeUpload: () => Promise.resolve({ kind: "not_found" }),
      createShareLink: () => Promise.resolve({ kind: "not_found" }),
      revokeShareLink: () => Promise.resolve({ kind: "not_found" }),
      resolveShareLink: () => Promise.resolve({ kind: "unavailable" }),
    },
    usage: {
      getSummary: () => Promise.resolve({ kind: "not_found" }),
    },
    events: {
      list: () => Promise.resolve({ kind: "ok", items: [], nextCursor: null }),
    },
  };
  return {
    tools: { ...defaults.tools, ...overrides.tools },
    runs: { ...defaults.runs, ...overrides.runs },
    artifacts: { ...defaults.artifacts, ...overrides.artifacts },
    usage: { ...defaults.usage, ...overrides.usage },
    events: { ...defaults.events, ...overrides.events },
  };
}

async function connectClient(server: McpServer) {
  const [clientTransport, serverTransport] = InMemoryTransport
    .createLinkedPair();
  const client = new Client({ name: "relay-mcp-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function allScopes(): readonly string[] {
  return [...RELAY_MCP_SCOPES];
}

Deno.test("management tool names and scopes are stable", () => {
  assertEquals(RELAY_MCP_PROTOCOL_VERSION, "2026-07-28");
  assertEquals(Object.values(RELAY_MCP_TOOL_NAMES), [
    "relay.tools.list",
    "relay.tools.get",
    "relay.runs.get",
    "relay.runs.list",
    "relay.runs.cancel",
    "relay.artifacts.get",
    "relay.artifacts.list",
    "relay.artifacts.create_upload",
    "relay.artifacts.complete_upload",
    "relay.artifacts.create_share_link",
    "relay.artifacts.revoke_share_link",
  ]);
  assertEquals(RELAY_MCP_MANAGEMENT_TOOL_SCOPES, {
    "relay.tools.list": ["tools:read"],
    "relay.tools.get": ["tools:read"],
    "relay.runs.get": ["runs:read"],
    "relay.runs.list": ["runs:read"],
    "relay.runs.cancel": ["runs:cancel"],
    "relay.artifacts.get": ["artifacts:read"],
    "relay.artifacts.list": ["artifacts:read"],
    "relay.artifacts.create_upload": ["artifacts:write"],
    "relay.artifacts.complete_upload": ["artifacts:write"],
    "relay.artifacts.create_share_link": ["artifacts:share"],
    "relay.artifacts.revoke_share_link": ["artifacts:share"],
  });
});

Deno.test("official v2 client discovers only stable tools without catalog entries", async () => {
  const server = await createRelayMcpServer({
    services: createServices(),
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: allScopes(),
    },
  });
  const connection = await connectClient(server);
  try {
    const listed = await connection.client.listTools();
    assertEquals(
      listed.tools.map((tool) => tool.name).sort(),
      Object.values(RELAY_MCP_TOOL_NAMES).sort(),
    );
    assertEquals(
      listed.tools.some((tool) => tool.name === "relay.test.execute"),
      false,
    );
    for (
      const name of [
        RELAY_MCP_TOOL_NAMES.createArtifactUpload,
        RELAY_MCP_TOOL_NAMES.completeArtifactUpload,
        RELAY_MCP_TOOL_NAMES.createShareLink,
        RELAY_MCP_TOOL_NAMES.revokeShareLink,
      ]
    ) {
      assertEquals(
        listed.tools.find((tool) => tool.name === name)?.annotations
          ?.idempotentHint,
        true,
      );
    }
  } finally {
    await connection.close();
  }
});

Deno.test("management tools use canonical defaults and workspace identity", async () => {
  let received: unknown;
  const services = createServices({
    tools: {
      list: (identity, request) => {
        received = { identity, request };
        return Promise.resolve({ kind: "ok", items: [], nextCursor: null });
      },
    },
  });
  const server = await createRelayMcpServer({
    services,
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["tools:read"],
    },
  });
  const connection = await connectClient(server);
  try {
    const result = await connection.client.callTool({
      name: RELAY_MCP_TOOL_NAMES.listTools,
      arguments: {},
    });
    assertEquals(result.isError, undefined);
    assertEquals(result.structuredContent, {
      kind: "ok",
      items: [],
      nextCursor: null,
    });
    assertEquals(received, {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      request: { cursor: null, limit: 25 },
    });
  } finally {
    await connection.close();
  }
});

Deno.test("management tool schemas reject unknown input fields", async () => {
  let called = false;
  const server = await createRelayMcpServer({
    services: createServices({
      tools: {
        list: () => {
          called = true;
          return Promise.resolve({ kind: "ok", items: [], nextCursor: null });
        },
      },
    }),
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["tools:read"],
    },
  });
  const connection = await connectClient(server);
  try {
    await connection.client.listTools();
    const result = await connection.client.callTool({
      name: RELAY_MCP_TOOL_NAMES.listTools,
      arguments: { workspaceId: "attacker-selected", unknown: true },
    });
    assertEquals(result.isError, true);
    assertEquals(called, false);
  } finally {
    await connection.close();
  }
});

Deno.test("scope denial does not invoke the application service", async () => {
  let called = false;
  const server = await createRelayMcpServer({
    services: createServices({
      runs: {
        get: () => {
          called = true;
          return Promise.resolve({ kind: "found", run: RUN });
        },
      },
    }),
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["tools:read"],
    },
  });
  const connection = await connectClient(server);
  try {
    const result = await connection.client.callTool({
      name: RELAY_MCP_TOOL_NAMES.getRun,
      arguments: { runId: RUN_ID },
    });
    assertEquals(result.isError, true);
    assertEquals(called, false);
    assert(
      result.content.some((item) =>
        item.type === "text" && item.text.includes("runs:read")
      ),
    );
  } finally {
    await connection.close();
  }
});

Deno.test("canonical cross-field validation rejects invalid share requests", async () => {
  let called = false;
  const server = await createRelayMcpServer({
    services: createServices({
      artifacts: {
        createShareLink: () => {
          called = true;
          return Promise.resolve({ kind: "not_found" });
        },
      },
    }),
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["artifacts:share"],
    },
  });
  const connection = await connectClient(server);
  try {
    const result = await connection.client.callTool({
      name: RELAY_MCP_TOOL_NAMES.createShareLink,
      arguments: {
        artifactId: ARTIFACT_ID,
        followCurrent: true,
        artifactVersionId: ARTIFACT_VERSION_ID,
        contentDisposition: "inline",
      },
    });
    assertEquals(result.isError, true);
    assertEquals(called, false);
  } finally {
    await connection.close();
  }
});

Deno.test("artifact mutation metadata errors are stable and do not call services", async () => {
  let called = false;
  const server = await createRelayMcpServer({
    services: createServices({
      artifacts: {
        createUpload: () => {
          called = true;
          return Promise.resolve({ kind: "not_found" });
        },
      },
    }),
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["artifacts:write"],
    },
  });
  const connection = await connectClient(server);
  const request = {
    name: RELAY_MCP_TOOL_NAMES.createArtifactUpload,
    arguments: {
      target: { kind: "new_artifact", name: "Image", mediaKind: "image" },
      sizeBytes: 4,
      mimeType: "image/png",
      sha256: "a".repeat(64),
      contentMd5: `${"A".repeat(22)}==`,
    },
  } as const;
  try {
    const missing = await connection.client.callTool(request);
    const invalid = await connection.client.callTool({
      ...request,
      _meta: { [RELAY_MCP_IDEMPOTENCY_META_KEY]: " invalid" },
    });
    for (const result of [missing, invalid]) {
      assertEquals(result.isError, true);
      const envelope = errorEnvelopeSchema.parse(result.structuredContent);
      assertEquals(envelope.error.code, "invalid_request");
      assertEquals(
        envelope.error.message,
        "The required idempotency metadata is missing or invalid.",
      );
      assertEquals(envelope.error.details, {});
      assertEquals(JSON.stringify(result).includes(ARTIFACT_ID), false);
    }
    assertEquals(called, false);
  } finally {
    await connection.close();
  }
});

Deno.test("artifact completion tool forwards idempotency and replay state", async () => {
  let received: unknown;
  const server = await createRelayMcpServer({
    services: createServices({
      artifacts: {
        completeUpload: (identity, uploadId, idempotencyKey) => {
          received = { identity, uploadId, idempotencyKey };
          return Promise.resolve({
            kind: "completed",
            artifactId: ARTIFACT_ID,
            artifactVersionId: ARTIFACT_VERSION_ID,
            becameCurrent: true,
            replayed: true,
          });
        },
      },
    }),
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["artifacts:write"],
    },
  });
  const connection = await connectClient(server);
  try {
    const result = await connection.client.callTool({
      name: RELAY_MCP_TOOL_NAMES.completeArtifactUpload,
      arguments: { uploadId: UPLOAD_ID },
      _meta: {
        [RELAY_MCP_IDEMPOTENCY_META_KEY]: "artifact-complete-request-1",
      },
    });
    assertEquals(result.isError, undefined);
    assertEquals(result.structuredContent, {
      kind: "completed",
      artifactId: ARTIFACT_ID,
      artifactVersionId: ARTIFACT_VERSION_ID,
      becameCurrent: true,
      replayed: true,
    });
    assertEquals(received, {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      uploadId: UPLOAD_ID,
      idempotencyKey: "artifact-complete-request-1",
    });
  } finally {
    await connection.close();
  }
});

Deno.test("artifact revoke binds targets and sanitizes key conflicts", async () => {
  const otherArtifactId = publicId("art", "a");
  let claimedTarget: string | undefined;
  const calls: unknown[] = [];
  const server = await createRelayMcpServer({
    services: createServices({
      artifacts: {
        revokeShareLink: (
          identity,
          artifactId,
          shareLinkId,
          idempotencyKey,
        ) => {
          calls.push({ identity, artifactId, shareLinkId, idempotencyKey });
          const target = `${artifactId}:${shareLinkId}`;
          if (claimedTarget === undefined) {
            claimedTarget = target;
            return Promise.resolve({ kind: "revoked", replayed: false });
          }
          return Promise.resolve(
            claimedTarget === target
              ? { kind: "revoked", replayed: true }
              : { kind: "idempotency_conflict" },
          );
        },
      },
    }),
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["artifacts:share"],
    },
  });
  const connection = await connectClient(server);
  const call = (artifactId: string) =>
    connection.client.callTool({
      name: RELAY_MCP_TOOL_NAMES.revokeShareLink,
      arguments: { artifactId, shareLinkId: SHARE_LINK_ID },
      _meta: {
        [RELAY_MCP_IDEMPOTENCY_META_KEY]: "artifact-revoke-same-key",
      },
    });
  try {
    const first = await call(ARTIFACT_ID);
    assertEquals(first.structuredContent, {
      kind: "revoked",
      replayed: false,
    });
    const replay = await call(ARTIFACT_ID);
    assertEquals(replay.structuredContent, {
      kind: "revoked",
      replayed: true,
    });

    const conflict = await call(otherArtifactId);
    assertEquals(conflict.isError, true);
    const envelope = errorEnvelopeSchema.parse(conflict.structuredContent);
    assertEquals(envelope.error.code, "idempotency_conflict");
    assertEquals(envelope.error.details, {});
    assertEquals(JSON.stringify(conflict).includes(ARTIFACT_ID), false);
    assertEquals(JSON.stringify(conflict).includes(otherArtifactId), false);
    assertEquals(calls.length, 3);
  } finally {
    await connection.close();
  }
});

Deno.test("artifact mutation scope denial precedes idempotency validation", async () => {
  let called = false;
  const server = await createRelayMcpServer({
    services: createServices({
      artifacts: {
        completeUpload: () => {
          called = true;
          return Promise.resolve({ kind: "not_found" });
        },
      },
    }),
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["artifacts:read"],
    },
  });
  const connection = await connectClient(server);
  try {
    const result = await connection.client.callTool({
      name: RELAY_MCP_TOOL_NAMES.completeArtifactUpload,
      arguments: { uploadId: UPLOAD_ID },
    });
    assertEquals(result.isError, true);
    const envelope = errorEnvelopeSchema.parse(result.structuredContent);
    assertEquals(envelope.error.code, "authentication_required");
    assertEquals(envelope.error.details, {});
    assert(
      result.content.some((item) =>
        item.type === "text" && item.text.includes("artifacts:write")
      ),
    );
    assertEquals(called, false);
  } finally {
    await connection.close();
  }
});

Deno.test("published catalog tools expose their schema and create compact runs", async () => {
  let admitted: unknown;
  const services = createServices({
    tools: {
      list: () =>
        Promise.resolve({
          kind: "ok",
          items: [{
            id: TOOL.id,
            key: TOOL.key,
            name: TOOL.name,
            category: TOOL.category,
            summary: TOOL.summary,
            lifecycle: TOOL.lifecycle,
            activeVersionId: TOOL.activeVersionId,
            version: TOOL.version,
          }],
          nextCursor: null,
        }),
      get: () => Promise.resolve({ kind: "found", tool: TOOL }),
    },
    runs: {
      create: (
        identity,
        request,
        idempotencyKey,
        expectedToolVersionId,
      ) => {
        admitted = {
          identity,
          request,
          idempotencyKey,
          expectedToolVersionId,
        };
        return Promise.resolve({
          kind: "accepted",
          run: RUN,
          replayed: false,
          queueReason: "awaiting_dispatch",
        });
      },
    },
  });
  const server = await createRelayMcpServer({
    services,
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["tools:execute"],
      clientId: "client_test",
    },
  });
  const connection = await connectClient(server);
  try {
    const listed = await connection.client.listTools();
    const executable = listed.tools.find((tool) => tool.name === TOOL.key);
    assert(executable !== undefined);
    assertEquals(executable.inputSchema, TOOL.inputSchema as unknown);

    const missingKey = await connection.client.callTool({
      name: TOOL.key,
      arguments: { prompt: "mountain" },
    });
    assertEquals(missingKey.isError, true);
    assertEquals(admitted, undefined);

    const result = await connection.client.callTool({
      name: TOOL.key,
      arguments: { prompt: "mountain" },
      _meta: {
        [RELAY_MCP_IDEMPOTENCY_META_KEY]: "mcp-test-idempotency",
      },
    });
    assertEquals(result.isError, undefined);
    assertEquals(result.structuredContent, {
      runId: RUN_ID,
      status: "queued",
      replayed: false,
      queueReason: "awaiting_dispatch",
      reservation: {
        metric: "images.generated",
        unit: "image",
        amount: "1",
        status: "active",
        expiresAt: "2026-08-24T10:05:00.000Z",
      },
      statusTool: RELAY_MCP_TOOL_NAMES.getRun,
    });
    assertEquals(admitted, {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      request: { toolKey: TOOL.key, input: { prompt: "mountain" } },
      idempotencyKey: "mcp-test-idempotency",
      expectedToolVersionId: TOOL_VERSION_ID,
    });
    assertEquals(JSON.stringify(result).includes("prompt"), false);
  } finally {
    await connection.close();
  }
});

Deno.test("unexpected service failures are sanitized", async () => {
  const secret = "postgres://user:secret@example.test/relay";
  const server = await createRelayMcpServer({
    services: createServices({
      runs: {
        get: () => Promise.reject(new Error(secret)),
      },
    }),
    principal: {
      identity: { workspaceId: WORKSPACE_ID, actorUserId: USER_ID },
      scopes: ["runs:read"],
    },
  });
  const connection = await connectClient(server);
  try {
    const result = await connection.client.callTool({
      name: RELAY_MCP_TOOL_NAMES.getRun,
      arguments: { runId: RUN_ID },
    });
    assertEquals(result.isError, true);
    assertEquals(JSON.stringify(result).includes(secret), false);
    const structured = result.structuredContent as {
      readonly error: { readonly code: string; readonly details: unknown };
    };
    assertEquals(structured.error.code, "internal_error");
    assertEquals(structured.error.details, {});
  } finally {
    await connection.close();
  }
});
