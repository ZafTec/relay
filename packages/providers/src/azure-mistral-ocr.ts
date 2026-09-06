import { invalidInput, invalidResponse } from "./errors.ts";
import { type NormalizedImage, normalizeEncodedImage } from "./image.ts";
import {
  postJson,
  resolveClientOptions,
  type ResolvedClientOptions,
} from "./http.ts";
import {
  AZURE_AI_BASE_URL,
  type AzureProviderClientOptions,
  type JsonObject,
  type ProviderCallOptions,
} from "./types.ts";
import {
  booleanValue,
  boundedJsonObject,
  boundedString,
  callSignal,
  enumValue,
  safeInteger,
  strictRecord,
  validateDataUrl,
  withInputValidation,
} from "./validation.ts";

const PROVIDER = "azure-mistral-ocr" as const;
const DOCUMENT_MEDIA_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;
const MAX_PAGES = 1_000;
const MAX_PAGE_NUMBER = 99_999;
const MAX_PAGE_MARKDOWN_LENGTH = 16 * 1024 * 1024;
const MAX_PAGE_ITEMS = 2_048;
const MAX_IMAGE_PIXELS = 64 * 1024 * 1024;

export const AZURE_MISTRAL_OCR_MODEL = "mistral-ocr-4-0" as const;
export const AZURE_MISTRAL_OCR_ENDPOINT =
  `${AZURE_AI_BASE_URL}/providers/mistral/azure/ocr?api-version=2024-05-01-preview` as const;

export type AzureMistralOcrTableFormat = "markdown" | "html";
export type AzureMistralOcrConfidenceGranularity = "word" | "page";

export interface AzureMistralOcrJsonSchema {
  readonly name: string;
  readonly description?: string;
  readonly schema: JsonObject;
  readonly strict?: boolean;
}

export interface AzureMistralOcrAnnotationFormat {
  readonly type: "json_schema";
  readonly json_schema: AzureMistralOcrJsonSchema;
}

export interface AzureMistralOcrRequest {
  readonly document: string;
  readonly pages?: string | readonly number[];
  readonly include_image_base64?: boolean;
  readonly image_limit?: number;
  readonly image_min_size?: number;
  readonly bbox_annotation_format?: AzureMistralOcrAnnotationFormat;
  readonly document_annotation_format?: AzureMistralOcrAnnotationFormat;
  readonly document_annotation_prompt?: string;
  readonly table_format?: AzureMistralOcrTableFormat;
  readonly extract_header?: boolean;
  readonly extract_footer?: boolean;
  readonly confidence_scores_granularity?: AzureMistralOcrConfidenceGranularity;
}

export interface OcrPageDimensions {
  readonly dpi: number;
  readonly height: number;
  readonly width: number;
}

export interface OcrConfidenceScore {
  readonly text: string;
  readonly confidence: number;
  readonly startIndex: number;
}

export interface OcrPageConfidenceScores {
  readonly averagePageConfidenceScore: number;
  readonly minimumPageConfidenceScore: number;
  readonly wordConfidenceScores: readonly OcrConfidenceScore[];
}

export interface OcrImage {
  readonly id: string;
  readonly topLeftX: number | null;
  readonly topLeftY: number | null;
  readonly bottomRightX: number | null;
  readonly bottomRightY: number | null;
  readonly image: NormalizedImage | null;
  readonly annotation: string | null;
}

export interface OcrTable {
  readonly id: string;
  readonly content: string;
  readonly format: AzureMistralOcrTableFormat;
  readonly wordConfidenceScores: readonly OcrConfidenceScore[];
}

export interface OcrPage {
  readonly index: number;
  readonly markdown: string;
  readonly images: readonly OcrImage[];
  readonly tables: readonly OcrTable[];
  readonly header: string | null;
  readonly footer: string | null;
  readonly dimensions: OcrPageDimensions | null;
  readonly confidenceScores: OcrPageConfidenceScores | null;
}

export interface OcrUsageInfo {
  readonly pagesProcessed: number;
  readonly documentSizeBytes: number | null;
}

export interface OcrResult {
  readonly pages: readonly OcrPage[];
  readonly documentAnnotation: string | null;
  readonly usageInfo: OcrUsageInfo;
}

interface PreparedOcrRequest {
  readonly body: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

function annotationFormat(
  value: unknown,
  field: string,
): AzureMistralOcrAnnotationFormat {
  const format = strictRecord(
    value,
    ["type", "json_schema"],
    PROVIDER,
    field,
  );
  enumValue(format.type, ["json_schema"], PROVIDER, `${field}.type`);
  const schema = strictRecord(
    format.json_schema,
    ["name", "description", "schema", "strict"],
    PROVIDER,
    `${field}.json_schema`,
  );
  const name = boundedString(
    schema.name,
    PROVIDER,
    `${field}.json_schema.name`,
    128,
  );
  const description = schema.description === undefined
    ? undefined
    : boundedString(
      schema.description,
      PROVIDER,
      `${field}.json_schema.description`,
      2_048,
      true,
    );
  const definition = boundedJsonObject(
    schema.schema,
    PROVIDER,
    `${field}.json_schema.schema`,
  );
  const strict = schema.strict === undefined ? undefined : booleanValue(
    schema.strict,
    PROVIDER,
    `${field}.json_schema.strict`,
  );
  return {
    type: "json_schema",
    json_schema: {
      name,
      schema: definition,
      ...(description === undefined ? {} : { description }),
      ...(strict === undefined ? {} : { strict }),
    },
  };
}

function pageSelection(value: unknown): string | readonly number[] {
  if (Array.isArray(value)) {
    if (value.length < 1 || value.length > MAX_PAGES) {
      throw invalidInput(PROVIDER, "pages");
    }
    return value.map((page) =>
      safeInteger(page, PROVIDER, "pages", 0, MAX_PAGE_NUMBER)
    );
  }
  const pages = boundedString(value, PROVIDER, "pages", 4_096);
  if (!/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(pages)) {
    throw invalidInput(PROVIDER, "pages");
  }
  let selected = 0;
  for (const part of pages.split(",")) {
    const [startText, endText] = part.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (
      !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end < start || end > MAX_PAGE_NUMBER
    ) {
      throw invalidInput(PROVIDER, "pages");
    }
    selected += end - start + 1;
    if (selected > MAX_PAGES) throw invalidInput(PROVIDER, "pages");
  }
  return pages;
}

function prepareRequest(
  value: AzureMistralOcrRequest,
  config: ResolvedClientOptions,
  callOptions: ProviderCallOptions | undefined,
): PreparedOcrRequest {
  return withInputValidation(PROVIDER, () => {
    const request = strictRecord(
      value,
      [
        "document",
        "pages",
        "include_image_base64",
        "image_limit",
        "image_min_size",
        "bbox_annotation_format",
        "document_annotation_format",
        "document_annotation_prompt",
        "table_format",
        "extract_header",
        "extract_footer",
        "confidence_scores_granularity",
      ],
      PROVIDER,
    );
    const document = validateDataUrl(
      request.document,
      DOCUMENT_MEDIA_TYPES,
      config.maxBase64Bytes,
      PROVIDER,
      "document",
    );
    const pages = request.pages === undefined
      ? undefined
      : pageSelection(request.pages);
    const includeImageBase64 = request.include_image_base64 === undefined
      ? undefined
      : booleanValue(
        request.include_image_base64,
        PROVIDER,
        "include_image_base64",
      );
    const imageLimit = request.image_limit === undefined
      ? undefined
      : safeInteger(request.image_limit, PROVIDER, "image_limit", 0, 10_000);
    const imageMinSize = request.image_min_size === undefined
      ? undefined
      : safeInteger(
        request.image_min_size,
        PROVIDER,
        "image_min_size",
        0,
        100_000,
      );
    const bboxFormat = request.bbox_annotation_format === undefined
      ? undefined
      : annotationFormat(
        request.bbox_annotation_format,
        "bbox_annotation_format",
      );
    const documentFormat = request.document_annotation_format === undefined
      ? undefined
      : annotationFormat(
        request.document_annotation_format,
        "document_annotation_format",
      );
    const documentPrompt = request.document_annotation_prompt === undefined
      ? undefined
      : boundedString(
        request.document_annotation_prompt,
        PROVIDER,
        "document_annotation_prompt",
        32_000,
      );
    if (documentPrompt !== undefined && documentFormat === undefined) {
      throw invalidInput(PROVIDER, "document_annotation_prompt");
    }
    const tableFormat = request.table_format === undefined
      ? undefined
      : enumValue(
        request.table_format,
        ["markdown", "html"],
        PROVIDER,
        "table_format",
      );
    const extractHeader = request.extract_header === undefined
      ? undefined
      : booleanValue(request.extract_header, PROVIDER, "extract_header");
    const extractFooter = request.extract_footer === undefined
      ? undefined
      : booleanValue(request.extract_footer, PROVIDER, "extract_footer");
    const confidenceGranularity =
      request.confidence_scores_granularity === undefined
        ? undefined
        : enumValue(
          request.confidence_scores_granularity,
          ["word", "page"],
          PROVIDER,
          "confidence_scores_granularity",
        );

    const documentType = document.mediaType.startsWith("image/")
      ? "image_url"
      : "document_url";
    const body: Record<string, unknown> = {
      model: AZURE_MISTRAL_OCR_MODEL,
      document: documentType === "image_url"
        ? { type: documentType, image_url: document.value }
        : { type: documentType, document_url: document.value },
    };
    if (pages !== undefined) body.pages = pages;
    if (includeImageBase64 !== undefined) {
      body.include_image_base64 = includeImageBase64;
    }
    if (imageLimit !== undefined) body.image_limit = imageLimit;
    if (imageMinSize !== undefined) body.image_min_size = imageMinSize;
    if (bboxFormat !== undefined) body.bbox_annotation_format = bboxFormat;
    if (documentFormat !== undefined) {
      body.document_annotation_format = documentFormat;
    }
    if (documentPrompt !== undefined) {
      body.document_annotation_prompt = documentPrompt;
    }
    if (tableFormat !== undefined) body.table_format = tableFormat;
    if (extractHeader !== undefined) body.extract_header = extractHeader;
    if (extractFooter !== undefined) body.extract_footer = extractFooter;
    if (confidenceGranularity !== undefined) {
      body.confidence_scores_granularity = confidenceGranularity;
    }
    return { body, signal: callSignal(callOptions, PROVIDER) };
  });
}

function responseRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(PROVIDER, field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidResponse(PROVIDER, field);
  }
  return value as Record<string, unknown>;
}

function responseString(
  value: unknown,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw invalidResponse(PROVIDER, field);
  }
  return value;
}

function responseInteger(
  value: unknown,
  field: string,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 ||
    value > maximum
  ) {
    throw invalidResponse(PROVIDER, field);
  }
  return value;
}

function responseFinite(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < minimum ||
    value > maximum
  ) {
    throw invalidResponse(PROVIDER, field);
  }
  return value;
}

function nullableString(
  value: unknown,
  field: string,
  maximumLength: number,
): string | null {
  if (value === null || value === undefined) return null;
  return responseString(value, field, maximumLength);
}

function nullableCoordinate(value: unknown, field: string): number | null {
  if (value === null) return null;
  return responseFinite(value, field, -1_000_000_000, 1_000_000_000);
}

function confidenceScore(value: unknown, field: string): OcrConfidenceScore {
  const score = responseRecord(value, field);
  return {
    text: responseString(score.text, `${field}.text`, 65_536),
    confidence: responseFinite(
      score.confidence,
      `${field}.confidence`,
      0,
      1,
    ),
    startIndex: responseInteger(
      score.start_index,
      `${field}.start_index`,
      MAX_PAGE_MARKDOWN_LENGTH,
    ),
  };
}

function confidenceScores(
  value: unknown,
  field: string,
): readonly OcrConfidenceScore[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PAGE_ITEMS) {
    throw invalidResponse(PROVIDER, field);
  }
  return value.map((score, index) =>
    confidenceScore(score, `${field}[${index}]`)
  );
}

function pageConfidence(
  value: unknown,
  field: string,
): OcrPageConfidenceScores | null {
  if (value === undefined || value === null) return null;
  const scores = responseRecord(value, field);
  return {
    averagePageConfidenceScore: responseFinite(
      scores.average_page_confidence_score,
      `${field}.average_page_confidence_score`,
      0,
      1,
    ),
    minimumPageConfidenceScore: responseFinite(
      scores.minimum_page_confidence_score,
      `${field}.minimum_page_confidence_score`,
      0,
      1,
    ),
    wordConfidenceScores: confidenceScores(
      scores.word_confidence_scores,
      `${field}.word_confidence_scores`,
    ),
  };
}

function pageDimensions(
  value: unknown,
  field: string,
): OcrPageDimensions | null {
  if (value === null) return null;
  const dimensions = responseRecord(value, field);
  return {
    dpi: responseInteger(dimensions.dpi, `${field}.dpi`, 100_000),
    height: responseInteger(dimensions.height, `${field}.height`, 1_000_000),
    width: responseInteger(dimensions.width, `${field}.width`, 1_000_000),
  };
}

function image(
  value: unknown,
  field: string,
  maxBase64Bytes: number,
): OcrImage {
  const source = responseRecord(value, field);
  const topLeftX = nullableCoordinate(source.top_left_x, `${field}.top_left_x`);
  const topLeftY = nullableCoordinate(source.top_left_y, `${field}.top_left_y`);
  const bottomRightX = nullableCoordinate(
    source.bottom_right_x,
    `${field}.bottom_right_x`,
  );
  const bottomRightY = nullableCoordinate(
    source.bottom_right_y,
    `${field}.bottom_right_y`,
  );
  if (
    topLeftX !== null && bottomRightX !== null && topLeftX > bottomRightX ||
    topLeftY !== null && bottomRightY !== null && topLeftY > bottomRightY
  ) {
    throw invalidResponse(PROVIDER, field);
  }
  const normalizedImage = source.image_base64 === undefined ||
      source.image_base64 === null
    ? null
    : normalizeEncodedImage(source.image_base64, {
      provider: PROVIDER,
      field: `${field}.image_base64`,
      maxBase64Bytes,
      maximumPixels: MAX_IMAGE_PIXELS,
    });
  return {
    id: responseString(source.id, `${field}.id`, 1_024),
    topLeftX,
    topLeftY,
    bottomRightX,
    bottomRightY,
    image: normalizedImage,
    annotation: nullableString(
      source.image_annotation,
      `${field}.image_annotation`,
      256 * 1024,
    ),
  };
}

function table(value: unknown, field: string): OcrTable {
  const source = responseRecord(value, field);
  const format = source.format;
  if (format !== "markdown" && format !== "html") {
    throw invalidResponse(PROVIDER, `${field}.format`);
  }
  return {
    id: responseString(source.id, `${field}.id`, 1_024),
    content: responseString(
      source.content,
      `${field}.content`,
      MAX_PAGE_MARKDOWN_LENGTH,
    ),
    format,
    wordConfidenceScores: confidenceScores(
      source.word_confidence_scores,
      `${field}.word_confidence_scores`,
    ),
  };
}

function responseArray(
  value: unknown,
  field: string,
  maximumItems: number,
): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw invalidResponse(PROVIDER, field);
  }
  return value;
}

function page(
  value: unknown,
  index: number,
  maxBase64Bytes: number,
): OcrPage {
  const field = `response.pages[${index}]`;
  const source = responseRecord(value, field);
  const images = responseArray(
    source.images,
    `${field}.images`,
    MAX_PAGE_ITEMS,
  ).map((item, imageIndex) =>
    image(item, `${field}.images[${imageIndex}]`, maxBase64Bytes)
  );
  const tables = source.tables === undefined
    ? []
    : responseArray(source.tables, `${field}.tables`, MAX_PAGE_ITEMS).map(
      (item, tableIndex) => table(item, `${field}.tables[${tableIndex}]`),
    );
  return {
    index: responseInteger(source.index, `${field}.index`, MAX_PAGE_NUMBER),
    markdown: responseString(
      source.markdown,
      `${field}.markdown`,
      MAX_PAGE_MARKDOWN_LENGTH,
    ),
    images,
    tables,
    header: nullableString(source.header, `${field}.header`, 1024 * 1024),
    footer: nullableString(source.footer, `${field}.footer`, 1024 * 1024),
    dimensions: pageDimensions(source.dimensions, `${field}.dimensions`),
    confidenceScores: pageConfidence(
      source.confidence_scores,
      `${field}.confidence_scores`,
    ),
  };
}

function parseResponse(
  value: unknown,
  maxBase64Bytes: number,
): OcrResult {
  const source = responseRecord(value, "response");
  responseString(source.model, "response.model", 256);
  const pages = responseArray(source.pages, "response.pages", MAX_PAGES).map(
    (item, index) => page(item, index, maxBase64Bytes),
  );
  const usage = responseRecord(source.usage_info, "response.usage_info");
  const documentSize = usage.doc_size_bytes === undefined ||
      usage.doc_size_bytes === null
    ? null
    : responseInteger(
      usage.doc_size_bytes,
      "response.usage_info.doc_size_bytes",
    );
  return {
    pages,
    documentAnnotation: nullableString(
      source.document_annotation,
      "response.document_annotation",
      16 * 1024 * 1024,
    ),
    usageInfo: {
      pagesProcessed: responseInteger(
        usage.pages_processed,
        "response.usage_info.pages_processed",
        MAX_PAGES,
      ),
      documentSizeBytes: documentSize,
    },
  };
}

export class AzureMistralOcrClient {
  readonly #config: ResolvedClientOptions;

  constructor(options: AzureProviderClientOptions) {
    this.#config = resolveClientOptions(options, PROVIDER);
  }

  async process(
    request: AzureMistralOcrRequest,
    callOptions?: ProviderCallOptions,
  ): Promise<OcrResult> {
    const prepared = prepareRequest(request, this.#config, callOptions);
    const response = await postJson(
      this.#config,
      PROVIDER,
      AZURE_MISTRAL_OCR_ENDPOINT,
      prepared.body,
      prepared.signal,
    );
    return parseResponse(response, this.#config.maxBase64Bytes);
  }
}

export function createAzureMistralOcrClient(
  options: AzureProviderClientOptions,
): AzureMistralOcrClient {
  return new AzureMistralOcrClient(options);
}
