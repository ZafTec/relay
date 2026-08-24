import { assertEquals, assertThrows } from "@std/assert";
import {
  cancelRunResultSchema,
  changelogEntryPath,
  createArtifactUploadRequestSchema,
  errorEnvelopeSchema,
  HTTP_PATHS,
  listRunsRequestSchema,
  publicSharePath,
  runDetailSchema,
  workspaceEventEnvelopeSchema,
} from "./index.ts";

const HEX_32 = "0123456789abcdef0123456789abcdef";

Deno.test("canonical public routes use run and /s/:token nouns", () => {
  assertEquals(HTTP_PATHS.runs, "/api/v1/runs");
  assertEquals(HTTP_PATHS.changelog, "/api/v1/changelog");
  assertEquals(HTTP_PATHS.changelogEntry, "/api/v1/changelog/:slug");
  assertEquals(
    changelogEntryPath("release 1"),
    "/api/v1/changelog/release%201",
  );
  assertEquals(HTTP_PATHS.publicShareTemplate, "/s/:token");
  assertEquals(publicSharePath("abc_123"), "/s/abc_123");
});

Deno.test("contract schemas reject unknown fields", () => {
  assertThrows(() =>
    listRunsRequestSchema.parse({
      limit: 25,
      offset: 10,
    })
  );
  assertThrows(() =>
    errorEnvelopeSchema.parse({
      error: {
        code: "invalid_request",
        message: "Invalid request.",
        retryable: false,
        requestId: "req_12345678",
        details: {},
        stack: "secret",
      },
    })
  );
});

Deno.test("error details reject URL-shaped secrets", () => {
  assertThrows(() =>
    errorEnvelopeSchema.parse({
      error: {
        code: "tool_unavailable",
        message: "Request failed.",
        retryable: false,
        requestId: "req_12345678",
        details: { reason: "https://signed.example/secret" },
      },
    })
  );
});

Deno.test("upload contracts contain metadata but reject file bytes", () => {
  const request = {
    target: {
      kind: "new_artifact",
      name: "Result",
      mediaKind: "image",
    },
    sizeBytes: 12,
    mimeType: "image/png",
    sha256: "a".repeat(64),
    contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
  } as const;
  assertEquals(createArtifactUploadRequestSchema.parse(request), request);
  assertThrows(() =>
    createArtifactUploadRequestSchema.parse({
      ...request,
      bytes: [1, 2, 3],
    })
  );
});

Deno.test("run details enforce status-shaped output items", () => {
  const run = {
    id: `run_${HEX_32}`,
    tool: {
      key: "image.generate",
      name: "Image Generate",
      versionId: `tver_${HEX_32}`,
      version: 1,
    },
    status: "succeeded",
    resultCompleteness: "complete",
    acceptedAt: "2026-08-24T10:00:00.000Z",
    startedAt: "2026-08-24T10:00:01.000Z",
    terminalAt: "2026-08-24T10:00:02.000Z",
    input: { prompt: "A lighthouse" },
    reservation: null,
    outputSet: {
      id: `outset_${HEX_32}`,
      requestedCount: 1,
      producedCount: 1,
      completeness: "complete",
      warnings: [],
      items: [{
        ordinal: 0,
        name: "output-1",
        status: "succeeded",
        artifactId: `art_${HEX_32}`,
        artifactVersionId: `aver_${HEX_32}`,
        errorCode: null,
      }],
    },
  } as const;
  assertEquals(runDetailSchema.parse(run), run);
  assertThrows(() =>
    runDetailSchema.parse({
      ...run,
      outputSet: {
        ...run.outputSet,
        items: [{
          ...run.outputSet.items[0],
          artifactId: null,
        }],
      },
    })
  );
});

Deno.test("cancel run results enforce kind and current status combinations", () => {
  const run = {
    id: `run_${HEX_32}`,
    tool: {
      key: "image.generate",
      name: "Image Generate",
      versionId: `tver_${HEX_32}`,
      version: 1,
    },
    status: "cancelled",
    resultCompleteness: null,
    acceptedAt: "2026-08-24T10:00:00.000Z",
    startedAt: "2026-08-24T10:00:01.000Z",
    terminalAt: "2026-08-24T10:00:02.000Z",
    input: { prompt: "A lighthouse" },
    reservation: null,
    outputSet: null,
  } as const;

  assertEquals(
    cancelRunResultSchema.parse({ kind: "cancelled", run }),
    { kind: "cancelled", run },
  );
  assertEquals(
    cancelRunResultSchema.parse({
      kind: "cancel_requested",
      run: { ...run, status: "cancel_requested", terminalAt: null },
    }).kind,
    "cancel_requested",
  );
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    assertEquals(
      cancelRunResultSchema.parse({
        kind: "already_terminal",
        run: { ...run, status },
      }).kind,
      "already_terminal",
    );
  }

  assertThrows(() =>
    cancelRunResultSchema.parse({
      kind: "cancelled",
      run: { ...run, status: "succeeded" },
    })
  );
  assertThrows(() =>
    cancelRunResultSchema.parse({
      kind: "cancel_requested",
      run: { ...run, status: "running", terminalAt: null },
    })
  );
  assertThrows(() =>
    cancelRunResultSchema.parse({
      kind: "already_terminal",
      run: { ...run, status: "cancel_requested", terminalAt: null },
    })
  );
});

Deno.test("workspace event envelopes are discriminated and bounded", () => {
  const event = {
    id: "42",
    workspaceId: "workspace_1",
    occurredAt: "2026-08-24T10:00:00.000Z",
    event: {
      type: "run.status_changed",
      runId: `run_${HEX_32}`,
      status: "running",
    },
  } as const;
  assertEquals(workspaceEventEnvelopeSchema.parse(event), event);
  assertThrows(() =>
    workspaceEventEnvelopeSchema.parse({
      ...event,
      event: { ...event.event, artifactId: `art_${HEX_32}` },
    })
  );
});
