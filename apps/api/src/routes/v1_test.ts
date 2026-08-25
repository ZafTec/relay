import { Hono } from "@hono/hono";
import { assertEquals, assertMatch } from "@std/assert";
import { InvalidCursorError } from "@relay/application";
import { errorEnvelopeSchema, HTTP_PATHS } from "@relay/contracts";
import { createV1Routes, V1_ADAPTER_PATHS } from "./v1.ts";
import {
  ARTIFACT,
  ARTIFACT_ID,
  ARTIFACT_SUMMARY,
  ARTIFACT_VERSION_ID,
  AUTHENTICATED_IDENTITY,
  createStubServices,
  jsonRequest,
  NOW,
  RUN,
  RUN_ID,
  SHARE_LINK_ID,
  SHARE_TOKEN,
  TOOL,
  TOOL_KEY,
  UPLOAD_ID,
  USER_ID,
  WORKSPACE_ID,
} from "./test_support.ts";

const REQUEST_ID = "req_test-request-0001";

function errorCode(value: unknown): string {
  return errorEnvelopeSchema.parse(value).error.code;
}

Deno.test("v1 routes require a current active workspace without disclosing it", async () => {
  const unauthenticated = createV1Routes({
    services: createStubServices(),
    resolveIdentity: () => Promise.resolve({ kind: "unauthenticated" }),
    createRequestId: () => REQUEST_ID,
  });
  const unauthorized = await unauthenticated.request(HTTP_PATHS.tools);
  assertEquals(unauthorized.status, 401);
  assertEquals(errorCode(await unauthorized.json()), "authentication_required");
  assertEquals(unauthorized.headers.get("x-request-id"), REQUEST_ID);

  const staleWorkspace = createV1Routes({
    services: createStubServices(),
    resolveIdentity: () =>
      Promise.resolve({
        kind: "workspace_unavailable",
        actorUserId: USER_ID,
      }),
    createRequestId: () => REQUEST_ID,
  });
  const unavailable = await staleWorkspace.request(HTTP_PATHS.tools);
  assertEquals(unavailable.status, 404);
  assertEquals(await unavailable.json(), {
    error: {
      code: "not_found",
      message: "The requested resource was not found.",
      retryable: false,
      requestId: REQUEST_ID,
      details: {},
    },
  });
});

Deno.test("v1 list routes use strict query schemas and opaque cursors", async () => {
  let received: unknown;
  const app = createV1Routes({
    services: createStubServices({
      runs: {
        list(context, request) {
          received = { context, request };
          return Promise.resolve({ kind: "ok", items: [], nextCursor: null });
        },
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
    createRequestId: () => REQUEST_ID,
  });

  const listed = await app.request(
    `${HTTP_PATHS.runs}?limit=2&statuses=queued&statuses=running&toolKey=${TOOL_KEY}`,
  );
  assertEquals(listed.status, 200);
  assertEquals(received, {
    context: {
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
    },
    request: {
      cursor: null,
      limit: 2,
      statuses: ["queued", "running"],
      toolKey: TOOL_KEY,
    },
  });

  const unknown = await app.request(`${HTTP_PATHS.runs}?offset=1`);
  assertEquals(unknown.status, 400);
  assertEquals(errorCode(await unknown.json()), "invalid_request");

  const badCursorApp = createV1Routes({
    services: createStubServices({
      runs: {
        list: () => Promise.reject(new InvalidCursorError("private detail")),
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
    createRequestId: () => REQUEST_ID,
  });
  const badCursor = await badCursorApp.request(
    `${HTTP_PATHS.runs}?cursor=opaque`,
  );
  assertEquals(badCursor.status, 400);
  assertEquals(await badCursor.json(), {
    error: {
      code: "invalid_request",
      message: "The request is invalid.",
      retryable: false,
      requestId: REQUEST_ID,
      details: { field: "cursor", reason: "invalid_cursor" },
    },
  });
});

Deno.test("run admission requires idempotency and returns 202", async () => {
  let admission: unknown;
  const app = createV1Routes({
    services: createStubServices({
      runs: {
        create(context, request, idempotencyKey) {
          admission = { context, request, idempotencyKey };
          return Promise.resolve({
            kind: "accepted",
            run: RUN,
            replayed: false,
            queueReason: "awaiting_dispatch",
          });
        },
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
    createRequestId: () => REQUEST_ID,
  });

  const response = await app.request(
    HTTP_PATHS.runs,
    jsonRequest(
      { toolKey: TOOL_KEY, input: { prompt: "mountain" } },
      { "idempotency-key": "run-request-1" },
    ),
  );
  assertEquals(response.status, 202);
  assertEquals(
    response.headers.get("location"),
    `${HTTP_PATHS.runs}/${RUN_ID}`,
  );
  assertEquals((await response.json()).kind, "accepted");
  assertEquals(admission, {
    context: {
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
    },
    request: { toolKey: TOOL_KEY, input: { prompt: "mountain" } },
    idempotencyKey: "run-request-1",
  });

  const missingKey = await app.request(
    HTTP_PATHS.runs,
    jsonRequest({ toolKey: TOOL_KEY, input: {} }),
  );
  assertEquals(missingKey.status, 400);
  assertEquals(errorCode(await missingKey.json()), "invalid_request");

  const conflictApp = createV1Routes({
    services: createStubServices({
      runs: {
        create: () => Promise.resolve({ kind: "idempotency_conflict" }),
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
    createRequestId: () => REQUEST_ID,
  });
  const keyConflict = await conflictApp.request(
    HTTP_PATHS.runs,
    jsonRequest(
      { toolKey: TOOL_KEY, input: {} },
      { "idempotency-key": "run-request-1" },
    ),
  );
  assertEquals(keyConflict.status, 409);
  assertEquals(errorCode(await keyConflict.json()), "idempotency_conflict");
});

Deno.test("v1 rejects oversized JSON and file bodies before upload admission", async () => {
  let uploadCalls = 0;
  const app = createV1Routes({
    services: createStubServices({
      artifacts: {
        createUpload: () => {
          uploadCalls += 1;
          return Promise.resolve({ kind: "not_found" });
        },
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
    maxJsonBodyBytes: 64,
    createRequestId: () => REQUEST_ID,
  });

  const oversized = await app.request(
    HTTP_PATHS.artifactUploads,
    jsonRequest({ value: "x".repeat(100) }),
  );
  assertEquals(oversized.status, 413);
  assertEquals(errorCode(await oversized.json()), "invalid_request");

  const fileBody = await app.request(HTTP_PATHS.artifactUploads, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array([1, 2, 3]),
  });
  assertEquals(fileBody.status, 415);
  assertEquals(errorCode(await fileBody.json()), "invalid_request");
  assertEquals(uploadCalls, 0);
});

Deno.test("run capacity rejection uses a retryable canonical envelope", async () => {
  const app = createV1Routes({
    services: createStubServices({
      runs: {
        create: () =>
          Promise.resolve({ kind: "queue_full", scope: "workspace_tool" }),
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
    queueRetryAfterSeconds: 7,
    createRequestId: () => REQUEST_ID,
  });
  const response = await app.request(
    HTTP_PATHS.runs,
    jsonRequest(
      { toolKey: TOOL_KEY, input: {} },
      { "idempotency-key": "queue-full-1" },
    ),
  );
  assertEquals(response.status, 429);
  assertEquals(response.headers.get("retry-after"), "7");
  assertEquals(await response.json(), {
    error: {
      code: "tool_queue_full",
      message: "The tool queue is temporarily at capacity.",
      retryable: true,
      retryAfterSeconds: 7,
      requestId: REQUEST_ID,
      details: { scope: "workspace_tool" },
    },
  });
});

Deno.test("artifact, usage, and public share routes expose metadata only", async () => {
  const calls: string[] = [];
  const app = createV1Routes({
    services: createStubServices({
      tools: {
        get: (_context, key) => {
          calls.push(`tool:${key}`);
          return Promise.resolve({ kind: "found", tool: TOOL });
        },
      },
      artifacts: {
        list: () => {
          calls.push("artifact:list");
          return Promise.resolve({
            kind: "ok",
            items: [ARTIFACT_SUMMARY],
            nextCursor: null,
          });
        },
        get: (_context, id) => {
          calls.push(`artifact:get:${id}`);
          return Promise.resolve({ kind: "found", artifact: ARTIFACT });
        },
        createDownload: (_context, request) => {
          calls.push(`download:${request.artifactId}`);
          return Promise.resolve({
            kind: "authorized",
            artifactId: ARTIFACT_ID,
            artifactVersionId: ARTIFACT_VERSION_ID,
            download: {
              method: "GET",
              url: "https://objects.example.test/download",
              expiresAt: "2026-08-24T10:05:00.000Z",
              requiredHeaders: {},
            },
          });
        },
        createUpload: () => {
          calls.push("upload:create");
          return Promise.resolve({
            kind: "created",
            upload: {
              id: UPLOAD_ID,
              artifactId: ARTIFACT_ID,
              artifactVersionId: ARTIFACT_VERSION_ID,
              sequence: 1,
              status: "pending",
              authorization: {
                method: "PUT",
                url: "https://objects.example.test/upload",
                expiresAt: "2026-08-24T10:05:00.000Z",
                requiredHeaders: { "content-type": "image/png" },
              },
            },
          });
        },
        completeUpload: () => {
          calls.push("upload:complete");
          return Promise.resolve({ kind: "pending" });
        },
        createShareLink: (_context, request) => {
          calls.push(`share:create:${request.artifactId}`);
          return Promise.resolve({
            kind: "created",
            shareLinkId: SHARE_LINK_ID,
            token: SHARE_TOKEN,
            publicPath: `/s/${SHARE_TOKEN}`,
          });
        },
        revokeShareLink: (_context, id) => {
          calls.push(`share:revoke:${id}`);
          return Promise.resolve({ kind: "already_revoked" });
        },
        resolveShareLink: (token, actorUserId) => {
          calls.push(`share:resolve:${token}:${actorUserId}`);
          return Promise.resolve({
            kind: "authorized",
            shareLinkId: SHARE_LINK_ID,
            artifactId: ARTIFACT_ID,
            artifactVersionId: ARTIFACT_VERSION_ID,
            download: {
              method: "GET",
              url: "https://objects.example.test/public-download",
              expiresAt: "2026-08-24T10:05:00.000Z",
              requiredHeaders: {},
            },
          });
        },
      },
      usage: {
        getSummary: () =>
          Promise.resolve({
            kind: "ok",
            usage: { generatedAt: NOW, items: [], truncated: false },
          }),
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
    createRequestId: () => REQUEST_ID,
  });

  assertEquals(
    (await app.request(`${HTTP_PATHS.tools}/${TOOL_KEY}`)).status,
    200,
  );
  assertEquals((await app.request(HTTP_PATHS.artifacts)).status, 200);
  assertEquals(
    (await app.request(`${HTTP_PATHS.artifacts}/${ARTIFACT_ID}`)).status,
    200,
  );

  const download = await app.request(
    V1_ADAPTER_PATHS.artifactDownload.replace(":artifactId", ARTIFACT_ID),
    { method: "POST" },
  );
  assertEquals(download.status, 200);
  assertEquals((await download.json()).download.method, "GET");

  const upload = await app.request(
    HTTP_PATHS.artifactUploads,
    jsonRequest({
      target: { kind: "new_artifact", name: "Image", mediaKind: "image" },
      sizeBytes: 4,
      mimeType: "image/png",
      sha256: "a".repeat(64),
      contentMd5: `${"A".repeat(22)}==`,
    }),
  );
  assertEquals(upload.status, 201);
  const uploadBody = await upload.json();
  assertEquals(uploadBody.upload.authorization.method, "PUT");
  assertEquals(Object.hasOwn(uploadBody, "bytes"), false);

  const complete = await app.request(
    HTTP_PATHS.artifactUploadComplete.replace(":uploadId", UPLOAD_ID),
    { method: "POST" },
  );
  assertEquals(complete.status, 202);

  const share = await app.request(
    HTTP_PATHS.artifactShareLinks.replace(":artifactId", ARTIFACT_ID),
    jsonRequest({ followCurrent: true, contentDisposition: "inline" }),
  );
  assertEquals(share.status, 201);
  assertEquals(share.headers.get("location"), `/s/${SHARE_TOKEN}`);

  const revoke = await app.request(
    HTTP_PATHS.artifactShareLink
      .replace(":artifactId", ARTIFACT_ID)
      .replace(":shareLinkId", SHARE_LINK_ID),
    { method: "DELETE" },
  );
  assertEquals(revoke.status, 200);
  assertEquals(await revoke.json(), { kind: "already_revoked" });

  assertEquals((await app.request(HTTP_PATHS.usage)).status, 200);

  const shared = await app.request(`/s/${SHARE_TOKEN}`);
  assertEquals(shared.status, 302);
  assertEquals(
    shared.headers.get("location"),
    "https://objects.example.test/public-download",
  );
  assertEquals(shared.headers.get("referrer-policy"), "no-referrer");
  assertEquals(shared.headers.get("cache-control"), "no-store");

  assertEquals(calls, [
    `tool:${TOOL_KEY}`,
    "artifact:list",
    `artifact:get:${ARTIFACT_ID}`,
    `download:${ARTIFACT_ID}`,
    "upload:create",
    "upload:complete",
    `share:create:${ARTIFACT_ID}`,
    `share:revoke:${SHARE_LINK_ID}`,
    `share:resolve:${SHARE_TOKEN}:${USER_ID}`,
  ]);
});

Deno.test("SSE rejects a malformed Last-Event-ID before opening a stream", async () => {
  let eventReads = 0;
  const app = createV1Routes({
    services: createStubServices({
      events: {
        list: () => {
          eventReads += 1;
          return Promise.resolve({ kind: "ok", items: [], nextCursor: null });
        },
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
    createRequestId: () => REQUEST_ID,
  });
  const response = await app.request(HTTP_PATHS.events, {
    headers: { "last-event-id": "not-an-event-id" },
  });
  assertEquals(response.status, 400);
  assertEquals(errorCode(await response.json()), "invalid_request");
  assertEquals(eventReads, 0);
});

Deno.test("createV1Routes mounts at root with its error envelope intact", async () => {
  const parent = new Hono();
  parent.route(
    "/",
    createV1Routes({
      services: createStubServices(),
      resolveIdentity: () => Promise.resolve({ kind: "unauthenticated" }),
      createRequestId: () => REQUEST_ID,
    }),
  );

  const response = await parent.request(HTTP_PATHS.tools);
  assertEquals(response.status, 401);
  assertEquals(errorCode(await response.json()), "authentication_required");
});

Deno.test("unexpected failures never disclose internal messages", async () => {
  const secret = "postgres://user:secret@example.test/db";
  const app = createV1Routes({
    services: createStubServices({
      tools: { list: () => Promise.reject(new Error(secret)) },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
    createRequestId: () => REQUEST_ID,
  });
  const response = await app.request(HTTP_PATHS.tools);
  const text = await response.text();
  assertEquals(response.status, 500);
  assertEquals(text.includes(secret), false);
  assertMatch(text, /"code":"internal_error"/);
});
