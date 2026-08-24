const RAW_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\//i;
const MEDIA_KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const ERROR_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const MIME_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/;
const MAX_JSON_BYTES = 64 * 1024;
const MAX_JSON_DEPTH = 12;
const MAX_JSON_NODES = 2_048;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

export class ArtifactInputError extends TypeError {
  override readonly name = "ArtifactInputError";
  readonly field: string;

  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.field = field;
  }
}

export function validateDisplayName(name: string, field = "name"): string {
  const value = name.trim();
  if (
    value.length === 0 || value.length > 255 || hasControlCharacter(value) ||
    RAW_URL_PATTERN.test(value)
  ) {
    throw new ArtifactInputError(field, "must be a safe non-URL name");
  }
  return value;
}

export function validateMediaKind(mediaKind: string): string {
  const value = mediaKind.trim().toLowerCase();
  if (!MEDIA_KIND_PATTERN.test(value)) {
    throw new ArtifactInputError("mediaKind", "has an invalid format");
  }
  return value;
}

export function validateMimeType(mimeType: string): string {
  const value = mimeType.trim().toLowerCase();
  if (
    value.length === 0 || value.length > 255 || hasControlCharacter(value) ||
    RAW_URL_PATTERN.test(value) || !MIME_TYPE_PATTERN.test(value)
  ) {
    throw new ArtifactInputError("mimeType", "has an invalid format");
  }
  return value;
}

export function validateErrorCode(errorCode: string): string {
  const value = errorCode.trim().toLowerCase();
  if (!ERROR_CODE_PATTERN.test(value)) {
    throw new ArtifactInputError("errorCode", "has an invalid format");
  }
  return value;
}

export function validateByteCount(bytes: number, field = "sizeBytes"): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new ArtifactInputError(field, "must be a non-negative safe integer");
  }
  return bytes;
}

export function validatePositiveInteger(
  value: number | null | undefined,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArtifactInputError(field, "must be a positive safe integer");
  }
  return value;
}

interface TraversalState {
  nodes: number;
  readonly seen: WeakSet<object>;
}

function inspectDurableValue(
  value: unknown,
  field: string,
  depth: number,
  state: TraversalState,
): void {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) {
    throw new ArtifactInputError(field, "is too complex");
  }
  if (typeof value === "string") {
    if (RAW_URL_PATTERN.test(value)) {
      throw new ArtifactInputError(field, "must not contain a raw URL");
    }
    return;
  }
  if (
    value === null || typeof value === "boolean" || typeof value === "number"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new ArtifactInputError(field, "must contain finite numbers");
    }
    return;
  }
  if (typeof value !== "object") {
    throw new ArtifactInputError(field, "must be JSON-compatible");
  }
  if (state.seen.has(value)) {
    throw new ArtifactInputError(field, "must not contain cycles");
  }

  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ArtifactInputError(field, "must contain only JSON objects");
    }
  }

  state.seen.add(value);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (RAW_URL_PATTERN.test(key)) {
      throw new ArtifactInputError(field, "must not contain a raw URL");
    }
    if (
      key.length === 0 || key.length > 256 || hasControlCharacter(key)
    ) {
      throw new ArtifactInputError(field, "contains an invalid key");
    }
    inspectDurableValue(item, field, depth + 1, state);
  }
  state.seen.delete(value);
}

export function serializeDurableObject(
  value: unknown,
  field = "metadata",
): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ArtifactInputError(field, "must be an object");
  }
  inspectDurableValue(value, field, 0, { nodes: 0, seen: new WeakSet() });
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ArtifactInputError(field, "must be JSON-compatible");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
    throw new ArtifactInputError(field, "is too large");
  }
  return serialized;
}

export function serializeDurableArray(
  value: readonly unknown[],
  field = "warnings",
): string {
  inspectDurableValue(value, field, 0, { nodes: 0, seen: new WeakSet() });
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new ArtifactInputError(field, "must be JSON-compatible");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
    throw new ArtifactInputError(field, "is too large");
  }
  return serialized;
}

export function validateNonNegativeInteger(
  value: number,
  field: string,
): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ArtifactInputError(field, "must be a non-negative safe integer");
  }
  return value;
}

export function hasRawUrl(value: unknown): boolean {
  try {
    inspectDurableValue(value, "value", 0, { nodes: 0, seen: new WeakSet() });
    return false;
  } catch (error) {
    return error instanceof ArtifactInputError &&
      error.message.includes("raw URL");
  }
}
