import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { HandlerRegistry } from "@relay/catalog";
import type { DatabasePool } from "@relay/database";
import type { AdmissionUsagePort } from "@relay/queue";
import {
  ArtifactCommandAdapter,
  type ArtifactCommandPort,
} from "./artifact-commands.ts";
import {
  requireMeteredAdmissionUsagePort,
  RunAdmissionAdapter,
} from "./admission.ts";
import { createPostgresRunService } from "./factory.ts";

const TEST_MEASURES = {
  requested_units: { minimum: "1", expected: "1", maximum: "1" },
} as const;

Deno.test("run admission requires both handler and metering dependencies", () => {
  const pool = {} as DatabasePool;
  const handlers = {
    get: () => undefined,
    isCompatible: () => false,
  } as unknown as HandlerRegistry;
  const usage: AdmissionUsagePort = {
    quote: () =>
      Promise.resolve({
        estimatedCostUnits: 1,
        policyKey: "test",
        measures: TEST_MEASURES,
      }),
    reserve: () =>
      Promise.resolve("reservation_0123456789abcdef0123456789abcdef"),
  };
  assertThrows(
    () =>
      new RunAdmissionAdapter({
        pool,
        handlers: null as unknown as HandlerRegistry,
        usage,
        admissionDeadlineMs: 60_000,
        runDeadlineMs: 300_000,
      }),
    TypeError,
    "HandlerRegistry",
  );
  assertThrows(
    () =>
      new RunAdmissionAdapter({
        pool,
        handlers,
        usage: null as unknown as AdmissionUsagePort,
        admissionDeadlineMs: 60_000,
        runDeadlineMs: 300_000,
      }),
    TypeError,
    "AdmissionUsagePort",
  );
});

Deno.test("admission maps a missing reservation to unavailable", async () => {
  const usage: AdmissionUsagePort = {
    quote: () =>
      Promise.resolve({
        estimatedCostUnits: 1,
        policyKey: "test",
        measures: TEST_MEASURES,
      }),
    reserve: () => Promise.resolve(null),
  };
  const guarded = requireMeteredAdmissionUsagePort(usage);
  assertEquals(
    await guarded.reserve(
      {} as Parameters<AdmissionUsagePort["reserve"]>[0],
      {} as Parameters<AdmissionUsagePort["reserve"]>[1],
      {
        estimatedCostUnits: 1,
        policyKey: "test",
        measures: TEST_MEASURES,
      },
    ),
    { kind: "usage_unavailable", reason: "invalid_configuration" },
  );
});

Deno.test("artifact command adapter keeps bytes outside upload JSON", async () => {
  let received: unknown;
  const port: ArtifactCommandPort = {
    createArtifactDownloadUrl: () => Promise.resolve({ kind: "not_found" }),
    beginDirectUpload(input) {
      received = input;
      return Promise.resolve({ kind: "quota_exceeded", replayed: false });
    },
    completeUpload: () =>
      Promise.resolve({ kind: "not_found", replayed: false }),
    createShareLink: () =>
      Promise.resolve({ kind: "not_found", replayed: false }),
    revokeShareLink: () =>
      Promise.resolve({ kind: "not_found", replayed: false }),
    resolveShareLink: () => Promise.resolve({ kind: "unavailable" }),
  };
  const adapter = new ArtifactCommandAdapter(port);
  const result = await adapter.createUpload(
    { workspaceId: "workspace", actorUserId: "user" },
    {
      target: { kind: "new_artifact", name: "Image", mediaKind: "image" },
      sizeBytes: 4,
      mimeType: "image/png",
      sha256: "a".repeat(64),
      contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
    },
    "artifact-upload-request-1",
  );
  assertEquals(result, { kind: "quota_exceeded" });
  assertEquals(Object.hasOwn(received as object, "bytes"), false);
  assertEquals(
    (received as { readonly idempotencyKey: string }).idempotencyKey,
    "artifact-upload-request-1",
  );
});

Deno.test("artifact command adapter forwards mutation keys and replay state", async () => {
  const artifactId = "art_0123456789abcdef0123456789abcdef";
  const artifactVersionId = "aver_0123456789abcdef0123456789abcdef";
  const uploadId = "upl_0123456789abcdef0123456789abcdef";
  const shareLinkId = "share_0123456789abcdef0123456789abcdef";
  const token = "a".repeat(43);
  const calls: unknown[] = [];
  const port: ArtifactCommandPort = {
    createArtifactDownloadUrl: () => Promise.resolve({ kind: "not_found" }),
    beginDirectUpload(input) {
      calls.push(input);
      return Promise.resolve({
        kind: "created",
        value: {
          uploadId,
          artifactId,
          artifactVersionId,
          sequence: 1,
          upload: {
            method: "PUT",
            url: "https://objects.example.test/upload",
            expiresAt: new Date("2026-08-26T10:05:00.000Z"),
            requiredHeaders: {},
          },
        },
        replayed: true,
      });
    },
    completeUpload(input) {
      calls.push(input);
      return Promise.resolve({
        kind: "completed",
        artifactId,
        artifactVersionId,
        becameCurrent: true,
        replayed: true,
      });
    },
    createShareLink(input) {
      calls.push(input);
      return Promise.resolve({
        kind: "created",
        value: { shareLinkId, token },
        replayed: true,
      });
    },
    revokeShareLink(input) {
      calls.push(input);
      return Promise.resolve({ kind: "revoked", replayed: true });
    },
    resolveShareLink: () => Promise.resolve({ kind: "unavailable" }),
  };
  const adapter = new ArtifactCommandAdapter(port);
  const context = { workspaceId: "workspace", actorUserId: "user" };
  const uploadRequest = {
    target: {
      kind: "new_artifact" as const,
      name: "Image",
      mediaKind: "image",
    },
    sizeBytes: 4,
    mimeType: "image/png",
    sha256: "a".repeat(64),
    contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
  };

  const upload = await adapter.createUpload(
    context,
    uploadRequest,
    "artifact-upload-request-1",
  );
  assertEquals(upload.kind, "created");
  if (upload.kind !== "created") throw new Error("upload was not created");
  assertEquals(upload.replayed, true);
  assertEquals(upload.upload.status, "pending");

  assertEquals(
    await adapter.completeUpload(
      context,
      uploadId,
      "artifact-complete-request-1",
    ),
    {
      kind: "completed",
      artifactId,
      artifactVersionId,
      becameCurrent: true,
      replayed: true,
    },
  );
  assertEquals(
    await adapter.createShareLink(
      context,
      { artifactId, followCurrent: true, contentDisposition: "inline" },
      "artifact-share-request-1",
    ),
    {
      kind: "created",
      shareLinkId,
      token,
      publicPath: `/s/${token}`,
      replayed: true,
    },
  );
  assertEquals(
    await adapter.revokeShareLink(
      context,
      artifactId,
      shareLinkId,
      "artifact-revoke-request-1",
    ),
    { kind: "revoked", replayed: true },
  );

  assertEquals(
    calls.map((call) =>
      (call as { readonly idempotencyKey: string }).idempotencyKey
    ),
    [
      "artifact-upload-request-1",
      "artifact-complete-request-1",
      "artifact-share-request-1",
      "artifact-revoke-request-1",
    ],
  );
  assertEquals(calls[3], {
    ...context,
    artifactId,
    shareLinkId,
    idempotencyKey: "artifact-revoke-request-1",
  });
});

Deno.test("artifact command adapter validates idempotency before its port", async () => {
  let called = false;
  const port: ArtifactCommandPort = {
    createArtifactDownloadUrl: () => Promise.resolve({ kind: "not_found" }),
    beginDirectUpload: () => {
      called = true;
      return Promise.resolve({ kind: "not_found", replayed: false });
    },
    completeUpload: () =>
      Promise.resolve({ kind: "not_found", replayed: false }),
    createShareLink: () =>
      Promise.resolve({ kind: "not_found", replayed: false }),
    revokeShareLink: () =>
      Promise.resolve({ kind: "not_found", replayed: false }),
    resolveShareLink: () => Promise.resolve({ kind: "unavailable" }),
  };
  const adapter = new ArtifactCommandAdapter(port);

  await assertRejects(
    () =>
      adapter.createUpload(
        { workspaceId: "workspace", actorUserId: "user" },
        {
          target: { kind: "new_artifact", name: "Image", mediaKind: "image" },
          sizeBytes: 4,
          mimeType: "image/png",
          sha256: "a".repeat(64),
          contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
        },
        " invalid-key",
      ),
    TypeError,
    "idempotencyKey",
  );
  assertEquals(called, false);
});

Deno.test("run admission pins an adapter-supplied tool version", async () => {
  const calls: Array<{ readonly text: string; readonly params: unknown[] }> =
    [];
  const pool = {
    query<Row>(text: string, params: unknown[] = []) {
      calls.push({ text, params });
      return Promise.resolve({
        rows: [{ member: true, tool_version_id: null }] as Row[],
      });
    },
  } as unknown as DatabasePool;
  const handlers = {
    get: () => undefined,
    isCompatible: () => false,
  } as unknown as HandlerRegistry;
  const usage: AdmissionUsagePort = {
    quote: () =>
      Promise.resolve({
        estimatedCostUnits: 1,
        policyKey: "test",
        measures: TEST_MEASURES,
      }),
    reserve: () =>
      Promise.resolve("reservation_0123456789abcdef0123456789abcdef"),
  };
  const service = createPostgresRunService({
    pool,
    handlers,
    admissionUsage: usage,
    admissionDeadlineMs: 60_000,
    runDeadlineMs: 300_000,
  });
  const expectedToolVersionId = "tver_0123456789abcdef0123456789abcdef";

  assertEquals(
    await service.create(
      { workspaceId: "workspace", actorUserId: "user" },
      { toolKey: "image.generate", input: { prompt: "mountain" } },
      "mcp-test-idempotency",
      expectedToolVersionId,
    ),
    { kind: "tool_unavailable" },
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].params, [
    "workspace",
    "user",
    "image.generate",
    expectedToolVersionId,
  ]);
  assertEquals(
    calls[0].text.includes("tool.active_version_id = $4"),
    true,
  );
});
