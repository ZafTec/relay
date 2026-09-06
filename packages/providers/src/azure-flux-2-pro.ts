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
  booleanValue,
  boundedString,
  callSignal,
  enumValue,
  safeInteger,
  strictRecord,
  validateDataUrl,
  withInputValidation,
} from "./validation.ts";
import { invalidInput } from "./errors.ts";

const PROVIDER = "azure-flux-2-pro" as const;
const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
const INPUT_IMAGE_FIELDS = [
  "input_image",
  "input_image_2",
  "input_image_3",
  "input_image_4",
  "input_image_5",
  "input_image_6",
  "input_image_7",
  "input_image_8",
] as const;

export const AZURE_FLUX_2_PRO_MODEL = "FLUX.2-pro" as const;
export const AZURE_FLUX_2_PRO_ENDPOINT =
  `${AZURE_AI_BASE_URL}/providers/blackforestlabs/v1/flux-2-pro?api-version=preview` as const;
export const AZURE_FLUX_2_PRO_MAX_INPUT_IMAGES = 8;
export const AZURE_FLUX_2_PRO_MAX_PIXELS = 4 * 1024 * 1024;
export const AZURE_FLUX_2_PRO_MIN_EDGE = 64;

export type AzureFlux2ProOutputFormat = "jpeg" | "png" | "webp";

export interface AzureFlux2ProRequest {
  readonly prompt: string;
  readonly disable_pup?: boolean;
  readonly input_images?: readonly string[];
  readonly seed?: number;
  readonly width?: number;
  readonly height?: number;
  readonly safety_tolerance?: number;
  readonly output_format?: AzureFlux2ProOutputFormat;
}

interface PreparedFluxRequest {
  readonly body: Record<string, unknown>;
  readonly expectedFormat: AzureFlux2ProOutputFormat;
  readonly signal?: AbortSignal;
}

function optionalDimension(
  value: unknown,
  field: "width" | "height",
): number | undefined {
  if (value === undefined) return undefined;
  return safeInteger(
    value,
    PROVIDER,
    field,
    AZURE_FLUX_2_PRO_MIN_EDGE,
    Math.floor(AZURE_FLUX_2_PRO_MAX_PIXELS / AZURE_FLUX_2_PRO_MIN_EDGE),
  );
}

function prepareRequest(
  value: AzureFlux2ProRequest,
  config: ResolvedClientOptions,
  callOptions: ProviderCallOptions | undefined,
): PreparedFluxRequest {
  return withInputValidation(PROVIDER, () => {
    const request = strictRecord(
      value,
      [
        "prompt",
        "disable_pup",
        "input_images",
        "seed",
        "width",
        "height",
        "safety_tolerance",
        "output_format",
      ],
      PROVIDER,
    );
    const prompt = boundedString(request.prompt, PROVIDER, "prompt", 32_000);
    const disablePup = request.disable_pup === undefined
      ? undefined
      : booleanValue(request.disable_pup, PROVIDER, "disable_pup");
    let inputImages: readonly string[] | undefined;
    if (request.input_images !== undefined) {
      if (
        !Array.isArray(request.input_images) ||
        request.input_images.length < 1 ||
        request.input_images.length > AZURE_FLUX_2_PRO_MAX_INPUT_IMAGES
      ) {
        throw invalidInput(PROVIDER, "input_images");
      }
      inputImages = request.input_images.map((image, index) =>
        validateDataUrl(
          image,
          IMAGE_MEDIA_TYPES,
          config.maxBase64Bytes,
          PROVIDER,
          `input_images[${index}]`,
        ).value
      );
    }
    const seed = request.seed === undefined ? undefined : safeInteger(
      request.seed,
      PROVIDER,
      "seed",
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    const width = optionalDimension(request.width, "width");
    const height = optionalDimension(request.height, "height");
    if (
      width !== undefined && height !== undefined &&
      width * height > AZURE_FLUX_2_PRO_MAX_PIXELS
    ) {
      throw invalidInput(PROVIDER, "width/height");
    }
    const safetyTolerance = request.safety_tolerance === undefined
      ? undefined
      : safeInteger(
        request.safety_tolerance,
        PROVIDER,
        "safety_tolerance",
        0,
        5,
      );
    const outputFormat = request.output_format === undefined
      ? undefined
      : enumValue(
        request.output_format,
        ["jpeg", "png", "webp"],
        PROVIDER,
        "output_format",
      );

    const body: Record<string, unknown> = {
      model: AZURE_FLUX_2_PRO_MODEL,
      n: 1,
      prompt,
    };
    if (disablePup !== undefined) body.disable_pup = disablePup;
    inputImages?.forEach((image, index) => {
      body[INPUT_IMAGE_FIELDS[index]] = image;
    });
    if (seed !== undefined) body.seed = seed;
    if (width !== undefined) body.width = width;
    if (height !== undefined) body.height = height;
    if (safetyTolerance !== undefined) {
      body.safety_tolerance = safetyTolerance;
    }
    if (outputFormat !== undefined) body.output_format = outputFormat;

    return {
      body,
      expectedFormat: outputFormat ?? "jpeg",
      signal: callSignal(callOptions, PROVIDER),
    };
  });
}

export class AzureFlux2ProClient {
  readonly #config: ResolvedClientOptions;

  constructor(options: AzureProviderClientOptions) {
    this.#config = resolveClientOptions(options, PROVIDER);
  }

  async generate(
    request: AzureFlux2ProRequest,
    callOptions?: ProviderCallOptions,
  ): Promise<ImageGenerationResult> {
    const prepared = prepareRequest(request, this.#config, callOptions);
    const response = await postJson(
      this.#config,
      PROVIDER,
      AZURE_FLUX_2_PRO_ENDPOINT,
      prepared.body,
      prepared.signal,
    );
    return parseImageGenerationResponse(response, {
      provider: PROVIDER,
      maxBase64Bytes: this.#config.maxBase64Bytes,
      maxImages: 1,
      maximumPixels: AZURE_FLUX_2_PRO_MAX_PIXELS,
      expectedFormat: prepared.expectedFormat,
    });
  }
}

export function createAzureFlux2ProClient(
  options: AzureProviderClientOptions,
): AzureFlux2ProClient {
  return new AzureFlux2ProClient(options);
}
