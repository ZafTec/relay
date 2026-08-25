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

Deno.test("run admission requires both handler and metering dependencies", () => {
  const pool = {} as DatabasePool;
  const handlers = {
    get: () => undefined,
    isCompatible: () => false,
  } as unknown as HandlerRegistry;
  const usage: AdmissionUsagePort = {
    quote: () => Promise.resolve({ estimatedCostUnits: 1, policyKey: "test" }),
    reserve: () => Promise.resolve("reservation_test"),
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

Deno.test("admission rejects a port that returns no reservation", async () => {
  const usage: AdmissionUsagePort = {
    quote: () => Promise.resolve({ estimatedCostUnits: 1, policyKey: "test" }),
    reserve: () => Promise.resolve(null),
  };
  const guarded = requireMeteredAdmissionUsagePort(usage);
  await assertRejects(
    () =>
      guarded.reserve(
        {} as Parameters<AdmissionUsagePort["reserve"]>[0],
        {} as Parameters<AdmissionUsagePort["reserve"]>[1],
        { estimatedCostUnits: 1, policyKey: "test" },
      ),
    Error,
    "unmetered admission is disabled",
  );
});

Deno.test("artifact command adapter keeps bytes outside upload JSON", async () => {
  let received: unknown;
  const port: ArtifactCommandPort = {
    createArtifactDownloadUrl: () => Promise.resolve({ kind: "not_found" }),
    beginDirectUpload(input) {
      received = input;
      return Promise.resolve({ kind: "quota_exceeded" });
    },
    completeUpload: () => Promise.resolve({ kind: "not_found" }),
    createShareLink: () => Promise.resolve({ kind: "not_found" }),
    revokeShareLink: () => Promise.resolve({ kind: "not_found" }),
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
  );
  assertEquals(result, { kind: "quota_exceeded" });
  assertEquals(Object.hasOwn(received as object, "bytes"), false);
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
    quote: () => Promise.resolve({ estimatedCostUnits: 1, policyKey: "test" }),
    reserve: () => Promise.resolve("reservation_test"),
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
