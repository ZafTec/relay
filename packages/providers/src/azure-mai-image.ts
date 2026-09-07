import { invalidInput, invalidResponse } from "./errors.ts";
import { prepareImageFile } from "./image-input.ts";
import {
  postFormData,
  postJson,
  resolveClientOptions,
  type ResolvedClientOptions,
} from "./http.ts";
import {
  type ImageGenerationResult,
  parseImageGenerationResponse,
} from "./image.ts";
import type {
  AzureProviderClientOptions,
  ProviderCallOptions,
} from "./types.ts";
import {
  boundedString,
  callSignal,
  safeInteger,
  strictRecord,
  withInputValidation,
} from "./validation.ts";

export type AzureMaiImageModel = "MAI-Image-2.5" | "MAI-Image-2.5-Flash";
export interface AzureMaiImageRequest {
  readonly prompt: string;
  readonly width?: number;
  readonly height?: number;
}
export interface AzureMaiImageEditRequest {
  readonly prompt: string;
  readonly image: string;
}
export const AZURE_MAI_IMAGE_MAX_PIXELS = 1_048_576;

export class AzureMaiImageClient {
  readonly #config: ResolvedClientOptions;
  readonly #provider: "azure-mai-image-2.5" | "azure-mai-image-2.5-flash";
  readonly model: AzureMaiImageModel;

  constructor(options: AzureProviderClientOptions, model: AzureMaiImageModel) {
    if (model !== "MAI-Image-2.5" && model !== "MAI-Image-2.5-Flash") {
      throw new TypeError("Unsupported MAI image model");
    }
    this.model = model;
    this.#provider = model === "MAI-Image-2.5"
      ? "azure-mai-image-2.5"
      : "azure-mai-image-2.5-flash";
    this.#config = resolveClientOptions(options, this.#provider);
  }

  #result(value: unknown): ImageGenerationResult {
    // MAI reports separate text/image input counters, unlike OpenAI's usage DTO.
    // Keep absence of usage distinct from zero cost and never invent counters.
    let normalized = value;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const response = value as Record<string, unknown>;
      if (response.usage !== undefined) {
        const usage = response.usage;
        if (
          usage === null || typeof usage !== "object" || Array.isArray(usage)
        ) {
          throw invalidResponse(this.#provider, "response.usage");
        }
        const counts = usage as Record<string, unknown>;
        const text = counts.num_input_text_tokens;
        const image = counts.num_input_image_tokens;
        const output = counts.num_output_tokens;
        if (
          ![text, image, output].every((count) =>
            typeof count === "number" && Number.isSafeInteger(count) &&
            count >= 0
          )
        ) {
          throw invalidResponse(this.#provider, "response.usage");
        }
        const input = (text as number) + (image as number);
        const total = input + (output as number);
        if (!Number.isSafeInteger(total)) {
          throw invalidResponse(this.#provider, "response.usage");
        }
        normalized = {
          ...response,
          usage: {
            input_tokens: input,
            output_tokens: output,
            total_tokens: total,
            input_tokens_details: { text_tokens: text, image_tokens: image },
          },
        };
      }
    }
    return parseImageGenerationResponse(normalized, {
      provider: this.#provider,
      maxBase64Bytes: this.#config.maxBase64Bytes,
      maxImages: 1,
      maximumPixels: AZURE_MAI_IMAGE_MAX_PIXELS,
      expectedFormat: "png",
    });
  }

  async generate(
    value: AzureMaiImageRequest,
    callOptions?: ProviderCallOptions,
  ): Promise<ImageGenerationResult> {
    const prepared = withInputValidation(this.#provider, () => {
      const input = strictRecord(
        value,
        ["prompt", "width", "height"],
        this.#provider,
      );
      const prompt = boundedString(
        input.prompt,
        this.#provider,
        "prompt",
        32_000,
      );
      const width = safeInteger(
        input.width === undefined ? 1024 : input.width,
        this.#provider,
        "width",
        768,
        1365,
      );
      const height = safeInteger(
        input.height === undefined ? 1024 : input.height,
        this.#provider,
        "height",
        768,
        1365,
      );
      if (width * height > AZURE_MAI_IMAGE_MAX_PIXELS) {
        throw invalidInput(this.#provider, "width/height");
      }
      return {
        prompt,
        width,
        height,
        signal: callSignal(callOptions, this.#provider),
      };
    });
    return this.#result(
      await postJson(
        this.#config,
        this.#provider,
        `${this.#config.baseUrl}/mai/v1/images/generations`,
        {
          model: this.model,
          prompt: prepared.prompt,
          width: prepared.width,
          height: prepared.height,
        },
        prepared.signal,
        "api-key",
      ),
    );
  }

  async edit(
    value: AzureMaiImageEditRequest,
    callOptions?: ProviderCallOptions,
  ): Promise<ImageGenerationResult> {
    const prepared = withInputValidation(this.#provider, () => {
      const input = strictRecord(value, ["prompt", "image"], this.#provider);
      const prompt = boundedString(
        input.prompt,
        this.#provider,
        "prompt",
        32_000,
      );
      const { file } = prepareImageFile(
        input.image,
        this.#provider,
        this.#config.maxBase64Bytes,
        "image",
      );
      const form = new FormData();
      form.set("model", this.model);
      form.set("prompt", prompt);
      form.set("image", file);
      return { form, signal: callSignal(callOptions, this.#provider) };
    });
    return this.#result(
      await postFormData(
        this.#config,
        this.#provider,
        `${this.#config.baseUrl}/mai/v1/images/edits`,
        prepared.form,
        prepared.signal,
      ),
    );
  }
}

export function createAzureMaiImageClient(
  options: AzureProviderClientOptions,
  model: AzureMaiImageModel,
): AzureMaiImageClient {
  return new AzureMaiImageClient(options, model);
}
