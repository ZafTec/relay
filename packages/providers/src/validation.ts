import { AzureProviderError, invalidInput } from "./errors.ts";
import type { AzureProviderId, JsonObject, JsonValue } from "./types.ts";

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 8_192;
const MAX_JSON_ARRAY_ITEMS = 2_048;
const MAX_JSON_OBJECT_KEYS = 512;
const MAX_JSON_KEY_LENGTH = 256;
const MAX_JSON_STRING_LENGTH = 65_536;
const MAX_JSON_BYTES = 256 * 1024;

export function withInputValidation<T>(
  provider: AzureProviderId,
  validate: () => T,
): T {
  try {
    return validate();
  } catch (error) {
    if (error instanceof AzureProviderError) throw error;
    throw invalidInput(provider, "request");
  }
}

export function strictRecord(
  value: unknown,
  allowedKeys: readonly string[],
  provider: AzureProviderId,
  field = "request",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidInput(provider, field);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidInput(provider, field);
  }
  const allowed = new Set(allowedKeys);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw invalidInput(provider, field);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw invalidInput(provider, field);
    }
  }
  return value as Record<string, unknown>;
}

export function boundedString(
  value: unknown,
  provider: AzureProviderId,
  field: string,
  maxCodePoints: number,
  allowEmpty = false,
): string {
  if (typeof value !== "string") throw invalidInput(provider, field);
  let length = 0;
  for (const _character of value) {
    length += 1;
    if (length > maxCodePoints) throw invalidInput(provider, field);
  }
  if (!allowEmpty && length === 0) throw invalidInput(provider, field);
  return value;
}

export function booleanValue(
  value: unknown,
  provider: AzureProviderId,
  field: string,
): boolean {
  if (typeof value !== "boolean") throw invalidInput(provider, field);
  return value;
}

export function safeInteger(
  value: unknown,
  provider: AzureProviderId,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) ||
    value < minimum || value > maximum
  ) {
    throw invalidInput(provider, field);
  }
  return value;
}

export function finiteNumber(
  value: unknown,
  provider: AzureProviderId,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) ||
    value < minimum || value > maximum
  ) {
    throw invalidInput(provider, field);
  }
  return value;
}

export function enumValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  provider: AzureProviderId,
  field: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalidInput(provider, field);
  }
  return value as T;
}

export function inspectBase64(value: string): number | null {
  if (value.length === 0 || value.length % 4 === 1) return null;
  if (!BASE64_PATTERN.test(value)) return null;

  const firstPadding = value.indexOf("=");
  let padding = 0;
  if (firstPadding >= 0) {
    if (value.length % 4 !== 0) return null;
    padding = value.length - firstPadding;
    if (padding > 2) return null;
  }
  return Math.floor(value.length * 3 / 4) - padding;
}

export interface ValidatedDataUrl {
  readonly value: string;
  readonly mediaType: string;
  readonly base64: string;
  readonly decodedBytes: number;
}

export function validateDataUrl(
  value: unknown,
  allowedMediaTypes: readonly string[],
  maxDecodedBytes: number,
  provider: AzureProviderId,
  field: string,
): ValidatedDataUrl {
  if (typeof value !== "string") throw invalidInput(provider, field);
  const maxEncodedLength = Math.ceil(maxDecodedBytes / 3) * 4 + 256;
  if (value.length > maxEncodedLength || !value.startsWith("data:")) {
    throw invalidInput(provider, field);
  }

  const comma = value.indexOf(",");
  if (comma < 6 || comma > 255) throw invalidInput(provider, field);
  const metadata = value.slice(5, comma).split(";");
  if (metadata.length !== 2 || metadata[1].toLowerCase() !== "base64") {
    throw invalidInput(provider, field);
  }
  const mediaType = metadata[0].toLowerCase();
  if (
    !MEDIA_TYPE_PATTERN.test(mediaType) ||
    !allowedMediaTypes.includes(mediaType)
  ) {
    throw invalidInput(provider, field);
  }

  const base64 = value.slice(comma + 1);
  const decodedBytes = inspectBase64(base64);
  if (decodedBytes === null || decodedBytes > maxDecodedBytes) {
    throw invalidInput(provider, field);
  }
  return { value, mediaType, base64, decodedBytes };
}

interface JsonTraversalState {
  nodes: number;
  readonly seen: WeakSet<object>;
}

function cloneJsonValue(
  value: unknown,
  provider: AzureProviderId,
  field: string,
  depth: number,
  state: JsonTraversalState,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw invalidInput(provider, field);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidInput(provider, field);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > MAX_JSON_STRING_LENGTH) {
      throw invalidInput(provider, field);
    }
    return value;
  }
  if (typeof value !== "object") throw invalidInput(provider, field);
  if (state.seen.has(value)) throw invalidInput(provider, field);
  state.seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > MAX_JSON_ARRAY_ITEMS) {
        throw invalidInput(provider, field);
      }
      return value.map((item) =>
        cloneJsonValue(item, provider, field, depth + 1, state)
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidInput(provider, field);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_JSON_OBJECT_KEYS) {
      throw invalidInput(provider, field);
    }
    const output: Record<string, JsonValue> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== "string" || key.length > MAX_JSON_KEY_LENGTH) {
        throw invalidInput(provider, field);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw invalidInput(provider, field);
      }
      output[key] = cloneJsonValue(
        descriptor.value,
        provider,
        field,
        depth + 1,
        state,
      );
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

export function boundedJsonObject(
  value: unknown,
  provider: AzureProviderId,
  field: string,
): JsonObject {
  const cloned = cloneJsonValue(
    value,
    provider,
    field,
    0,
    { nodes: 0, seen: new WeakSet() },
  );
  if (typeof cloned !== "object" || cloned === null || Array.isArray(cloned)) {
    throw invalidInput(provider, field);
  }
  const serialized = JSON.stringify(cloned);
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
    throw invalidInput(provider, field);
  }
  return cloned as JsonObject;
}

export function callSignal(
  options: unknown,
  provider: AzureProviderId,
): AbortSignal | undefined {
  if (options === undefined) return undefined;
  const record = strictRecord(options, ["signal"], provider, "callOptions");
  if (record.signal === undefined) return undefined;
  if (!(record.signal instanceof AbortSignal)) {
    throw invalidInput(provider, "callOptions.signal");
  }
  return record.signal;
}
