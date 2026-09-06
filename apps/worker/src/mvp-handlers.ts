import type { ArtifactService } from "@relay/artifacts";
import { type DatabasePool, withTransaction } from "@relay/database";
import {
  commitUsageReservation,
  type CommitUsageReservationInput,
  recordProviderCostEvent,
  type RecordProviderCostInput,
  releaseUsageReservation,
  type ReleaseUsageReservationInput,
  type UsageFinalizationResult,
  withMeteringTransaction,
} from "@relay/metering";
import {
  AZURE_FLUX_2_PRO_MAX_INPUT_IMAGES,
  AZURE_FLUX_2_PRO_MAX_PIXELS,
  AZURE_FLUX_2_PRO_MIN_EDGE,
  AZURE_FLUX_2_PRO_MODEL,
  AZURE_GPT_IMAGE_2_MAX_EDGE,
  AZURE_GPT_IMAGE_2_MAX_PIXELS,
  AZURE_GPT_IMAGE_2_MIN_PIXELS,
  AZURE_GPT_IMAGE_2_MODEL,
  AZURE_MISTRAL_OCR_MODEL,
  type AzureFlux2ProClient,
  type AzureFlux2ProRequest,
  type AzureGptImage2Client,
  type AzureGptImage2Request,
  type AzureMistralOcrClient,
  type AzureMistralOcrRequest,
  AzureProviderError,
  type GeneratedImage,
  type ImageGenerationResult,
  type JsonObject,
  type JsonValue,
  type OcrResult,
} from "@relay/providers";
import type { ExecutionHandlerResult } from "@relay/queue";
import type { ObjectRead, ObjectStorage } from "@relay/storage";
import type { RegisteredExecutionHandler } from "./handlers.ts";
import {
  compileOcrSchema,
  type OcrSchemaValidator,
  parseOcrAnnotation,
} from "./ocr-schema.ts";

export const GPT_IMAGE_2_HANDLER_KEY =
  "image.generate.azure-openai.gpt-image-2.v1" as const;
export const FLUX_2_PRO_HANDLER_KEY =
  "image.generate.azure-flux.flux-2-pro.v1" as const;
export const MISTRAL_OCR_HANDLER_KEY = "document.ocr.azure-mistral.v1" as const;

const INPUT_SCHEMA_VERSION = 1;
const HANDLER_VERSION = "1";
const OCR_MAX_SOURCE_BYTES = 30_000_000;
const FLUX_MAX_TOTAL_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_ITEMS = 1_000;
const DEFAULT_RATE_LIMIT_RETRY_MS = 30_000;
const MIN_RATE_LIMIT_RETRY_MS = 1_000;
const MAX_RATE_LIMIT_RETRY_MS = 5 * 60_000;
const ARTIFACT_VERSION_PATTERN = /^aver_[0-9a-f]{32}$/;
const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const VERIFIED_STATUSES = new Set([
  "head_verified",
  "cryptographically_verified",
]);
const IMAGE_INPUT_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const OCR_INPUT_MEDIA_TYPES = new Set([
  "application/pdf",
  ...IMAGE_INPUT_MEDIA_TYPES,
]);
const TEXT_ENCODER = new TextEncoder();

export interface MvpMeteringOperations {
  readonly commitUsageReservation: typeof commitUsageReservation;
  readonly releaseUsageReservation: typeof releaseUsageReservation;
  readonly recordProviderCostEvent: typeof recordProviderCostEvent;
}

type ArtifactOutputService = Pick<
  ArtifactService,
  | "createOutputSet"
  | "ingestGeneratedOutput"
  | "recordGeneratedOutputFailure"
>;

export interface MvpExecutionHandlerDependencies {
  readonly pool: DatabasePool;
  readonly storage: ObjectStorage;
  readonly artifactService: ArtifactOutputService;
  readonly gptImage2Client: Pick<AzureGptImage2Client, "generate">;
  readonly flux2ProClient: Pick<AzureFlux2ProClient, "generate">;
  readonly mistralOcrClient: Pick<AzureMistralOcrClient, "process">;
  /** Test seam. Production uses the imported @relay/metering operations. */
  readonly metering?: MvpMeteringOperations;
  readonly now?: () => Date;
}

interface RunExecutionContext {
  readonly input: unknown;
  readonly reservationId: string;
  readonly pricingPolicyId: string | null;
}

interface ArtifactSourceRow {
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
  readonly artifact_deleted_at: Date | string | null;
  readonly artifact_purged_at: Date | string | null;
  readonly artifact_purge_status: string;
  readonly version_purged_at: Date | string | null;
  readonly version_purge_status: string;
}

interface AuthorizedArtifact {
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly objectKey: string;
  readonly storageVersionId: string | null;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly sha256: string;
}

interface GptImageInput {
  readonly request: AzureGptImage2Request;
  readonly requestedCount: number;
}

interface FluxInput {
  readonly artifactVersionIds: readonly string[];
  readonly request: Omit<AzureFlux2ProRequest, "input_images">;
}

interface OcrInput {
  readonly sourceArtifactId?: string;
  readonly sourceArtifactVersionId?: string;
  readonly includeImages: boolean;
  readonly validateExtraction?: OcrSchemaValidator;
  readonly validateImageAnnotation?: OcrSchemaValidator;
  readonly request: Omit<AzureMistralOcrRequest, "document">;
}

interface ProviderCostUsage {
  readonly actualModelVersion: string;
  readonly normalizedUsage: Readonly<Record<string, unknown>>;
}

interface ExecutionState {
  providerCost?: ProviderCostUsage;
}

interface SuccessfulExecution {
  readonly outcome: "success" | "partial_output";
  readonly actualAmount: string;
}

interface StoredOutput {
  readonly kind: "content";
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly mediaKind: string;
  readonly mimeType: string;
  readonly width?: number;
  readonly height?: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

interface FailedOutput {
  readonly kind: "failure";
  readonly name: string;
  readonly errorCode: string;
}

type PlannedOutput = StoredOutput | FailedOutput;

class MvpValidationError extends Error {
  override readonly name = "MvpValidationError";

  constructor(readonly field: string) {
    super(`Invalid MVP execution input (${field})`);
  }
}

class MvpStorageError extends Error {
  override readonly name = "MvpStorageError";

  constructor(readonly code: string) {
    super(`MVP artifact operation failed (${code})`);
  }
}

class MvpProviderResponseError extends Error {
  override readonly name = "MvpProviderResponseError";

  constructor(readonly field: string) {
    super(`Provider returned malformed normalized output (${field})`);
  }
}

class MvpCancellationError extends Error {
  override readonly name = "MvpCancellationError";

  constructor() {
    super("MVP execution was cancelled");
  }
}

class MvpSettlementError extends Error {
  override readonly name = "MvpSettlementError";

  constructor() {
    super("Usage settlement failed");
  }
}

const DEFAULT_METERING: MvpMeteringOperations = {
  commitUsageReservation,
  releaseUsageReservation,
  recordProviderCostEvent,
};

function strictObject(
  value: unknown,
  allowedKeys: readonly string[],
  field = "input",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MvpValidationError(field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MvpValidationError(field);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new MvpValidationError(field);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new MvpValidationError(field);
    }
  }
  return value as Record<string, unknown>;
}

function stringValue(
  value: unknown,
  field: string,
  maximumCodePoints: number,
): string {
  if (typeof value !== "string") throw new MvpValidationError(field);
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maximumCodePoints) throw new MvpValidationError(field);
  }
  if (length === 0) throw new MvpValidationError(field);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new MvpValidationError(field);
  return value;
}

function integerValue(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum
  ) {
    throw new MvpValidationError(field);
  }
  return value;
}

function optionalInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  return value === undefined
    ? undefined
    : integerValue(value, field, minimum, maximum);
}

function optionalEnum<const Value extends string>(
  value: unknown,
  field: string,
  allowed: readonly Value[],
): Value | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw new MvpValidationError(field);
  }
  return value as Value;
}

function optionalProperty<Value>(
  value: Value | undefined,
  key: string,
): Record<string, Value> {
  return value === undefined ? {} : { [key]: value };
}

interface JsonTraversalState {
  nodes: number;
  readonly seen: WeakSet<object>;
}

function cloneBoundedJson(
  value: unknown,
  field: string,
  depth: number,
  state: JsonTraversalState,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > 8_192 || depth > 16) {
    throw new MvpValidationError(field);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new MvpValidationError(field);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 65_536) throw new MvpValidationError(field);
    return value;
  }
  if (typeof value !== "object" || state.seen.has(value)) {
    throw new MvpValidationError(field);
  }
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 2_048) throw new MvpValidationError(field);
      return value.map((item) =>
        cloneBoundedJson(item, field, depth + 1, state)
      );
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MvpValidationError(field);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 512) throw new MvpValidationError(field);
    const cloned: Record<string, JsonValue> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string" || key.length > 256) {
        throw new MvpValidationError(field);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new MvpValidationError(field);
      }
      cloned[key] = cloneBoundedJson(
        descriptor.value,
        field,
        depth + 1,
        state,
      );
    }
    return cloned;
  } finally {
    state.seen.delete(value);
  }
}

function jsonSchema(value: unknown, field: string): JsonObject {
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Reflect.ownKeys(value).length > 256
  ) {
    throw new MvpValidationError(field);
  }
  const cloned = cloneBoundedJson(value, field, 0, {
    nodes: 0,
    seen: new WeakSet(),
  });
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw new MvpValidationError(field);
  }
  if (TEXT_ENCODER.encode(JSON.stringify(cloned)).byteLength > 256 * 1024) {
    throw new MvpValidationError(field);
  }
  return cloned as JsonObject;
}

function parseGptImageInput(value: unknown): GptImageInput {
  const input = strictObject(value, [
    "prompt",
    "n",
    "size",
    "quality",
    "outputFormat",
    "outputCompression",
    "background",
    "moderation",
  ]);
  const prompt = stringValue(input.prompt, "prompt", 32_000);
  const n = optionalInteger(input.n, "n", 1, 10);
  const size = input.size === undefined
    ? undefined
    : stringValue(input.size, "size", 9);
  if (size !== undefined && size !== "auto") {
    const match = /^([1-9][0-9]{0,3})x([1-9][0-9]{0,3})$/.exec(size);
    if (match === null) throw new MvpValidationError("size");
    const width = Number(match[1]);
    const height = Number(match[2]);
    const pixels = width * height;
    if (
      width % 16 !== 0 || height % 16 !== 0 ||
      width > AZURE_GPT_IMAGE_2_MAX_EDGE ||
      height > AZURE_GPT_IMAGE_2_MAX_EDGE ||
      Math.max(width, height) / Math.min(width, height) > 3 ||
      pixels < AZURE_GPT_IMAGE_2_MIN_PIXELS ||
      pixels > AZURE_GPT_IMAGE_2_MAX_PIXELS
    ) throw new MvpValidationError("size");
  }
  const quality = optionalEnum(
    input.quality,
    "quality",
    [
      "low",
      "medium",
      "high",
    ] as const,
  );
  const outputFormat = optionalEnum(
    input.outputFormat,
    "outputFormat",
    [
      "png",
      "jpeg",
    ] as const,
  );
  const outputCompression = optionalInteger(
    input.outputCompression,
    "outputCompression",
    0,
    100,
  );
  const background = optionalEnum(
    input.background,
    "background",
    [
      "auto",
      "transparent",
      "opaque",
    ] as const,
  );
  const moderation = optionalEnum(
    input.moderation,
    "moderation",
    [
      "auto",
      "low",
    ] as const,
  );
  const effectiveFormat = outputFormat ?? "png";
  if (outputCompression !== undefined && effectiveFormat !== "jpeg") {
    throw new MvpValidationError("outputCompression");
  }
  if (background === "transparent" && effectiveFormat !== "png") {
    throw new MvpValidationError("background");
  }

  return {
    requestedCount: n ?? 1,
    request: {
      prompt,
      ...optionalProperty(n, "n"),
      ...optionalProperty(size, "size"),
      ...optionalProperty(quality, "quality"),
      ...optionalProperty(outputFormat, "output_format"),
      ...optionalProperty(outputCompression, "output_compression"),
      ...optionalProperty(background, "background"),
      ...optionalProperty(moderation, "moderation"),
    } as AzureGptImage2Request,
  };
}

function parseFluxInput(value: unknown): FluxInput {
  const input = strictObject(value, [
    "prompt",
    "disablePromptUpsampling",
    "inputArtifactVersionIds",
    "seed",
    "width",
    "height",
    "safetyTolerance",
    "outputFormat",
  ]);
  const prompt = stringValue(input.prompt, "prompt", 32_000);
  const disablePup = optionalBoolean(
    input.disablePromptUpsampling,
    "disablePromptUpsampling",
  );
  let artifactVersionIds: readonly string[] = [];
  if (input.inputArtifactVersionIds !== undefined) {
    if (
      !Array.isArray(input.inputArtifactVersionIds) ||
      input.inputArtifactVersionIds.length < 1 ||
      input.inputArtifactVersionIds.length > AZURE_FLUX_2_PRO_MAX_INPUT_IMAGES
    ) throw new MvpValidationError("inputArtifactVersionIds");
    const ids = input.inputArtifactVersionIds.map((item) => {
      if (typeof item !== "string" || !ARTIFACT_VERSION_PATTERN.test(item)) {
        throw new MvpValidationError("inputArtifactVersionIds");
      }
      return item;
    });
    if (new Set(ids).size !== ids.length) {
      throw new MvpValidationError("inputArtifactVersionIds");
    }
    artifactVersionIds = ids;
  }
  const seed = optionalInteger(
    input.seed,
    "seed",
    Number.MIN_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER,
  );
  const width = optionalInteger(
    input.width,
    "width",
    AZURE_FLUX_2_PRO_MIN_EDGE,
    Math.floor(AZURE_FLUX_2_PRO_MAX_PIXELS / AZURE_FLUX_2_PRO_MIN_EDGE),
  );
  const height = optionalInteger(
    input.height,
    "height",
    AZURE_FLUX_2_PRO_MIN_EDGE,
    Math.floor(AZURE_FLUX_2_PRO_MAX_PIXELS / AZURE_FLUX_2_PRO_MIN_EDGE),
  );
  if (
    width !== undefined && height !== undefined &&
    width * height > AZURE_FLUX_2_PRO_MAX_PIXELS
  ) throw new MvpValidationError("width/height");
  const safetyTolerance = optionalInteger(
    input.safetyTolerance,
    "safetyTolerance",
    0,
    5,
  );
  const outputFormat = optionalEnum(
    input.outputFormat,
    "outputFormat",
    [
      "jpeg",
      "png",
      "webp",
    ] as const,
  );

  return {
    artifactVersionIds,
    request: {
      prompt,
      ...optionalProperty(disablePup, "disable_pup"),
      ...optionalProperty(seed, "seed"),
      ...optionalProperty(width, "width"),
      ...optionalProperty(height, "height"),
      ...optionalProperty(safetyTolerance, "safety_tolerance"),
      ...optionalProperty(outputFormat, "output_format"),
    },
  };
}

function parsePageSelection(value: unknown): string | readonly number[] {
  if (Array.isArray(value)) {
    if (value.length < 1 || value.length > 1_000) {
      throw new MvpValidationError("pages");
    }
    const pages = value.map((page) => integerValue(page, "pages", 0, 99_999));
    if (new Set(pages).size !== pages.length) {
      throw new MvpValidationError("pages");
    }
    return pages;
  }
  const pages = stringValue(value, "pages", 4_096);
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(pages)) {
    throw new MvpValidationError("pages");
  }
  let count = 0;
  for (const part of pages.split(",")) {
    const [startText, endText] = part.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
      end < start || end > 99_999
    ) throw new MvpValidationError("pages");
    count += end - start + 1;
    if (count > 1_000) throw new MvpValidationError("pages");
  }
  return pages;
}

function strictSchemaFormat(name: string, schema: JsonObject) {
  return {
    type: "json_schema" as const,
    json_schema: {
      name,
      schema,
      strict: true,
    },
  };
}

function parseOcrInput(value: unknown): OcrInput {
  const input = strictObject(value, [
    "sourceArtifactId",
    "sourceArtifactVersionId",
    "pages",
    "includeImages",
    "imageLimit",
    "imageMinSize",
    "imageAnnotationSchema",
    "extractionSchema",
    "extractionPrompt",
    "tableFormat",
    "extractHeader",
    "extractFooter",
    "confidenceGranularity",
  ]);
  const sourceArtifactId = input.sourceArtifactId;
  const sourceArtifactVersionId = input.sourceArtifactVersionId;
  if (
    (sourceArtifactId === undefined) ===
      (sourceArtifactVersionId === undefined) ||
    sourceArtifactId !== undefined &&
      (typeof sourceArtifactId !== "string" ||
        !ARTIFACT_ID_PATTERN.test(sourceArtifactId)) ||
    sourceArtifactVersionId !== undefined &&
      (typeof sourceArtifactVersionId !== "string" ||
        !ARTIFACT_VERSION_PATTERN.test(sourceArtifactVersionId))
  ) throw new MvpValidationError("sourceArtifact");

  const pages = input.pages === undefined
    ? undefined
    : parsePageSelection(input.pages);
  const includeImages = optionalBoolean(input.includeImages, "includeImages") ??
    false;
  const imageLimit = optionalInteger(
    input.imageLimit,
    "imageLimit",
    0,
    10_000,
  );
  const imageMinSize = optionalInteger(
    input.imageMinSize,
    "imageMinSize",
    0,
    100_000,
  );
  const imageAnnotationSchema = input.imageAnnotationSchema === undefined
    ? undefined
    : jsonSchema(input.imageAnnotationSchema, "imageAnnotationSchema");
  const extractionSchema = input.extractionSchema === undefined
    ? undefined
    : jsonSchema(input.extractionSchema, "extractionSchema");
  function validator(schema: JsonObject | undefined, field: string) {
    if (schema === undefined) return undefined;
    try {
      return compileOcrSchema(schema);
    } catch {
      throw new MvpValidationError(field);
    }
  }
  const validateExtraction = validator(extractionSchema, "extractionSchema");
  const validateImageAnnotation = validator(
    imageAnnotationSchema,
    "imageAnnotationSchema",
  );
  const extractionPrompt = input.extractionPrompt === undefined
    ? undefined
    : stringValue(input.extractionPrompt, "extractionPrompt", 32_000);
  if (extractionPrompt !== undefined && extractionSchema === undefined) {
    throw new MvpValidationError("extractionPrompt");
  }
  const tableFormat = optionalEnum(
    input.tableFormat,
    "tableFormat",
    [
      "markdown",
      "html",
    ] as const,
  ) ?? "markdown";
  const extractHeader = optionalBoolean(input.extractHeader, "extractHeader") ??
    true;
  const extractFooter = optionalBoolean(input.extractFooter, "extractFooter") ??
    true;
  const confidenceGranularity = optionalEnum(
    input.confidenceGranularity,
    "confidenceGranularity",
    ["word", "page"] as const,
  ) ?? "word";

  return {
    ...(sourceArtifactId === undefined ? {} : { sourceArtifactId }),
    ...(sourceArtifactVersionId === undefined
      ? {}
      : { sourceArtifactVersionId }),
    includeImages,
    validateExtraction,
    validateImageAnnotation,
    request: {
      ...optionalProperty(pages, "pages"),
      include_image_base64: includeImages,
      ...optionalProperty(imageLimit, "image_limit"),
      ...optionalProperty(imageMinSize, "image_min_size"),
      ...(imageAnnotationSchema === undefined ? {} : {
        bbox_annotation_format: strictSchemaFormat(
          "relay_image_annotation_v1",
          imageAnnotationSchema,
        ),
      }),
      ...(extractionSchema === undefined ? {} : {
        document_annotation_format: strictSchemaFormat(
          "relay_document_extraction_v1",
          extractionSchema,
        ),
      }),
      ...optionalProperty(extractionPrompt, "document_annotation_prompt"),
      table_format: tableFormat,
      extract_header: extractHeader,
      extract_footer: extractFooter,
      confidence_scores_granularity: confidenceGranularity,
    },
  };
}

function parseDatabaseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new MvpValidationError("storedInput");
  }
}

async function loadRunExecutionContext(
  pool: DatabasePool,
  context: Parameters<RegisteredExecutionHandler["execute"]>[0],
): Promise<RunExecutionContext> {
  const result = await pool.query<{
    input: unknown;
    reservation_id: string;
    reservation_status: string;
    pricing_policy_id: string | null;
  }>(
    `/* mvp:load-run */
     select run.input, usage.id as reservation_id,
            usage.status as reservation_status, model.pricing_policy_id
       from relay.tool_runs run
       join relay.usage_reservations usage
         on usage.workspace_id = run.workspace_id
        and usage.id = run.reservation_id
        and usage.tool_version_id = run.tool_version_id
       join relay.provider_models model
         on model.id = usage.provider_model_id
      where run.workspace_id = $1 and run.id = $2
        and run.tool_version_id = $3
        and usage.provider_model_id = $4::bigint`,
    [
      context.job.workspaceId,
      context.job.runId,
      context.job.toolVersionId,
      context.routingDecision.route.providerModelId,
    ],
  );
  const row = result.rows[0];
  if (
    result.rows.length !== 1 || row === undefined ||
    typeof row.reservation_id !== "string" ||
    row.reservation_id.length === 0 || row.reservation_status !== "active" ||
    row.pricing_policy_id !== null &&
      typeof row.pricing_policy_id !== "string"
  ) throw new MvpValidationError("runReservation");
  return {
    input: parseDatabaseJson(row.input),
    reservationId: row.reservation_id,
    pricingPolicyId: row.pricing_policy_id,
  };
}

function artifactFromRow(
  row: ArtifactSourceRow,
  workspaceId: string,
  expectedVersionId?: string,
): AuthorizedArtifact {
  const sizeBytes = typeof row.size_bytes === "number"
    ? row.size_bytes
    : Number(row.size_bytes);
  if (
    row.workspace_id !== workspaceId ||
    !ARTIFACT_ID_PATTERN.test(row.artifact_id) ||
    !ARTIFACT_VERSION_PATTERN.test(row.artifact_version_id) ||
    expectedVersionId !== undefined &&
      row.artifact_version_id !== expectedVersionId ||
    !VERIFIED_STATUSES.has(row.verification_status) ||
    row.artifact_deleted_at !== null || row.artifact_purged_at !== null ||
    row.artifact_purge_status !== "not_requested" ||
    row.version_purged_at !== null ||
    row.version_purge_status !== "not_requested" ||
    typeof row.object_key !== "string" || row.object_key.length === 0 ||
    row.object_key.includes("://") ||
    row.storage_version_id !== null &&
      (typeof row.storage_version_id !== "string" ||
        row.storage_version_id.length === 0 ||
        row.storage_version_id.includes("://")) ||
    !Number.isSafeInteger(sizeBytes) || sizeBytes < 1 ||
    typeof row.mime_type !== "string" ||
    !SHA256_PATTERN.test(row.sha256)
  ) throw new MvpValidationError("artifactVersion");
  return {
    artifactId: row.artifact_id,
    artifactVersionId: row.artifact_version_id,
    objectKey: row.object_key,
    storageVersionId: row.storage_version_id,
    sizeBytes,
    mimeType: row.mime_type.trim().toLowerCase(),
    sha256: row.sha256,
  };
}

const ARTIFACT_SOURCE_COLUMNS = `
  a.workspace_id, a.id as artifact_id, a.current_version_id,
  v.id as artifact_version_id, v.object_key, v.storage_version_id,
  v.size_bytes, v.mime_type, v.sha256, v.verification_status,
  a.deleted_at as artifact_deleted_at, a.purged_at as artifact_purged_at,
  a.purge_status as artifact_purge_status,
  v.purged_at as version_purged_at, v.purge_status as version_purge_status
`;

async function loadFluxArtifacts(
  pool: DatabasePool,
  workspaceId: string,
  versionIds: readonly string[],
): Promise<readonly AuthorizedArtifact[]> {
  if (versionIds.length === 0) return [];
  let rows: ArtifactSourceRow[];
  try {
    const result = await pool.query<ArtifactSourceRow>(
      `/* mvp:load-artifact-versions */
       select ${ARTIFACT_SOURCE_COLUMNS}
         from relay.artifact_versions v
         join relay.artifacts a
           on a.workspace_id = v.workspace_id and a.id = v.artifact_id
        where a.workspace_id = $1 and v.id = any($2::text[])
          and a.deleted_at is null and a.purged_at is null
          and a.purge_status = 'not_requested'
          and v.purged_at is null and v.purge_status = 'not_requested'
          and v.verification_status in (
            'head_verified', 'cryptographically_verified'
          )`,
      [workspaceId, [...versionIds]],
    );
    rows = result.rows;
  } catch {
    throw new MvpStorageError("artifact_lookup_failed");
  }
  if (rows.length !== versionIds.length) {
    throw new MvpValidationError("inputArtifactVersionIds");
  }
  const byId = new Map(
    rows.map((row) => [
      row.artifact_version_id,
      artifactFromRow(row, workspaceId, row.artifact_version_id),
    ]),
  );
  return versionIds.map((id) => {
    const artifact = byId.get(id);
    if (artifact === undefined) {
      throw new MvpValidationError("inputArtifactVersionIds");
    }
    return artifact;
  });
}

async function loadOcrArtifact(
  pool: DatabasePool,
  workspaceId: string,
  input: OcrInput,
): Promise<AuthorizedArtifact> {
  let rows: ArtifactSourceRow[];
  try {
    const result = await pool.query<ArtifactSourceRow>(
      `/* mvp:load-ocr-source */
       select ${ARTIFACT_SOURCE_COLUMNS}
         from relay.artifacts a
         join relay.artifact_versions v
           on v.workspace_id = a.workspace_id and v.artifact_id = a.id
        where a.workspace_id = $1
          and (
            ($2::text is not null and a.id = $2 and v.id = a.current_version_id)
            or ($3::text is not null and v.id = $3)
          )
          and a.deleted_at is null and a.purged_at is null
          and a.purge_status = 'not_requested'
          and v.purged_at is null and v.purge_status = 'not_requested'
          and v.verification_status in (
            'head_verified', 'cryptographically_verified'
          )`,
      [
        workspaceId,
        input.sourceArtifactId ?? null,
        input.sourceArtifactVersionId ?? null,
      ],
    );
    rows = result.rows;
  } catch {
    throw new MvpStorageError("artifact_lookup_failed");
  }
  if (rows.length !== 1) throw new MvpValidationError("sourceArtifact");
  const artifact = artifactFromRow(
    rows[0],
    workspaceId,
    input.sourceArtifactVersionId,
  );
  if (
    input.sourceArtifactId !== undefined &&
    (artifact.artifactId !== input.sourceArtifactId ||
      rows[0].current_version_id !== artifact.artifactVersionId)
  ) throw new MvpValidationError("sourceArtifactId");
  return artifact;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.byteLength) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function sniffedMediaType(bytes: Uint8Array): string | null {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes.byteLength >= png.length &&
    png.every((byte, index) => bytes[index] === byte)
  ) return "image/png";
  if (
    bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) return "image/jpeg";
  if (
    bytes.byteLength >= 12 && asciiAt(bytes, 0, "RIFF") &&
    asciiAt(bytes, 8, "WEBP")
  ) return "image/webp";
  const pdfSearchLimit = Math.min(bytes.byteLength - 4, 1_024);
  for (let offset = 0; offset < pdfSearchLimit; offset += 1) {
    if (asciiAt(bytes, offset, "%PDF-")) return "application/pdf";
  }
  return null;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readBoundedBody(
  read: ObjectRead,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(read.head.sizeBytes) || read.head.sizeBytes < 0 ||
    read.head.sizeBytes > maximumBytes
  ) {
    await read.body.cancel().catch(() => undefined);
    throw new MvpStorageError("artifact_too_large");
  }
  const reader = read.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined);
        throw new MvpCancellationError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw new MvpStorageError("invalid_object_stream");
      }
      total += value.byteLength;
      if (total > maximumBytes || total > read.head.sizeBytes) {
        await reader.cancel().catch(() => undefined);
        throw new MvpStorageError("artifact_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total !== read.head.sizeBytes) {
    throw new MvpStorageError("artifact_size_mismatch");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readArtifactBytes(
  storage: ObjectStorage,
  artifact: AuthorizedArtifact,
  allowedMediaTypes: ReadonlySet<string>,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (!allowedMediaTypes.has(artifact.mimeType)) {
    throw new MvpValidationError("artifactMimeType");
  }
  if (artifact.sizeBytes > maximumBytes) {
    throw new MvpValidationError("artifactSize");
  }
  if (signal.aborted) throw new MvpCancellationError();

  let read: ObjectRead | null;
  try {
    read = await storage.getObjectStream({
      key: artifact.objectKey,
      ...(artifact.storageVersionId === null
        ? {}
        : { storageVersionId: artifact.storageVersionId }),
    });
  } catch {
    throw new MvpStorageError("object_read_failed");
  }
  if (read === null) throw new MvpStorageError("object_not_found");
  if (
    read.head.key !== artifact.objectKey ||
    read.head.sizeBytes !== artifact.sizeBytes ||
    read.head.contentType?.trim().toLowerCase() !== artifact.mimeType ||
    artifact.storageVersionId !== null &&
      read.head.storageVersionId !== artifact.storageVersionId
  ) {
    await read.body.cancel().catch(() => undefined);
    throw new MvpStorageError("object_metadata_mismatch");
  }

  const bytes = await readBoundedBody(read, maximumBytes, signal);
  if (sniffedMediaType(bytes) !== artifact.mimeType) {
    throw new MvpStorageError("object_magic_mismatch");
  }
  if (await sha256Hex(bytes) !== artifact.sha256) {
    throw new MvpStorageError("object_checksum_mismatch");
  }
  return bytes;
}

function base64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    let binary = "";
    for (const byte of chunk) binary += String.fromCharCode(byte);
    parts.push(binary);
  }
  return btoa(parts.join(""));
}

function dataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${base64(bytes)}`;
}

function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "text/html":
      return "html";
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    default:
      throw new MvpProviderResponseError("mimeType");
  }
}

function validateGeneratedImage(
  image: GeneratedImage,
  field: string,
): GeneratedImage {
  if (
    typeof image !== "object" || image === null ||
    !(image.bytes instanceof Uint8Array) || image.bytes.byteLength < 1 ||
    !IMAGE_INPUT_MEDIA_TYPES.has(image.mediaType) ||
    !Number.isSafeInteger(image.width) || image.width < 1 ||
    !Number.isSafeInteger(image.height) || image.height < 1 ||
    sniffedMediaType(image.bytes) !== image.mediaType
  ) throw new MvpProviderResponseError(field);
  return image;
}

function validateImageResult(
  result: ImageGenerationResult,
  maximumImages: number,
  expectedMediaType?: GeneratedImage["mediaType"],
): readonly GeneratedImage[] {
  if (
    typeof result !== "object" || result === null ||
    !Array.isArray(result.images) || result.images.length < 1 ||
    result.images.length > maximumImages
  ) throw new MvpProviderResponseError("images");
  return result.images.map((image, index) => {
    const normalized = validateGeneratedImage(image, `images[${index}]`);
    if (
      expectedMediaType !== undefined &&
      normalized.mediaType !== expectedMediaType
    ) throw new MvpProviderResponseError(`images[${index}].mediaType`);
    return normalized;
  });
}

function quantity(value: number, unit: string) {
  return { quantity: String(value), unit };
}

function imageProviderUsage(
  result: ImageGenerationResult,
  imageCount: number,
): Readonly<Record<string, unknown>> {
  const normalized: Record<string, unknown> = {
    requests: quantity(1, "request"),
    images: quantity(imageCount, "image"),
  };
  if (result.usage !== undefined) {
    normalized.input_tokens = quantity(result.usage.inputTokens, "token");
    normalized.output_tokens = quantity(result.usage.outputTokens, "token");
    normalized.total_tokens = quantity(result.usage.totalTokens, "token");
    normalized.input_image_tokens = quantity(
      result.usage.inputTokenDetails.imageTokens,
      "token",
    );
    normalized.input_text_tokens = quantity(
      result.usage.inputTokenDetails.textTokens,
      "token",
    );
    if (result.usage.outputTokenDetails !== undefined) {
      normalized.output_image_tokens = quantity(
        result.usage.outputTokenDetails.imageTokens,
        "token",
      );
      normalized.output_text_tokens = quantity(
        result.usage.outputTokenDetails.textTokens,
        "token",
      );
    }
  }
  return normalized;
}

async function createOutputSet(
  artifactService: ArtifactOutputService,
  workspaceId: string,
  runId: string,
  outputs: readonly PlannedOutput[],
  warnings: readonly unknown[] = [],
): Promise<string> {
  let result;
  try {
    result = await artifactService.createOutputSet({
      workspaceId,
      runId,
      itemNames: outputs.map((output) => output.name),
      warnings,
    });
  } catch {
    throw new MvpStorageError("output_set_create_failed");
  }
  if (result.kind !== "created" && result.kind !== "already_exists") {
    throw new MvpStorageError(`output_set_${result.kind}`);
  }
  return result.outputSetId;
}

async function recordItemFailure(
  artifactService: ArtifactOutputService,
  workspaceId: string,
  outputSetId: string,
  ordinal: number,
  errorCode: string,
): Promise<void> {
  let result;
  try {
    result = await artifactService.recordGeneratedOutputFailure({
      workspaceId,
      outputSetId,
      ordinal,
      errorCode,
    });
  } catch {
    throw new MvpStorageError("output_failure_record_failed");
  }
  if (result.kind !== "recorded" && result.kind !== "already_recorded") {
    throw new MvpStorageError("output_failure_record_failed");
  }
}

function ingestionFailureCode(
  kind: "not_found" | "quota_exceeded" | "conflict" | "storage_error",
): string {
  switch (kind) {
    case "not_found":
      return "artifact.not_found";
    case "quota_exceeded":
      return "artifact.quota_exceeded";
    case "conflict":
      return "artifact.conflict";
    case "storage_error":
      return "artifact.storage_error";
  }
}

async function persistOutputs(
  dependencies: MvpExecutionHandlerDependencies,
  workspaceId: string,
  outputSetId: string,
  outputs: readonly PlannedOutput[],
  signal: AbortSignal,
): Promise<{ readonly stored: number; readonly failed: number }> {
  let stored = 0;
  let failed = 0;
  for (let ordinal = 0; ordinal < outputs.length; ordinal += 1) {
    if (signal.aborted) throw new MvpCancellationError();
    const output = outputs[ordinal];
    if (output.kind === "failure") {
      await recordItemFailure(
        dependencies.artifactService,
        workspaceId,
        outputSetId,
        ordinal,
        output.errorCode,
      );
      failed += 1;
      continue;
    }

    let result;
    try {
      result = await dependencies.artifactService.ingestGeneratedOutput({
        workspaceId,
        outputSetId,
        ordinal,
        bytes: output.bytes,
        artifactName: output.name,
        mediaKind: output.mediaKind,
        mimeType: output.mimeType,
        ...(output.width === undefined ? {} : { width: output.width }),
        ...(output.height === undefined ? {} : { height: output.height }),
        metadata: output.metadata,
      });
    } catch {
      await recordItemFailure(
        dependencies.artifactService,
        workspaceId,
        outputSetId,
        ordinal,
        "artifact.storage_error",
      );
      failed += 1;
      continue;
    }
    if (result.kind === "stored" || result.kind === "already_recorded") {
      stored += 1;
      continue;
    }
    await recordItemFailure(
      dependencies.artifactService,
      workspaceId,
      outputSetId,
      ordinal,
      ingestionFailureCode(result.kind),
    );
    failed += 1;
  }
  return { stored, failed };
}

function imageOutput(
  image: GeneratedImage,
  ordinal: number,
  provider: "azure-gpt-image-2" | "azure-flux-2-pro",
  extraMetadata: Readonly<Record<string, unknown>> = {},
): StoredOutput {
  const extension = extensionFor(image.mediaType);
  return {
    kind: "content",
    name: `image-${String(ordinal + 1).padStart(3, "0")}.${extension}`,
    bytes: image.bytes,
    mediaKind: "image",
    mimeType: image.mediaType,
    width: image.width,
    height: image.height,
    metadata: {
      provider,
      outputType: "generated_image",
      ordinal,
      ...extraMetadata,
    },
  };
}

async function executeGptImage(
  dependencies: MvpExecutionHandlerDependencies,
  context: Parameters<RegisteredExecutionHandler["execute"]>[0],
  inputValue: unknown,
  state: ExecutionState,
): Promise<SuccessfulExecution> {
  const input = parseGptImageInput(inputValue);
  const result = await dependencies.gptImage2Client.generate(input.request, {
    signal: context.signal,
  });
  const expectedMediaType = input.request.output_format === "jpeg"
    ? "image/jpeg"
    : "image/png";
  const images = validateImageResult(
    result,
    input.requestedCount,
    expectedMediaType,
  );
  state.providerCost = {
    actualModelVersion: AZURE_GPT_IMAGE_2_MODEL,
    normalizedUsage: imageProviderUsage(result, images.length),
  };

  const outputs: PlannedOutput[] = [];
  for (let ordinal = 0; ordinal < input.requestedCount; ordinal += 1) {
    const image = images[ordinal];
    outputs.push(
      image === undefined
        ? {
          kind: "failure",
          name: `image-${String(ordinal + 1).padStart(3, "0")}.${
            extensionFor(expectedMediaType)
          }`,
          errorCode: "provider.missing_output",
        }
        : imageOutput(image, ordinal, "azure-gpt-image-2"),
    );
  }
  const outputSetId = await createOutputSet(
    dependencies.artifactService,
    context.job.workspaceId,
    context.job.runId,
    outputs,
  );
  const persisted = await persistOutputs(
    dependencies,
    context.job.workspaceId,
    outputSetId,
    outputs,
    context.signal,
  );
  if (persisted.stored === 0) {
    throw new MvpStorageError("no_output_stored");
  }
  return {
    outcome: persisted.failed === 0 ? "success" : "partial_output",
    actualAmount: String(images.length),
  };
}

async function loadFluxDataUrls(
  dependencies: MvpExecutionHandlerDependencies,
  workspaceId: string,
  versionIds: readonly string[],
  signal: AbortSignal,
): Promise<readonly string[]> {
  const artifacts = await loadFluxArtifacts(
    dependencies.pool,
    workspaceId,
    versionIds,
  );
  const urls: string[] = [];
  let remaining = FLUX_MAX_TOTAL_SOURCE_BYTES;
  for (const artifact of artifacts) {
    if (artifact.sizeBytes > remaining) {
      throw new MvpValidationError("inputArtifactVersionIds");
    }
    const bytes = await readArtifactBytes(
      dependencies.storage,
      artifact,
      IMAGE_INPUT_MEDIA_TYPES,
      remaining,
      signal,
    );
    remaining -= bytes.byteLength;
    urls.push(dataUrl(artifact.mimeType, bytes));
  }
  return urls;
}

async function executeFlux(
  dependencies: MvpExecutionHandlerDependencies,
  context: Parameters<RegisteredExecutionHandler["execute"]>[0],
  inputValue: unknown,
  state: ExecutionState,
): Promise<SuccessfulExecution> {
  const input = parseFluxInput(inputValue);
  const inputImages = await loadFluxDataUrls(
    dependencies,
    context.job.workspaceId,
    input.artifactVersionIds,
    context.signal,
  );
  const result = await dependencies.flux2ProClient.generate({
    ...input.request,
    ...(inputImages.length === 0 ? {} : { input_images: inputImages }),
  }, { signal: context.signal });
  const images = validateImageResult(
    result,
    1,
    `image/${input.request.output_format ?? "jpeg"}`,
  );
  if (images.length !== 1) throw new MvpProviderResponseError("images");
  state.providerCost = {
    actualModelVersion: AZURE_FLUX_2_PRO_MODEL,
    normalizedUsage: imageProviderUsage(result, 1),
  };
  const outputs = [
    imageOutput(
      images[0],
      0,
      "azure-flux-2-pro",
      input.request.seed === undefined ? {} : { seed: input.request.seed },
    ),
  ];
  const outputSetId = await createOutputSet(
    dependencies.artifactService,
    context.job.workspaceId,
    context.job.runId,
    outputs,
  );
  const persisted = await persistOutputs(
    dependencies,
    context.job.workspaceId,
    outputSetId,
    outputs,
    context.signal,
  );
  if (persisted.stored === 0) {
    throw new MvpStorageError("no_output_stored");
  }
  return {
    outcome: persisted.failed === 0 ? "success" : "partial_output",
    actualAmount: "1",
  };
}

function normalizedOcrDocument(
  result: OcrResult,
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    pages: result.pages.map((page) => ({
      pageNumber: page.index,
      markdown: page.markdown,
      header: page.header,
      footer: page.footer,
      dimensions: page.dimensions,
      confidenceScores: page.confidenceScores,
      images: page.images.map((image) => ({
        id: image.id,
        topLeftX: image.topLeftX,
        topLeftY: image.topLeftY,
        bottomRightX: image.bottomRightX,
        bottomRightY: image.bottomRightY,
        annotation: image.annotation,
        mediaType: image.image?.mediaType ?? null,
        width: image.image?.width ?? null,
        height: image.image?.height ?? null,
      })),
      tables: page.tables,
    })),
    usageInfo: result.usageInfo,
    documentAnnotationReturned: result.documentAnnotation !== null,
  };
}

function jsonBytes(value: unknown): Uint8Array {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2);
  } catch {
    throw new MvpProviderResponseError("jsonOutput");
  }
  return TEXT_ENCODER.encode(`${serialized}\n`);
}

function ocrOutputs(
  result: OcrResult,
  source: AuthorizedArtifact,
  input: OcrInput,
): {
  readonly outputs: readonly PlannedOutput[];
  readonly warnings: readonly {
    readonly code: string;
    readonly maximumItems?: number;
  }[];
} {
  if (
    typeof result !== "object" || result === null ||
    !Array.isArray(result.pages) || result.pages.length > 1_000 ||
    typeof result.usageInfo !== "object" || result.usageInfo === null
  ) throw new MvpProviderResponseError("ocr");
  const warnings: Array<
    { readonly code: string; readonly maximumItems?: number }
  > = [];
  let invalidImageAnnotation = false;
  const pages: OcrResult["pages"] = (result.pages as OcrResult["pages"]).map((
    page,
  ) => ({
    ...page,
    images: page.images.map((image) => {
      if (input.validateImageAnnotation === undefined) return image;
      if (
        parseOcrAnnotation(image.annotation, input.validateImageAnnotation)
          .valid
      ) return image;
      invalidImageAnnotation = true;
      return { ...image, annotation: null };
    }),
  }));
  if (invalidImageAnnotation) {
    warnings.push({ code: "image_annotation_invalid" });
  }
  const metadata = {
    provider: "azure-mistral-ocr",
    sourceArtifactId: source.artifactId,
    sourceArtifactVersionId: source.artifactVersionId,
  };
  const combinedMarkdown = pages.map((page) => page.markdown).join(
    "\n\n---\n\n",
  );
  const outputs: PlannedOutput[] = [{
    kind: "content",
    name: "ocr.md",
    bytes: TEXT_ENCODER.encode(combinedMarkdown),
    mediaKind: "document",
    mimeType: "text/markdown",
    metadata: { ...metadata, outputType: "combined_markdown" },
  }, {
    kind: "content",
    name: "ocr.json",
    bytes: jsonBytes(normalizedOcrDocument({ ...result, pages })),
    mediaKind: "document",
    mimeType: "application/json",
    metadata: { ...metadata, outputType: "normalized_ocr" },
  }];
  if (
    input.validateExtraction !== undefined || result.documentAnnotation !== null
  ) {
    const extraction = parseOcrAnnotation(
      result.documentAnnotation,
      input.validateExtraction,
    );
    outputs.push(
      extraction.valid
        ? {
          kind: "content",
          name: "extraction.json",
          bytes: jsonBytes(extraction.value),
          mediaKind: "document",
          mimeType: "application/json",
          metadata: { ...metadata, outputType: "structured_extraction" },
        }
        : {
          kind: "failure",
          name: "extraction.json",
          errorCode: "provider.invalid_structured_output",
        },
    );
  }

  pages.forEach((page, pageOrdinal) => {
    if (
      typeof page !== "object" || page === null ||
      !Number.isSafeInteger(page.index) || page.index < 0 ||
      typeof page.markdown !== "string" || !Array.isArray(page.images) ||
      !Array.isArray(page.tables)
    ) throw new MvpProviderResponseError(`pages[${pageOrdinal}]`);
    page.images.forEach((image, imageOrdinal) => {
      if (image.image === null) return;
      const normalized = validateGeneratedImage(
        image.image,
        `pages[${pageOrdinal}].images[${imageOrdinal}]`,
      );
      outputs.push({
        kind: "content",
        name: `ocr-page-${String(pageOrdinal + 1).padStart(4, "0")}-image-${
          String(imageOrdinal + 1).padStart(4, "0")
        }.${extensionFor(normalized.mediaType)}`,
        bytes: normalized.bytes,
        mediaKind: "image",
        mimeType: normalized.mediaType,
        width: normalized.width,
        height: normalized.height,
        metadata: {
          ...metadata,
          outputType: "extracted_image",
          pageNumber: page.index,
          itemOrdinal: imageOrdinal,
        },
      });
    });
    page.tables.forEach((table, tableOrdinal) => {
      if (
        typeof table !== "object" || table === null ||
        typeof table.content !== "string" ||
        table.format !== "markdown" && table.format !== "html"
      ) {
        throw new MvpProviderResponseError(
          `pages[${pageOrdinal}].tables[${tableOrdinal}]`,
        );
      }
      const mimeType = table.format === "html" ? "text/html" : "text/markdown";
      outputs.push({
        kind: "content",
        name: `ocr-page-${String(pageOrdinal + 1).padStart(4, "0")}-table-${
          String(tableOrdinal + 1).padStart(4, "0")
        }.${extensionFor(mimeType)}`,
        bytes: TEXT_ENCODER.encode(table.content),
        mediaKind: "document",
        mimeType,
        metadata: {
          ...metadata,
          outputType: "extracted_table",
          pageNumber: page.index,
          itemOrdinal: tableOrdinal,
        },
      });
    });
  });
  if (outputs.length > MAX_OUTPUT_ITEMS) {
    warnings.push({
      code: "output_items_truncated",
      maximumItems: MAX_OUTPUT_ITEMS,
    });
  }
  return {
    outputs: outputs.slice(0, MAX_OUTPUT_ITEMS),
    warnings,
  };
}

function ocrProviderUsage(
  result: OcrResult,
): Readonly<Record<string, unknown>> {
  const normalized: Record<string, unknown> = {
    requests: quantity(1, "request"),
    pages: quantity(result.usageInfo.pagesProcessed, "page"),
  };
  if (result.usageInfo.documentSizeBytes !== null) {
    normalized.document_bytes = quantity(
      result.usageInfo.documentSizeBytes,
      "byte",
    );
  }
  return normalized;
}

async function executeOcr(
  dependencies: MvpExecutionHandlerDependencies,
  context: Parameters<RegisteredExecutionHandler["execute"]>[0],
  inputValue: unknown,
  state: ExecutionState,
): Promise<SuccessfulExecution> {
  const input = parseOcrInput(inputValue);
  const source = await loadOcrArtifact(
    dependencies.pool,
    context.job.workspaceId,
    input,
  );
  const bytes = await readArtifactBytes(
    dependencies.storage,
    source,
    OCR_INPUT_MEDIA_TYPES,
    OCR_MAX_SOURCE_BYTES,
    context.signal,
  );
  const result = await dependencies.mistralOcrClient.process({
    document: dataUrl(source.mimeType, bytes),
    ...input.request,
  }, { signal: context.signal });
  const plan = ocrOutputs(result, source, input);
  state.providerCost = {
    actualModelVersion: AZURE_MISTRAL_OCR_MODEL,
    normalizedUsage: ocrProviderUsage(result),
  };
  const outputSetId = await createOutputSet(
    dependencies.artifactService,
    context.job.workspaceId,
    context.job.runId,
    plan.outputs,
    plan.warnings,
  );
  const persisted = await persistOutputs(
    dependencies,
    context.job.workspaceId,
    outputSetId,
    plan.outputs,
    context.signal,
  );
  if (persisted.stored === 0) {
    throw new MvpStorageError("no_output_stored");
  }
  return {
    outcome: persisted.failed === 0 && plan.warnings.length === 0
      ? "success"
      : "partial_output",
    actualAmount: "1",
  };
}

function settlementSucceeded(
  result: UsageFinalizationResult,
  action: "commit" | "release",
): boolean {
  return result.kind === "replayed" ||
    action === "commit" && result.kind === "committed" ||
    action === "release" && result.kind === "released";
}

async function settleUsage(
  dependencies: MvpExecutionHandlerDependencies,
  context: Parameters<RegisteredExecutionHandler["execute"]>[0],
  run: RunExecutionContext,
  settlement:
    | {
      readonly action: "commit";
      readonly outcome: "success" | "partial_output";
      readonly actualAmount: string;
    }
    | {
      readonly action: "release";
      readonly outcome:
        | "validation_rejected"
        | "safety_rejected"
        | "provider_failure"
        | "cancelled"
        | "timed_out"
        | "storage_failure";
    },
  providerCost: ProviderCostUsage | undefined,
): Promise<void> {
  const operations = dependencies.metering ?? DEFAULT_METERING;
  await withTransaction(dependencies.pool, async (client) => {
    await withMeteringTransaction(client, async (transaction) => {
      const idempotencyKey =
        `mvp-execution:${context.attempt.attemptId}:usage-settlement`;
      const result = settlement.action === "commit"
        ? await operations.commitUsageReservation(
          transaction,
          {
            workspaceId: context.job.workspaceId,
            reservationId: run.reservationId,
            idempotencyKey,
            outcome: settlement.outcome,
            actualAmount: settlement.actualAmount,
          } satisfies CommitUsageReservationInput,
        )
        : await operations.releaseUsageReservation(
          transaction,
          {
            workspaceId: context.job.workspaceId,
            reservationId: run.reservationId,
            idempotencyKey,
            outcome: settlement.outcome,
          } satisfies ReleaseUsageReservationInput,
        );
      if (!settlementSucceeded(result, settlement.action)) {
        throw new MvpSettlementError();
      }

      if (providerCost !== undefined && run.pricingPolicyId !== null) {
        const cost = await operations.recordProviderCostEvent(
          transaction,
          {
            workspaceId: context.job.workspaceId,
            runId: context.job.runId,
            attemptId: context.attempt.attemptId,
            actualModelVersion: providerCost.actualModelVersion,
            normalizedUsage: providerCost.normalizedUsage,
            idempotencyKey:
              `mvp-execution:${context.attempt.attemptId}:provider-cost`,
          } satisfies RecordProviderCostInput,
        );
        if (
          cost.kind !== "recorded" && cost.kind !== "replayed" &&
          cost.kind !== "pricing_not_configured"
        ) throw new MvpSettlementError();
      }
    });
  });
}

interface MappedFailure {
  readonly result: ExecutionHandlerResult;
  readonly outcome:
    | "validation_rejected"
    | "safety_rejected"
    | "provider_failure"
    | "cancelled"
    | "timed_out"
    | "storage_failure";
}

function fixedFailure(
  retryClassification:
    | "schema_or_policy_failure"
    | "safety_rejection"
    | "provider_transient"
    | "storage_failure"
    | "submission_ambiguous",
  failureCode: string,
  message: string,
): ExecutionHandlerResult {
  return {
    kind: "failed",
    retryClassification,
    retryable: false,
    failureCode,
    error: new Error(message),
  };
}

function mapFailure(
  error: unknown,
  signal: AbortSignal,
  now: () => Date,
): MappedFailure {
  if (
    signal.aborted || error instanceof MvpCancellationError ||
    error instanceof DOMException && error.name === "AbortError"
  ) {
    return { result: { kind: "cancelled" }, outcome: "cancelled" };
  }
  if (error instanceof MvpValidationError) {
    return {
      result: fixedFailure(
        "schema_or_policy_failure",
        "invalid_execution_input",
        error.message,
      ),
      outcome: "validation_rejected",
    };
  }
  if (error instanceof MvpStorageError) {
    return {
      result: fixedFailure("storage_failure", error.code, error.message),
      outcome: "storage_failure",
    };
  }
  if (error instanceof MvpProviderResponseError) {
    return {
      result: fixedFailure(
        "provider_transient",
        "provider_invalid_response",
        error.message,
      ),
      outcome: "provider_failure",
    };
  }
  if (error instanceof AzureProviderError) {
    switch (error.classification) {
      case "aborted":
        return { result: { kind: "cancelled" }, outcome: "cancelled" };
      case "rate_limit": {
        const supplied = error.retryAfterMs;
        const retryAfterMs = typeof supplied === "number" &&
            Number.isSafeInteger(supplied) && supplied >= 0
          ? Math.min(
            MAX_RATE_LIMIT_RETRY_MS,
            Math.max(MIN_RATE_LIMIT_RETRY_MS, supplied),
          )
          : DEFAULT_RATE_LIMIT_RETRY_MS;
        const base = now();
        return {
          result: {
            kind: "failed",
            retryClassification: "provider_rate_limited",
            retryable: true,
            retryAt: new Date(base.getTime() + retryAfterMs),
            failureCode: "provider_rate_limited",
            error,
          },
          outcome: "provider_failure",
        };
      }
      case "invalid_input":
      case "client_error":
        return {
          result: fixedFailure(
            "schema_or_policy_failure",
            "provider_request_rejected",
            error.message,
          ),
          outcome: "validation_rejected",
        };
      case "unprocessable_entity":
        return {
          result: fixedFailure(
            "safety_rejection",
            "provider_safety_rejected",
            error.message,
          ),
          outcome: "safety_rejected",
        };
      case "timeout":
        return {
          result: fixedFailure(
            "submission_ambiguous",
            "provider_submission_ambiguous",
            error.message,
          ),
          outcome: "timed_out",
        };
      case "network_error":
      case "server_error":
        return {
          result: fixedFailure(
            "submission_ambiguous",
            "provider_submission_ambiguous",
            error.message,
          ),
          outcome: "provider_failure",
        };
      case "response_too_large":
      case "invalid_response":
        return {
          result: fixedFailure(
            "provider_transient",
            "provider_invalid_response",
            error.message,
          ),
          outcome: "provider_failure",
        };
      case "authentication":
      case "authorization":
        return {
          result: fixedFailure(
            "provider_transient",
            "provider_configuration_failure",
            error.message,
          ),
          outcome: "provider_failure",
        };
    }
  }
  return {
    result: fixedFailure(
      "provider_transient",
      "execution_failed",
      "MVP execution failed",
    ),
    outcome: "provider_failure",
  };
}

function settlementFailure(): ExecutionHandlerResult {
  return fixedFailure(
    "schema_or_policy_failure",
    "usage_settlement_failed",
    "Usage settlement failed",
  );
}

type ToolExecutor = (
  dependencies: MvpExecutionHandlerDependencies,
  context: Parameters<RegisteredExecutionHandler["execute"]>[0],
  input: unknown,
  state: ExecutionState,
) => Promise<SuccessfulExecution>;

function registeredHandler(
  key: string,
  dependencies: MvpExecutionHandlerDependencies,
  executor: ToolExecutor,
): RegisteredExecutionHandler {
  return {
    key,
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    handlerVersion: HANDLER_VERSION,
    async execute(context): Promise<ExecutionHandlerResult> {
      let run: RunExecutionContext;
      try {
        run = await loadRunExecutionContext(dependencies.pool, context);
      } catch (error) {
        const mapped = mapFailure(
          error,
          context.signal,
          () => dependencies.now?.() ?? new Date(),
        );
        return mapped.result;
      }

      const state: ExecutionState = {};
      let execution: SuccessfulExecution;
      try {
        if (context.signal.aborted) throw new MvpCancellationError();
        execution = await executor(dependencies, context, run.input, state);
      } catch (error) {
        const mapped = mapFailure(
          error,
          context.signal,
          () => dependencies.now?.() ?? new Date(),
        );
        if (
          mapped.result.kind === "failed" &&
          mapped.result.retryClassification === "provider_rate_limited"
        ) {
          let finalization: Promise<void> | undefined;
          return {
            ...mapped.result,
            finalizeTerminalFailure: () => {
              finalization ??= settleUsage(
                dependencies,
                context,
                run,
                { action: "release", outcome: mapped.outcome },
                state.providerCost,
              );
              return finalization;
            },
          };
        }
        try {
          await settleUsage(
            dependencies,
            context,
            run,
            { action: "release", outcome: mapped.outcome },
            state.providerCost,
          );
        } catch {
          return settlementFailure();
        }
        return mapped.result;
      }

      try {
        await settleUsage(
          dependencies,
          context,
          run,
          {
            action: "commit",
            outcome: execution.outcome,
            actualAmount: execution.actualAmount,
          },
          state.providerCost,
        );
      } catch {
        return settlementFailure();
      }
      return { kind: "succeeded" };
    },
  };
}

/** Creates the exact three execution handlers published by the MVP baseline. */
export function createMvpExecutionHandlers(
  dependencies: MvpExecutionHandlerDependencies,
): RegisteredExecutionHandler[] {
  return [
    registeredHandler(GPT_IMAGE_2_HANDLER_KEY, dependencies, executeGptImage),
    registeredHandler(FLUX_2_PRO_HANDLER_KEY, dependencies, executeFlux),
    registeredHandler(MISTRAL_OCR_HANDLER_KEY, dependencies, executeOcr),
  ];
}
