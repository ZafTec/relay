import { invalidInput } from "./errors.ts";
import {
  type NormalizedImageMediaType,
  normalizeEncodedImage,
} from "./image.ts";
import type { AzureProviderId } from "./types.ts";
import { validateDataUrl } from "./validation.ts";

/** Decode only bounded, inline images; never fetch an arbitrary source URL. */
export function prepareImageFile(
  value: unknown,
  provider: AzureProviderId,
  maximum: number,
  field: string,
  mediaTypes: readonly NormalizedImageMediaType[] = ["image/png", "image/jpeg"],
): { file: File; width: number; height: number } {
  const data = validateDataUrl(value, mediaTypes, maximum, provider, field);
  try {
    const image = normalizeEncodedImage(data.value, {
      provider,
      field,
      maxBase64Bytes: maximum,
      maximumPixels: 64 * 1024 * 1024,
      expectedMediaType: data.mediaType as NormalizedImageMediaType,
    });
    return {
      file: new File(
        [new Uint8Array(image.bytes)],
        `${field.replace(/[^a-z0-9]/gi, "-")}.${image.mediaType.split("/")[1]}`,
        { type: image.mediaType },
      ),
      width: image.width,
      height: image.height,
    };
  } catch {
    throw invalidInput(provider, field);
  }
}
