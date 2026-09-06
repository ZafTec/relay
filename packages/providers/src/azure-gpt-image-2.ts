import { invalidInput } from "./errors.ts";
import {
  type ImageGenerationResult,
  parseImageGenerationResponse,
} from "./image.ts";
import {
  postJson,
  resolveClientOptions,
  type ResolvedClientOptions,
} from "./http.ts";
import {
  AZURE_AI_BASE_URL,
  type AzureProviderClientOptions,
  type ProviderCallOptions,
} from "./types.ts";
import {
  boundedString,
  callSignal,
  enumValue,
  safeInteger,
  strictRecord,
  withInputValidation,
} from "./validation.ts";

const PROVIDER = "azure-gpt-image-2" as const;

export const AZURE_GPT_IMAGE_2_MODEL = "gpt-image-2" as const;
export const AZURE_GPT_IMAGE_2_ENDPOINT =
  `${AZURE_AI_BASE_URL}/openai/v1/images/generations` as const;
export const AZURE_GPT_IMAGE_2_MAX_PROMPT_CODE_POINTS = 32_000;
export const AZURE_GPT_IMAGE_2_MIN_PIXELS = 655_360;
export const AZURE_GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
export const AZURE_GPT_IMAGE_2_MAX_EDGE = 3_840;

export type AzureGptImage2Quality = "low" | "medium" | "high";
export type AzureGptImage2OutputFormat = "png" | "jpeg";
export type AzureGptImage2Background = "auto" | "transparent" | "opaque";
export type AzureGptImage2Moderation = "auto" | "low";
export type AzureGptImage2Size = "auto" | `${number}x${number}`;

export interface AzureGptImage2Request {
  readonly prompt: string;
  readonly n?: number;
  readonly size?: AzureGptImage2Size;
  readonly quality?: AzureGptImage2Quality;
  readonly output_format?: AzureGptImage2OutputFormat;
  readonly output_compression?: number;
  readonly background?: AzureGptImage2Background;
  readonly moderation?: AzureGptImage2Moderation;
}

interface PreparedGptRequest {
  readonly body: Record<string, unknown>;
  readonly expectedFormat: AzureGptImage2OutputFormat;
  readonly maximumImages: number;
  readonly signal?: AbortSignal;
}

function imageSize(value: unknown): AzureGptImage2Size {
  if (value === "auto") return value;
  if (typeof value !== "string") throw invalidInput(PROVIDER, "size");
  const match = /^([1-9]\d*)x([1-9]\d*)$/.exec(value);
  if (match === null) throw invalidInput(PROVIDER, "size");
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width % 16 !== 0 || height % 16 !== 0 ||
    width > AZURE_GPT_IMAGE_2_MAX_EDGE ||
    height > AZURE_GPT_IMAGE_2_MAX_EDGE ||
    Math.max(width, height) / Math.min(width, height) > 3 ||
    pixels < AZURE_GPT_IMAGE_2_MIN_PIXELS ||
    pixels > AZURE_GPT_IMAGE_2_MAX_PIXELS
  ) {
    throw invalidInput(PROVIDER, "size");
  }
  return value as AzureGptImage2Size;
}

function prepareRequest(
  value: AzureGptImage2Request,
  callOptions: ProviderCallOptions | undefined,
): PreparedGptRequest {
  return withInputValidation(PROVIDER, () => {
    const request = strictRecord(
      value,
      [
        "prompt",
        "n",
        "size",
        "quality",
        "output_format",
        "output_compression",
        "background",
        "moderation",
      ],
      PROVIDER,
    );
    const prompt = boundedString(
      request.prompt,
      PROVIDER,
      "prompt",
      AZURE_GPT_IMAGE_2_MAX_PROMPT_CODE_POINTS,
    );
    const n = request.n === undefined
      ? undefined
      : safeInteger(request.n, PROVIDER, "n", 1, 10);
    const size = request.size === undefined
      ? undefined
      : imageSize(request.size);
    const quality = request.quality === undefined ? undefined : enumValue(
      request.quality,
      ["low", "medium", "high"],
      PROVIDER,
      "quality",
    );
    const outputFormat = request.output_format === undefined
      ? undefined
      : enumValue(
        request.output_format,
        ["png", "jpeg"],
        PROVIDER,
        "output_format",
      );
    const outputCompression = request.output_compression === undefined
      ? undefined
      : safeInteger(
        request.output_compression,
        PROVIDER,
        "output_compression",
        0,
        100,
      );
    const background = request.background === undefined ? undefined : enumValue(
      request.background,
      ["auto", "transparent", "opaque"],
      PROVIDER,
      "background",
    );
    const moderation = request.moderation === undefined ? undefined : enumValue(
      request.moderation,
      ["auto", "low"],
      PROVIDER,
      "moderation",
    );
    const effectiveFormat = outputFormat ?? "png";
    if (outputCompression !== undefined && effectiveFormat !== "jpeg") {
      throw invalidInput(PROVIDER, "output_compression");
    }
    if (background === "transparent" && effectiveFormat !== "png") {
      throw invalidInput(PROVIDER, "background");
    }

    const body: Record<string, unknown> = {
      model: AZURE_GPT_IMAGE_2_MODEL,
      prompt,
    };
    if (n !== undefined) body.n = n;
    if (size !== undefined) body.size = size;
    if (quality !== undefined) body.quality = quality;
    if (outputFormat !== undefined) body.output_format = outputFormat;
    if (outputCompression !== undefined) {
      body.output_compression = outputCompression;
    }
    if (background !== undefined) body.background = background;
    if (moderation !== undefined) body.moderation = moderation;

    return {
      body,
      expectedFormat: effectiveFormat,
      maximumImages: n ?? 1,
      signal: callSignal(callOptions, PROVIDER),
    };
  });
}

export class AzureGptImage2Client {
  readonly #config: ResolvedClientOptions;

  constructor(options: AzureProviderClientOptions) {
    this.#config = resolveClientOptions(options, PROVIDER);
  }

  async generate(
    request: AzureGptImage2Request,
    callOptions?: ProviderCallOptions,
  ): Promise<ImageGenerationResult> {
    const prepared = prepareRequest(request, callOptions);
    const response = await postJson(
      this.#config,
      PROVIDER,
      AZURE_GPT_IMAGE_2_ENDPOINT,
      prepared.body,
      prepared.signal,
    );
    return parseImageGenerationResponse(response, {
      provider: PROVIDER,
      maxBase64Bytes: this.#config.maxBase64Bytes,
      maxImages: prepared.maximumImages,
      maximumPixels: AZURE_GPT_IMAGE_2_MAX_PIXELS,
      expectedFormat: prepared.expectedFormat,
    });
  }
}

export function createAzureGptImage2Client(
  options: AzureProviderClientOptions,
): AzureGptImage2Client {
  return new AzureGptImage2Client(options);
}
