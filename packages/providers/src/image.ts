import { invalidResponse, responseTooLarge } from "./errors.ts";
import type { AzureProviderId } from "./types.ts";
import { inspectBase64 } from "./validation.ts";

export type NormalizedImageMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export interface NormalizedImage {
  readonly bytes: Uint8Array;
  readonly mediaType: NormalizedImageMediaType;
  readonly width: number;
  readonly height: number;
}

export interface GeneratedImage extends NormalizedImage {
  readonly revisedPrompt?: string;
}

export interface ImageTokenDetails {
  readonly imageTokens: number;
  readonly textTokens: number;
}

export interface ImageGenerationUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly inputTokenDetails: ImageTokenDetails;
  readonly outputTokenDetails?: ImageTokenDetails;
}

export interface ImageGenerationResult {
  readonly images: readonly GeneratedImage[];
  readonly created?: number;
  readonly usage?: ImageGenerationUsage;
}

interface ParseImageResponseOptions {
  readonly provider: AzureProviderId;
  readonly maxBase64Bytes: number;
  readonly maxImages: number;
  readonly maximumPixels: number;
  readonly expectedFormat: "jpeg" | "png" | "webp";
}

function record(
  value: unknown,
  provider: AzureProviderId,
  field: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidResponse(provider, field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidResponse(provider, field);
  }
  return value as Record<string, unknown>;
}

function responseString(
  value: unknown,
  provider: AzureProviderId,
  field: string,
  maximumLength: number,
): string {
  if (typeof value !== "string" || value.length > maximumLength) {
    throw invalidResponse(provider, field);
  }
  return value;
}

function responseInteger(
  value: unknown,
  provider: AzureProviderId,
  field: string,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 0
  ) {
    throw invalidResponse(provider, field);
  }
  return value;
}

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000 +
    bytes[offset + 1] * 0x10000 +
    bytes[offset + 2] * 0x100 +
    bytes[offset + 3]
  );
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] + bytes[offset + 1] * 0x100 +
    bytes[offset + 2] * 0x10000 + bytes[offset + 3] * 0x1000000
  );
}

function ascii(bytes: Uint8Array, offset: number, value: string): boolean {
  if (offset + value.length > bytes.byteLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (bytes[offset + index] !== value.charCodeAt(index)) return false;
  }
  return true;
}

function pngDimensions(bytes: Uint8Array): [number, number] | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < 24) return null;
  if (!signature.every((byte, index) => bytes[index] === byte)) return null;
  if (!ascii(bytes, 12, "IHDR")) return null;
  return [readUint32Be(bytes, 16), readUint32Be(bytes, 20)];
}

const JPEG_SOF_MARKERS = new Set([
  0xc0,
  0xc1,
  0xc2,
  0xc3,
  0xc5,
  0xc6,
  0xc7,
  0xc9,
  0xca,
  0xcb,
  0xcd,
  0xce,
  0xcf,
]);

function jpegDimensions(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  ) {
    return null;
  }
  let offset = 2;
  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return null;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 2 > bytes.byteLength) return null;
    const length = bytes[offset] * 0x100 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.byteLength) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (length < 7) return null;
      const height = bytes[offset + 3] * 0x100 + bytes[offset + 4];
      const width = bytes[offset + 5] * 0x100 + bytes[offset + 6];
      return [width, height];
    }
    offset += length;
  }
  return null;
}

function webpDimensions(bytes: Uint8Array): [number, number] | null {
  if (
    bytes.byteLength < 30 || !ascii(bytes, 0, "RIFF") ||
    !ascii(bytes, 8, "WEBP")
  ) {
    return null;
  }
  const declaredLength = readUint32Le(bytes, 4) + 8;
  if (declaredLength > bytes.byteLength) return null;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const size = readUint32Le(bytes, offset + 4);
    const payload = offset + 8;
    if (payload + size > bytes.byteLength) return null;
    if (ascii(bytes, offset, "VP8X") && size >= 10) {
      return [
        readUint24Le(bytes, payload + 4) + 1,
        readUint24Le(bytes, payload + 7) + 1,
      ];
    }
    if (
      ascii(bytes, offset, "VP8 ") && size >= 10 &&
      bytes[payload + 3] === 0x9d && bytes[payload + 4] === 0x01 &&
      bytes[payload + 5] === 0x2a
    ) {
      const width = (bytes[payload + 6] + bytes[payload + 7] * 0x100) &
        0x3fff;
      const height = (bytes[payload + 8] + bytes[payload + 9] * 0x100) &
        0x3fff;
      return [width, height];
    }
    if (ascii(bytes, offset, "VP8L") && size >= 5 && bytes[payload] === 0x2f) {
      const width = 1 + bytes[payload + 1] +
        ((bytes[payload + 2] & 0x3f) << 8);
      const height = 1 + (bytes[payload + 2] >> 6) +
        (bytes[payload + 3] << 2) + ((bytes[payload + 4] & 0x0f) << 10);
      return [width, height];
    }
    offset = payload + size + (size % 2);
  }
  return null;
}

function decodeBase64(
  value: string,
  maximumBytes: number,
  provider: AzureProviderId,
  field: string,
): Uint8Array {
  const decodedLength = inspectBase64(value);
  if (decodedLength === null) throw invalidResponse(provider, field);
  if (decodedLength > maximumBytes) throw responseTooLarge(provider, field);

  const padding = value.length % 4 === 0
    ? ""
    : "=".repeat(4 - value.length % 4);
  let binary: string;
  try {
    binary = atob(value + padding);
  } catch {
    throw invalidResponse(provider, field);
  }
  if (binary.length !== decodedLength) throw invalidResponse(provider, field);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function splitImageDataUrl(
  value: string,
  provider: AzureProviderId,
  field: string,
): { base64: string; mediaType?: NormalizedImageMediaType } {
  if (!value.startsWith("data:")) return { base64: value };
  const comma = value.indexOf(",");
  if (comma < 0) throw invalidResponse(provider, field);
  const metadata = value.slice(5, comma).toLowerCase();
  const supported = ["image/jpeg", "image/png", "image/webp"] as const;
  for (const mediaType of supported) {
    if (metadata === `${mediaType};base64`) {
      return { base64: value.slice(comma + 1), mediaType };
    }
  }
  throw invalidResponse(provider, field);
}

function inspectImage(
  bytes: Uint8Array,
  provider: AzureProviderId,
  field: string,
): { mediaType: NormalizedImageMediaType; width: number; height: number } {
  const png = pngDimensions(bytes);
  if (png !== null) {
    return { mediaType: "image/png", width: png[0], height: png[1] };
  }
  const jpeg = jpegDimensions(bytes);
  if (jpeg !== null) {
    return { mediaType: "image/jpeg", width: jpeg[0], height: jpeg[1] };
  }
  const webp = webpDimensions(bytes);
  if (webp !== null) {
    return { mediaType: "image/webp", width: webp[0], height: webp[1] };
  }
  throw invalidResponse(provider, field);
}

export function normalizeEncodedImage(
  value: unknown,
  options: {
    readonly provider: AzureProviderId;
    readonly field: string;
    readonly maxBase64Bytes: number;
    readonly maximumPixels: number;
    readonly expectedMediaType?: NormalizedImageMediaType;
  },
): NormalizedImage {
  const encoded = responseString(
    value,
    options.provider,
    options.field,
    Math.ceil(options.maxBase64Bytes / 3) * 4 + 256,
  );
  const split = splitImageDataUrl(encoded, options.provider, options.field);
  const bytes = decodeBase64(
    split.base64,
    options.maxBase64Bytes,
    options.provider,
    options.field,
  );
  const inspected = inspectImage(bytes, options.provider, options.field);
  if (
    split.mediaType !== undefined && split.mediaType !== inspected.mediaType ||
    options.expectedMediaType !== undefined &&
      options.expectedMediaType !== inspected.mediaType
  ) {
    throw invalidResponse(options.provider, options.field);
  }
  if (
    inspected.width < 1 || inspected.height < 1 ||
    inspected.width > 16_384 || inspected.height > 16_384 ||
    inspected.width * inspected.height > options.maximumPixels
  ) {
    throw invalidResponse(options.provider, options.field);
  }
  return { bytes, ...inspected };
}

function tokenDetails(
  value: unknown,
  provider: AzureProviderId,
  field: string,
): ImageTokenDetails {
  const details = record(value, provider, field);
  return {
    imageTokens: responseInteger(
      details.image_tokens,
      provider,
      `${field}.image_tokens`,
    ),
    textTokens: responseInteger(
      details.text_tokens,
      provider,
      `${field}.text_tokens`,
    ),
  };
}

function usage(
  value: unknown,
  provider: AzureProviderId,
): ImageGenerationUsage {
  const source = record(value, provider, "response.usage");
  const normalized: ImageGenerationUsage = {
    inputTokens: responseInteger(
      source.input_tokens,
      provider,
      "response.usage.input_tokens",
    ),
    outputTokens: responseInteger(
      source.output_tokens,
      provider,
      "response.usage.output_tokens",
    ),
    totalTokens: responseInteger(
      source.total_tokens,
      provider,
      "response.usage.total_tokens",
    ),
    inputTokenDetails: tokenDetails(
      source.input_tokens_details,
      provider,
      "response.usage.input_tokens_details",
    ),
  };
  if (source.output_tokens_details !== undefined) {
    return {
      ...normalized,
      outputTokenDetails: tokenDetails(
        source.output_tokens_details,
        provider,
        "response.usage.output_tokens_details",
      ),
    };
  }
  return normalized;
}

export function parseImageGenerationResponse(
  value: unknown,
  options: ParseImageResponseOptions,
): ImageGenerationResult {
  const source = record(value, options.provider, "response");
  if (
    !Array.isArray(source.data) || source.data.length < 1 ||
    source.data.length > options.maxImages
  ) {
    throw invalidResponse(options.provider, "response.data");
  }
  const expectedMediaType =
    `image/${options.expectedFormat}` as NormalizedImageMediaType;
  const images = source.data.map((item, index): GeneratedImage => {
    const image = record(item, options.provider, `response.data[${index}]`);
    const normalized = normalizeEncodedImage(image.b64_json, {
      provider: options.provider,
      field: `response.data[${index}].b64_json`,
      maxBase64Bytes: options.maxBase64Bytes,
      maximumPixels: options.maximumPixels,
      expectedMediaType,
    });
    if (image.revised_prompt === undefined) return normalized;
    return {
      ...normalized,
      revisedPrompt: responseString(
        image.revised_prompt,
        options.provider,
        `response.data[${index}].revised_prompt`,
        32_000,
      ),
    };
  });

  const result: ImageGenerationResult = { images };
  const created = source.created === undefined
    ? undefined
    : responseInteger(source.created, options.provider, "response.created");
  const normalizedUsage = source.usage === undefined
    ? undefined
    : usage(source.usage, options.provider);
  return {
    ...result,
    ...(created === undefined ? {} : { created }),
    ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
  };
}
