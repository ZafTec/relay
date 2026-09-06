import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { ArtifactService } from "@relay/artifacts";
import type { DatabasePool } from "@relay/database";
import type {
  CommitUsageReservationInput,
  MeteringTransaction,
  RecordProviderCostInput,
  ReleaseUsageReservationInput,
} from "@relay/metering";
import {
  type AzureFlux2ProRequest,
  type AzureGptImage2Request,
  type AzureMistralOcrRequest,
  AzureProviderError,
  type GeneratedImage,
  type ImageGenerationResult,
  type OcrResult,
  type ProviderCallOptions,
} from "@relay/providers";
import type { ObjectStorage } from "@relay/storage";
import type { RegisteredExecutionHandler } from "./handlers.ts";
import {
  createMvpExecutionHandlers,
  FLUX_2_PRO_HANDLER_KEY,
  GPT_IMAGE_2_HANDLER_KEY,
  MISTRAL_OCR_HANDLER_KEY,
  type MvpExecutionHandlerDependencies,
  type MvpMeteringOperations,
} from "./mvp-handlers.ts";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const WORKSPACE_ID = "workspace-test";
const RUN_ID = "run-test";
const TOOL_VERSION_ID = "tool-version-test";
const PROVIDER_MODEL_ID = "7200200200000001";
const RESERVATION_ID = "reservation_0123456789abcdef0123456789abcdef";
const TEXT_DECODER = new TextDecoder();

const PNG_BYTES = new Uint8Array([
  137,
  80,
  78,
  71,
  13,
  10,
  26,
  10,
  0,
  0,
  0,
  0,
]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const WEBP_BYTES = new Uint8Array([
  82,
  73,
  70,
  70,
  4,
  0,
  0,
  0,
  87,
  69,
  66,
  80,
]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nfixture");

interface ArtifactRow {
  readonly workspace_id: string;
  readonly artifact_id: string;
  readonly current_version_id: string | null;
  readonly artifact_version_id: string;
  readonly object_key: string;
  readonly storage_version_id: string | null;
  readonly size_bytes: string | number;
  readonly mime_type: string;
  readonly sha256: string;
  readonly verification_status: string;
  readonly artifact_deleted_at: Date | null;
  readonly artifact_purged_at: Date | null;
  readonly artifact_purge_status: string;
  readonly version_purged_at: Date | null;
  readonly version_purge_status: string;
}

interface ArtifactFixture {
  readonly row: ArtifactRow;
  readonly bytes: Uint8Array;
}

interface ArtifactCallLog {
  readonly outputSets: Array<{
    readonly workspaceId: string;
    readonly runId: string;
    readonly itemNames: readonly string[];
    readonly warnings?: readonly unknown[];
  }>;
  readonly ingests: Array<
    Parameters<ArtifactService["ingestGeneratedOutput"]>[0]
  >;
  readonly failures: Array<
    Parameters<ArtifactService["recordGeneratedOutputFailure"]>[0]
  >;
}

interface MeteringCallLog {
  readonly commits: CommitUsageReservationInput[];
  readonly releases: ReleaseUsageReservationInput[];
  readonly costs: RecordProviderCostInput[];
}

interface HarnessOptions {
  readonly input: unknown;
  readonly pricingPolicyId?: string | null;
  readonly artifactFixtures?: readonly ArtifactFixture[];
  readonly failedOrdinals?: ReadonlySet<number>;
  readonly gpt?: (
    request: AzureGptImage2Request,
    options?: ProviderCallOptions,
  ) => Promise<ImageGenerationResult>;
  readonly flux?: (
    request: AzureFlux2ProRequest,
    options?: ProviderCallOptions,
  ) => Promise<ImageGenerationResult>;
  readonly ocr?: (
    request: AzureMistralOcrRequest,
    options?: ProviderCallOptions,
  ) => Promise<OcrResult>;
}

interface Harness {
  readonly dependencies: MvpExecutionHandlerDependencies;
  readonly artifactCalls: ArtifactCallLog;
  readonly meteringCalls: MeteringCallLog;
  readonly queryTexts: string[];
  readonly storageReads: Array<{
    readonly key: string;
    readonly storageVersionId?: string;
  }>;
}

function hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer).then(
    (digest) =>
      Array.from(
        new Uint8Array(digest),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join(""),
  );
}

async function artifactFixture(
  ordinal: number,
  mimeType: string,
  bytes: Uint8Array,
  overrides: Partial<ArtifactRow> = {},
): Promise<ArtifactFixture> {
  const suffix = ordinal.toString(16).padStart(32, "0");
  const artifactId = `art_${suffix}`;
  const artifactVersionId = `aver_${suffix}`;
  return {
    bytes,
    row: {
      workspace_id: WORKSPACE_ID,
      artifact_id: artifactId,
      current_version_id: artifactVersionId,
      artifact_version_id: artifactVersionId,
      object_key:
        `artifacts/${artifactId}/${artifactVersionId}/1234567890abcdef1234567890abcdef1234567890abcdef`,
      storage_version_id: `storage-${ordinal}`,
      size_bytes: bytes.byteLength,
      mime_type: mimeType,
      sha256: await hex(bytes),
      verification_status: "cryptographically_verified",
      artifact_deleted_at: null,
      artifact_purged_at: null,
      artifact_purge_status: "not_requested",
      version_purged_at: null,
      version_purge_status: "not_requested",
      ...overrides,
    },
  };
}

function image(
  mediaType: GeneratedImage["mediaType"] = "image/png",
): GeneratedImage {
  const bytes = mediaType === "image/png"
    ? PNG_BYTES
    : mediaType === "image/jpeg"
    ? JPEG_BYTES
    : WEBP_BYTES;
  return { bytes, mediaType, width: 64, height: 64 };
}

function fakeArtifactService(
  failedOrdinals: ReadonlySet<number>,
): {
  readonly service: MvpExecutionHandlerDependencies["artifactService"];
  readonly calls: ArtifactCallLog;
} {
  const calls: ArtifactCallLog = {
    outputSets: [],
    ingests: [],
    failures: [],
  };
  const service: MvpExecutionHandlerDependencies["artifactService"] = {
    createOutputSet(input) {
      calls.outputSets.push(input);
      return Promise.resolve({
        kind: "created",
        outputSetId: "outset_0123456789abcdef0123456789abcdef",
      });
    },
    ingestGeneratedOutput(input) {
      calls.ingests.push(input);
      if (failedOrdinals.has(input.ordinal)) {
        return Promise.resolve({ kind: "storage_error" });
      }
      const suffix = (input.ordinal + 100).toString(16).padStart(32, "0");
      return Promise.resolve({
        kind: "stored",
        artifactId: `art_${suffix}`,
        artifactVersionId: `aver_${suffix}`,
      });
    },
    recordGeneratedOutputFailure(input) {
      calls.failures.push(input);
      return Promise.resolve({ kind: "recorded" });
    },
  };
  return { service, calls };
}

function fakeMetering(): {
  readonly operations: MvpMeteringOperations;
  readonly calls: MeteringCallLog;
} {
  const calls: MeteringCallLog = { commits: [], releases: [], costs: [] };
  const operations: MvpMeteringOperations = {
    commitUsageReservation(
      _transaction: MeteringTransaction,
      input: CommitUsageReservationInput,
    ) {
      calls.commits.push(input);
      return Promise.resolve({
        kind: "committed" as const,
        receipt: {
          reservationId: input.reservationId,
          status: "committed" as const,
          outcome: input.outcome,
          committedAmount: input.actualAmount,
          releasedAmount: "0",
          usageEventId: "usage-test",
          finalizedAt: NOW,
        },
      });
    },
    releaseUsageReservation(
      _transaction: MeteringTransaction,
      input: ReleaseUsageReservationInput,
    ) {
      calls.releases.push(input);
      return Promise.resolve({
        kind: "released" as const,
        receipt: {
          reservationId: input.reservationId,
          status: "released" as const,
          outcome: input.outcome,
          committedAmount: "0",
          releasedAmount: "1",
          usageEventId: null,
          finalizedAt: NOW,
        },
      });
    },
    recordProviderCostEvent(
      _transaction: MeteringTransaction,
      input: RecordProviderCostInput,
    ) {
      calls.costs.push(input);
      return Promise.resolve({ kind: "pricing_not_configured" as const });
    },
  };
  return { operations, calls };
}

function fakeStorage(
  fixtures: readonly ArtifactFixture[],
): {
  readonly storage: ObjectStorage;
  readonly reads: Array<
    { readonly key: string; readonly storageVersionId?: string }
  >;
} {
  const reads: Array<{
    readonly key: string;
    readonly storageVersionId?: string;
  }> = [];
  const byKey = new Map(
    fixtures.map((fixture) => [fixture.row.object_key, fixture]),
  );
  const storage = {
    getObjectStream(request: {
      readonly key: string;
      readonly storageVersionId?: string;
    }) {
      reads.push(request);
      const fixture = byKey.get(request.key);
      if (fixture === undefined) return Promise.resolve(null);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(fixture.bytes));
          controller.close();
        },
      });
      return Promise.resolve({
        head: {
          key: fixture.row.object_key,
          sizeBytes: fixture.bytes.byteLength,
          contentType: fixture.row.mime_type,
          etag: "etag",
          storageVersionId: fixture.row.storage_version_id,
          checksumSha256: null,
          lastModified: NOW,
          metadata: {},
        },
        body,
      });
    },
  } as unknown as ObjectStorage;
  return { storage, reads };
}

function createHarness(options: HarnessOptions): Harness {
  const queryTexts: string[] = [];
  const fixtures = options.artifactFixtures ?? [];
  const executeQuery = <Row>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: Row[]; rowCount: number }> => {
    const normalized = text.trim();
    queryTexts.push(normalized);
    if (normalized.includes("mvp:load-run")) {
      return Promise.resolve({
        rows: [{
          input: options.input,
          reservation_id: RESERVATION_ID,
          reservation_status: "active",
          pricing_policy_id: options.pricingPolicyId ?? null,
        }] as Row[],
        rowCount: 1,
      });
    }
    if (normalized.includes("mvp:load-artifact-versions")) {
      const requested = new Set(params[1] as string[]);
      const rows = fixtures.filter((fixture) =>
        requested.has(fixture.row.artifact_version_id)
      ).map((fixture) => fixture.row);
      return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
    }
    if (normalized.includes("mvp:load-ocr-source")) {
      const artifactId = params[1] as string | null;
      const versionId = params[2] as string | null;
      const rows = fixtures.filter((fixture) =>
        artifactId === null
          ? fixture.row.artifact_version_id === versionId
          : fixture.row.artifact_id === artifactId
      ).map((fixture) => fixture.row);
      return Promise.resolve({ rows: rows as Row[], rowCount: rows.length });
    }
    const lower = normalized.toLowerCase();
    if (
      lower === "begin" || lower === "commit" || lower === "rollback" ||
      lower.startsWith("savepoint relay_metering_probe_") ||
      lower.startsWith("release savepoint relay_metering_probe_")
    ) return Promise.resolve({ rows: [], rowCount: 0 });
    throw new Error(`Unexpected query: ${normalized}`);
  };
  const client = {
    query: executeQuery,
    release() {},
  };
  const pool = {
    query: executeQuery,
    connect: () => Promise.resolve(client),
  } as unknown as DatabasePool;
  const artifacts = fakeArtifactService(options.failedOrdinals ?? new Set());
  const metering = fakeMetering();
  const objectStorage = fakeStorage(fixtures);
  const unexpectedGpt = (): Promise<ImageGenerationResult> =>
    Promise.reject(new Error("Unexpected GPT call"));
  const unexpectedFlux = (): Promise<ImageGenerationResult> =>
    Promise.reject(new Error("Unexpected FLUX call"));
  const unexpectedOcr = (): Promise<OcrResult> =>
    Promise.reject(new Error("Unexpected OCR call"));

  return {
    dependencies: {
      pool,
      storage: objectStorage.storage,
      artifactService: artifacts.service,
      gptImage2Client: { generate: options.gpt ?? unexpectedGpt },
      flux2ProClient: { generate: options.flux ?? unexpectedFlux },
      mistralOcrClient: { process: options.ocr ?? unexpectedOcr },
      metering: metering.operations,
      now: () => NOW,
    },
    artifactCalls: artifacts.calls,
    meteringCalls: metering.calls,
    queryTexts,
    storageReads: objectStorage.reads,
  };
}

function executionContext(
  handlerKey: string,
  signal: AbortSignal = new AbortController().signal,
): Parameters<RegisteredExecutionHandler["execute"]>[0] {
  return {
    job: {
      jobId: "job-test",
      runId: RUN_ID,
      leaseEpoch: 1,
      dispatchGeneration: 0,
      workspaceId: WORKSPACE_ID,
      toolVersionId: TOOL_VERSION_ID,
      toolId: "tool-test",
      toolKey: handlerKey.startsWith("document")
        ? "document.ocr"
        : "image.generate",
      providerModelId: PROVIDER_MODEL_ID,
      capacityPoolId: "pool-test",
      capacityPoolKey: "pool-key-test",
      capacityUnits: 1,
      policyVersion: 1,
      capacityPolicyRevision: 1,
      capacityLimits: {
        globalTool: 1,
        pool: 1,
        workspaceTotal: 1,
        workspaceTool: 1,
      },
      submissionRatePolicy: {
        providerPerMinute: 1,
        toolPerMinute: null,
        capacityPoolRevision: 1,
        toolRevision: null,
      },
      previousRetryClassification: null,
      previousProviderOperationId: null,
    },
    attempt: {
      attemptId: "42",
      attemptNumber: 1,
      providerIdempotencyKey: "provider-key-test",
    },
    signal,
    routingDecision: {
      decisionId: "decision-test",
      requestedModelVersion: null,
      route: {
        toolId: "tool-test",
        toolVersionId: TOOL_VERSION_ID,
        toolVersionImmutableHash: "a".repeat(64),
        handlerKey,
        inputSchemaVersion: 1,
        handlerVersion: "1",
        bindingId: "binding-test",
        providerId: "provider-test",
        providerModelId: PROVIDER_MODEL_ID,
        capacityPoolId: "pool-test",
        routingOrder: 1,
        routingPolicyId: null,
        routingPolicyRevision: null,
        routingPolicyImmutableHash: null,
      },
      fallback: { used: false, reason: null },
    },
    recordProviderOperation: () => Promise.resolve(),
  };
}

function handler(
  dependencies: MvpExecutionHandlerDependencies,
  key: string,
): RegisteredExecutionHandler {
  const found = createMvpExecutionHandlers(dependencies).find((item) =>
    item.key === key
  );
  assert(found !== undefined);
  return found;
}

function encoded(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function assertCallerOwnedTransaction(queryTexts: readonly string[]): void {
  const controls = queryTexts.filter((text) => {
    const lower = text.toLowerCase();
    return lower === "begin" || lower === "commit" || lower === "rollback" ||
      lower.startsWith("savepoint relay_metering_probe_") ||
      lower.startsWith("release savepoint relay_metering_probe_");
  });
  assertEquals(controls.length, 4);
  assertEquals(controls[0].toLowerCase(), "begin");
  assert(controls[1].toLowerCase().startsWith("savepoint "));
  assert(controls[2].toLowerCase().startsWith("release savepoint "));
  assertEquals(controls[3].toLowerCase(), "commit");
}

Deno.test("MVP factory registers only the exact baseline handlers", () => {
  const handlers = createMvpExecutionHandlers(
    {} as unknown as MvpExecutionHandlerDependencies,
  );
  assertEquals(
    handlers.map(({ key, inputSchemaVersion, handlerVersion }) => ({
      key,
      inputSchemaVersion,
      handlerVersion,
    })),
    [
      {
        key: GPT_IMAGE_2_HANDLER_KEY,
        inputSchemaVersion: 1,
        handlerVersion: "1",
      },
      {
        key: FLUX_2_PRO_HANDLER_KEY,
        inputSchemaVersion: 1,
        handlerVersion: "1",
      },
      {
        key: MISTRAL_OCR_HANDLER_KEY,
        inputSchemaVersion: 1,
        handlerVersion: "1",
      },
    ],
  );
});

Deno.test("GPT maps all camelCase capabilities, stores multiple outputs, and settles actual usage", async () => {
  let captured: AzureGptImage2Request | undefined;
  const harness = createHarness({
    input: {
      prompt: "A private prompt that must not enter metadata",
      n: 2,
      size: "1024x1024",
      quality: "high",
      outputFormat: "jpeg",
      outputCompression: 81,
      background: "opaque",
      moderation: "low",
    },
    gpt(request) {
      captured = request;
      return Promise.resolve({
        images: [image("image/jpeg"), image("image/jpeg")],
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          inputTokenDetails: { imageTokens: 0, textTokens: 10 },
          outputTokenDetails: { imageTokens: 20, textTokens: 0 },
        },
      });
    },
  });

  const result = await handler(harness.dependencies, GPT_IMAGE_2_HANDLER_KEY)
    .execute(executionContext(GPT_IMAGE_2_HANDLER_KEY));

  assertEquals(result, { kind: "succeeded" });
  assertEquals(captured, {
    prompt: "A private prompt that must not enter metadata",
    n: 2,
    size: "1024x1024",
    quality: "high",
    output_format: "jpeg",
    output_compression: 81,
    background: "opaque",
    moderation: "low",
  });
  assertEquals(harness.artifactCalls.outputSets[0].itemNames, [
    "image-001.jpg",
    "image-002.jpg",
  ]);
  assertEquals(harness.artifactCalls.ingests.length, 2);
  for (const call of harness.artifactCalls.ingests) {
    const metadata = JSON.stringify(call.metadata);
    assert(!metadata.includes("private prompt"));
    assert(!metadata.includes("base64"));
    assert(!metadata.includes("://"));
  }
  assertEquals(harness.meteringCalls.commits, [{
    workspaceId: WORKSPACE_ID,
    reservationId: RESERVATION_ID,
    idempotencyKey: "mvp-execution:42:usage-settlement",
    outcome: "success",
    actualAmount: "2",
  }]);
  assertEquals(harness.meteringCalls.releases, []);
  assertEquals(harness.meteringCalls.costs, []);
  assertCallerOwnedTransaction(harness.queryTexts);
});

Deno.test("FLUX resolves up to eight exact artifact versions in caller order", async () => {
  const fixtures = await Promise.all(
    Array.from({ length: 8 }, (_, index) => {
      const bytes = new Uint8Array([...PNG_BYTES, index]);
      return artifactFixture(index + 1, "image/png", bytes);
    }),
  );
  let captured: AzureFlux2ProRequest | undefined;
  const versionIds = fixtures.map((fixture) => fixture.row.artifact_version_id);
  const harness = createHarness({
    input: {
      prompt: "Combine references",
      disablePromptUpsampling: true,
      inputArtifactVersionIds: versionIds,
      seed: 99,
      width: 1024,
      height: 1024,
      safetyTolerance: 4,
      outputFormat: "webp",
    },
    artifactFixtures: [...fixtures].reverse(),
    pricingPolicyId: "pricing-configured",
    flux(request) {
      captured = request;
      return Promise.resolve({ images: [image("image/webp")] });
    },
  });

  const result = await handler(harness.dependencies, FLUX_2_PRO_HANDLER_KEY)
    .execute(executionContext(FLUX_2_PRO_HANDLER_KEY));

  assertEquals(result, { kind: "succeeded" });
  assertEquals(captured?.prompt, "Combine references");
  assertEquals(captured?.disable_pup, true);
  assertEquals(captured?.seed, 99);
  assertEquals(captured?.width, 1024);
  assertEquals(captured?.height, 1024);
  assertEquals(captured?.safety_tolerance, 4);
  assertEquals(captured?.output_format, "webp");
  assertEquals(captured?.input_images?.length, 8);
  assertEquals(
    captured?.input_images,
    fixtures.map((fixture) =>
      `data:image/png;base64,${encoded(fixture.bytes)}`
    ),
  );
  assertEquals(
    harness.storageReads.map((read) => read.key),
    fixtures.map((fixture) => fixture.row.object_key),
  );
  assertEquals(harness.meteringCalls.commits[0].actualAmount, "1");
  assertEquals(harness.meteringCalls.costs.length, 1);
  assertEquals(
    harness.meteringCalls.costs[0].actualModelVersion,
    "FLUX.2-pro",
  );
  assertEquals(harness.meteringCalls.costs[0].normalizedUsage, {
    requests: { quantity: "1", unit: "request" },
    images: { quantity: "1", unit: "image" },
  });
});

Deno.test("artifact authorization fails closed before FLUX submission", async () => {
  const invalidCases: Array<Partial<ArtifactRow>> = [{
    workspace_id: "another-workspace",
  }, {
    verification_status: "pending",
  }, {
    artifact_deleted_at: NOW,
    artifact_purge_status: "pending",
  }, {
    version_purge_status: "deleted",
    version_purged_at: NOW,
  }];

  for (let index = 0; index < invalidCases.length; index += 1) {
    const fixture = await artifactFixture(
      index + 20,
      "image/png",
      PNG_BYTES,
      invalidCases[index],
    );
    let providerCalls = 0;
    const harness = createHarness({
      input: {
        prompt: "Do not submit",
        inputArtifactVersionIds: [fixture.row.artifact_version_id],
      },
      artifactFixtures: [fixture],
      flux() {
        providerCalls += 1;
        return Promise.resolve({ images: [image()] });
      },
    });

    const result = await handler(harness.dependencies, FLUX_2_PRO_HANDLER_KEY)
      .execute(executionContext(FLUX_2_PRO_HANDLER_KEY));
    assertEquals(result.kind, "failed");
    if (result.kind === "failed") {
      assertEquals(result.retryClassification, "schema_or_policy_failure");
      assertEquals(result.retryable, false);
    }
    assertEquals(providerCalls, 0);
    assertEquals(harness.storageReads, []);
    assertEquals(
      harness.meteringCalls.releases[0].outcome,
      "validation_rejected",
    );
  }
});

Deno.test("OCR applies useful defaults and resolves a current source artifact", async () => {
  const source = await artifactFixture(50, "application/pdf", PDF_BYTES);
  let captured: AzureMistralOcrRequest | undefined;
  const harness = createHarness({
    input: { sourceArtifactId: source.row.artifact_id },
    artifactFixtures: [source],
    ocr(request) {
      captured = request;
      return Promise.resolve({
        pages: [],
        documentAnnotation: null,
        usageInfo: {
          pagesProcessed: 0,
          documentSizeBytes: PDF_BYTES.byteLength,
        },
      });
    },
  });

  const result = await handler(harness.dependencies, MISTRAL_OCR_HANDLER_KEY)
    .execute(executionContext(MISTRAL_OCR_HANDLER_KEY));

  assertEquals(result, { kind: "succeeded" });
  assertEquals(captured, {
    document: `data:application/pdf;base64,${encoded(PDF_BYTES)}`,
    include_image_base64: false,
    table_format: "markdown",
    extract_header: true,
    extract_footer: true,
    confidence_scores_granularity: "word",
  });
  assertEquals(harness.artifactCalls.outputSets[0].itemNames, [
    "ocr.md",
    "ocr.json",
  ]);
  assertEquals(harness.meteringCalls.commits[0].actualAmount, "1");
});

Deno.test("OCR maps every public option, wraps strict schemas, and stores normalized outputs", async () => {
  const source = await artifactFixture(60, "image/jpeg", JPEG_BYTES);
  let captured: AzureMistralOcrRequest | undefined;
  const response: OcrResult = {
    pages: [{
      index: 2,
      markdown: "# Invoice\n\n| Item | Total |",
      header: "Invoice 17",
      footer: "Page 3",
      dimensions: { dpi: 200, width: 600, height: 800 },
      confidenceScores: {
        averagePageConfidenceScore: 0.97,
        minimumPageConfidenceScore: 0.81,
        wordConfidenceScores: [{
          text: "Invoice",
          confidence: 0.99,
          startIndex: 2,
        }],
      },
      images: [{
        id: "logo",
        topLeftX: 1,
        topLeftY: 2,
        bottomRightX: 65,
        bottomRightY: 66,
        image: image("image/png"),
        annotation: '{"kind":"logo"}',
      }],
      tables: [{
        id: "table-1",
        content: "<table><tr><td>Total</td></tr></table>",
        format: "html",
        wordConfidenceScores: [],
      }],
    }],
    documentAnnotation: '{"invoiceNumber":"17"}',
    usageInfo: { pagesProcessed: 1, documentSizeBytes: JPEG_BYTES.byteLength },
  };
  const imageSchema = {
    type: "object",
    properties: { kind: { type: "string" } },
    additionalProperties: false,
  };
  const extractionSchema = {
    type: "object",
    properties: { invoiceNumber: { type: "string" } },
    additionalProperties: false,
  };
  const harness = createHarness({
    input: {
      sourceArtifactVersionId: source.row.artifact_version_id,
      pages: [0, 2],
      includeImages: true,
      imageLimit: 8,
      imageMinSize: 64,
      imageAnnotationSchema: imageSchema,
      extractionSchema,
      extractionPrompt: "Extract invoice fields",
      tableFormat: "html",
      extractHeader: false,
      extractFooter: false,
      confidenceGranularity: "page",
    },
    artifactFixtures: [source],
    ocr(request) {
      captured = request;
      return Promise.resolve(response);
    },
  });

  const result = await handler(harness.dependencies, MISTRAL_OCR_HANDLER_KEY)
    .execute(executionContext(MISTRAL_OCR_HANDLER_KEY));

  assertEquals(result, { kind: "succeeded" });
  assertEquals(captured?.pages, [0, 2]);
  assertEquals(captured?.include_image_base64, true);
  assertEquals(captured?.image_limit, 8);
  assertEquals(captured?.image_min_size, 64);
  assertEquals(captured?.document_annotation_prompt, "Extract invoice fields");
  assertEquals(captured?.table_format, "html");
  assertEquals(captured?.extract_header, false);
  assertEquals(captured?.extract_footer, false);
  assertEquals(captured?.confidence_scores_granularity, "page");
  assertEquals(captured?.bbox_annotation_format, {
    type: "json_schema",
    json_schema: {
      name: "relay_image_annotation_v1",
      schema: imageSchema,
      strict: true,
    },
  });
  assertEquals(captured?.document_annotation_format, {
    type: "json_schema",
    json_schema: {
      name: "relay_document_extraction_v1",
      schema: extractionSchema,
      strict: true,
    },
  });
  assertEquals(harness.artifactCalls.outputSets[0].itemNames, [
    "ocr.md",
    "ocr.json",
    "extraction.json",
    "ocr-page-0001-image-0001.png",
    "ocr-page-0001-table-0001.html",
  ]);
  const ocrJson = harness.artifactCalls.ingests.find((call) =>
    call.artifactName === "ocr.json"
  );
  assert(ocrJson !== undefined);
  const normalized = TEXT_DECODER.decode(ocrJson.bytes);
  assertStringIncludes(normalized, '"pageNumber": 2');
  assert(!normalized.includes("base64"));
  assert(!normalized.includes("services.ai.azure.com"));
  const extraction = harness.artifactCalls.ingests.find((call) =>
    call.artifactName === "extraction.json"
  );
  assert(extraction !== undefined);
  assertEquals(JSON.parse(TEXT_DECODER.decode(extraction.bytes)), {
    invoiceNumber: "17",
  });
  for (const call of harness.artifactCalls.ingests) {
    const metadata = JSON.stringify(call.metadata);
    assert(!metadata.includes("Extract invoice fields"));
    assert(!metadata.includes("base64"));
    assert(!metadata.includes("://"));
  }
});

Deno.test("invalid or missing OCR extraction preserves Markdown and settles partial usage", async () => {
  const source = await artifactFixture(61, "application/pdf", PDF_BYTES);
  for (
    const annotation of [
      null,
      "provider-private-invalid-json",
      '{"invoiceNumber":17}',
      "{}",
    ]
  ) {
    const harness = createHarness({
      input: {
        sourceArtifactVersionId: source.row.artifact_version_id,
        extractionSchema: {
          type: "object",
          required: ["invoiceNumber"],
          properties: { invoiceNumber: { type: "string" } },
        },
      },
      artifactFixtures: [source],
      ocr: () =>
        Promise.resolve({
          pages: [],
          documentAnnotation: annotation,
          usageInfo: {
            pagesProcessed: 0,
            documentSizeBytes: PDF_BYTES.byteLength,
          },
        }),
    });
    const result = await handler(harness.dependencies, MISTRAL_OCR_HANDLER_KEY)
      .execute(executionContext(MISTRAL_OCR_HANDLER_KEY));
    assertEquals(result, { kind: "succeeded" });
    assertEquals(
      harness.artifactCalls.ingests.map((call) => call.artifactName),
      ["ocr.md", "ocr.json"],
    );
    assertEquals(harness.artifactCalls.ingests[0].bytes.byteLength, 0);
    assertEquals(
      harness.artifactCalls.failures[0].errorCode,
      "provider.invalid_structured_output",
    );
    assertEquals(harness.meteringCalls.commits[0].outcome, "partial_output");
    assertEquals(harness.meteringCalls.releases.length, 0);
    assertEquals(
      JSON.stringify(harness.artifactCalls).includes("provider-private"),
      false,
    );
  }
});

Deno.test("OCR rejects remote extraction schemas before storage reads or provider calls", async () => {
  const source = await artifactFixture(62, "application/pdf", PDF_BYTES);
  let providerCalls = 0;
  const harness = createHarness({
    input: {
      sourceArtifactVersionId: source.row.artifact_version_id,
      extractionSchema: { $ref: "https://example.test/schema" },
    },
    artifactFixtures: [source],
    ocr: () => {
      providerCalls++;
      throw new Error("must not submit");
    },
  });
  const result = await handler(harness.dependencies, MISTRAL_OCR_HANDLER_KEY)
    .execute(executionContext(MISTRAL_OCR_HANDLER_KEY));
  assertEquals(result.kind, "failed");
  assertEquals(providerCalls, 0);
  assertEquals(harness.storageReads.length, 0);
  assertEquals(
    harness.meteringCalls.releases[0].outcome,
    "validation_rejected",
  );
});

Deno.test("a stored subset records item failures and commits partial GPT usage", async () => {
  const harness = createHarness({
    input: { prompt: "Two images", n: 2 },
    failedOrdinals: new Set([1]),
    gpt: () =>
      Promise.resolve({ images: [image("image/png"), image("image/png")] }),
  });

  const result = await handler(harness.dependencies, GPT_IMAGE_2_HANDLER_KEY)
    .execute(executionContext(GPT_IMAGE_2_HANDLER_KEY));

  assertEquals(result, { kind: "succeeded" });
  assertEquals(harness.artifactCalls.failures, [{
    workspaceId: WORKSPACE_ID,
    outputSetId: "outset_0123456789abcdef0123456789abcdef",
    ordinal: 1,
    errorCode: "artifact.storage_error",
  }]);
  assertEquals(harness.meteringCalls.commits[0].outcome, "partial_output");
  assertEquals(harness.meteringCalls.commits[0].actualAmount, "2");
});

Deno.test("rate limits retain usage until terminal finalization", async () => {
  const harness = createHarness({
    input: { prompt: "Rate limited" },
    gpt: () =>
      Promise.reject(
        new AzureProviderError({
          provider: "azure-gpt-image-2",
          classification: "rate_limit",
          retryable: true,
          retryAfterMs: 24 * 60 * 60 * 1_000,
          status: 429,
        }),
      ),
  });

  const result = await handler(harness.dependencies, GPT_IMAGE_2_HANDLER_KEY)
    .execute(executionContext(GPT_IMAGE_2_HANDLER_KEY));

  assertEquals(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("expected a failure");
  assertEquals(result.retryClassification, "provider_rate_limited");
  assertEquals(result.retryable, true);
  assertEquals(
    result.retryAt?.toISOString(),
    new Date(NOW.getTime() + 5 * 60_000).toISOString(),
  );
  assertEquals(harness.meteringCalls.releases, []);
  assert(result.finalizeTerminalFailure !== undefined);
  await result.finalizeTerminalFailure();
  await result.finalizeTerminalFailure();
  assertEquals(harness.meteringCalls.releases, [{
    workspaceId: WORKSPACE_ID,
    reservationId: RESERVATION_ID,
    idempotencyKey: "mvp-execution:42:usage-settlement",
    outcome: "provider_failure",
  }]);
  assertCallerOwnedTransaction(harness.queryTexts);
});

Deno.test("timeout, network, and 5xx failures are nonretryable ambiguous submissions", async () => {
  for (
    const testCase of [
      { classification: "timeout" as const, outcome: "timed_out" as const },
      {
        classification: "network_error" as const,
        outcome: "provider_failure" as const,
      },
      {
        classification: "server_error" as const,
        outcome: "provider_failure" as const,
      },
    ]
  ) {
    const harness = createHarness({
      input: { prompt: "Ambiguous" },
      gpt: () =>
        Promise.reject(
          new AzureProviderError({
            provider: "azure-gpt-image-2",
            classification: testCase.classification,
            retryable: true,
            status: testCase.classification === "server_error"
              ? 503
              : undefined,
          }),
        ),
    });

    const result = await handler(harness.dependencies, GPT_IMAGE_2_HANDLER_KEY)
      .execute(executionContext(GPT_IMAGE_2_HANDLER_KEY));
    assertEquals(result.kind, "failed");
    if (result.kind !== "failed") throw new Error("expected a failure");
    assertEquals(result.retryClassification, "submission_ambiguous");
    assertEquals(result.retryable, false);
    assertEquals(result.failureCode, "provider_submission_ambiguous");
    assertEquals(harness.meteringCalls.releases[0].outcome, testCase.outcome);
  }
});

Deno.test("422 safety rejection is nonretryable and releases usage", async () => {
  const harness = createHarness({
    input: { prompt: "Rejected" },
    gpt: () =>
      Promise.reject(
        new AzureProviderError({
          provider: "azure-gpt-image-2",
          classification: "unprocessable_entity",
          status: 422,
        }),
      ),
  });

  const result = await handler(harness.dependencies, GPT_IMAGE_2_HANDLER_KEY)
    .execute(executionContext(GPT_IMAGE_2_HANDLER_KEY));

  assertEquals(result.kind, "failed");
  if (result.kind !== "failed") throw new Error("expected a failure");
  assertEquals(result.retryClassification, "safety_rejection");
  assertEquals(result.retryable, false);
  assertEquals(result.failureCode, "provider_safety_rejected");
  assertEquals(harness.meteringCalls.releases[0].outcome, "safety_rejected");
});

Deno.test("malformed provider output and total storage failure are nonretryable", async () => {
  const malformed = createHarness({
    input: { prompt: "Malformed" },
    gpt: () => Promise.resolve({ images: [] }),
  });
  const malformedResult = await handler(
    malformed.dependencies,
    GPT_IMAGE_2_HANDLER_KEY,
  ).execute(executionContext(GPT_IMAGE_2_HANDLER_KEY));
  assertEquals(malformedResult.kind, "failed");
  if (malformedResult.kind !== "failed") throw new Error("expected a failure");
  assertEquals(malformedResult.retryClassification, "provider_transient");
  assertEquals(malformedResult.retryable, false);
  assertEquals(malformedResult.failureCode, "provider_invalid_response");
  assertEquals(malformed.meteringCalls.releases[0].outcome, "provider_failure");

  const storage = createHarness({
    input: { prompt: "Cannot store" },
    failedOrdinals: new Set([0]),
    gpt: () => Promise.resolve({ images: [image()] }),
  });
  const storageResult = await handler(
    storage.dependencies,
    GPT_IMAGE_2_HANDLER_KEY,
  ).execute(executionContext(GPT_IMAGE_2_HANDLER_KEY));
  assertEquals(storageResult.kind, "failed");
  if (storageResult.kind !== "failed") throw new Error("expected a failure");
  assertEquals(storageResult.retryClassification, "storage_failure");
  assertEquals(storageResult.retryable, false);
  assertEquals(storage.meteringCalls.releases[0].outcome, "storage_failure");
  assertEquals(
    storage.artifactCalls.failures[0].errorCode,
    "artifact.storage_error",
  );
});

Deno.test("provider abort maps to cancellation and releases the reservation", async () => {
  const harness = createHarness({
    input: { prompt: "Cancelled" },
    gpt: () =>
      Promise.reject(
        new AzureProviderError({
          provider: "azure-gpt-image-2",
          classification: "aborted",
        }),
      ),
  });

  const result = await handler(harness.dependencies, GPT_IMAGE_2_HANDLER_KEY)
    .execute(executionContext(GPT_IMAGE_2_HANDLER_KEY));

  assertEquals(result, { kind: "cancelled" });
  assertEquals(harness.meteringCalls.releases[0].outcome, "cancelled");
  assertEquals(harness.meteringCalls.commits, []);
});

Deno.test("OCR rejects oversized authorized sources before storage or provider work", async () => {
  const source = await artifactFixture(70, "application/pdf", PDF_BYTES, {
    size_bytes: 30_000_001,
  });
  let providerCalls = 0;
  const harness = createHarness({
    input: { sourceArtifactVersionId: source.row.artifact_version_id },
    artifactFixtures: [source],
    ocr() {
      providerCalls += 1;
      return Promise.resolve({
        pages: [],
        documentAnnotation: null,
        usageInfo: { pagesProcessed: 0, documentSizeBytes: null },
      });
    },
  });

  const result = await handler(harness.dependencies, MISTRAL_OCR_HANDLER_KEY)
    .execute(executionContext(MISTRAL_OCR_HANDLER_KEY));

  assertEquals(result.kind, "failed");
  if (result.kind === "failed") {
    assertEquals(result.retryClassification, "schema_or_policy_failure");
  }
  assertEquals(providerCalls, 0);
  assertEquals(harness.storageReads, []);
  assertEquals(
    harness.meteringCalls.releases[0].outcome,
    "validation_rejected",
  );
});
