import { MAX_CURSOR_LENGTH } from "@relay/contracts";

export class InvalidCursorError extends TypeError {
  override readonly name = "InvalidCursorError";
}

interface EncodedCursor {
  readonly v: 1;
  readonly scope: string;
  readonly filter: string;
  readonly position: readonly string[];
}

const SCOPE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

function base64UrlEncode(value: string): string {
  const bytes = encoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/,
    "",
  );
}

function base64UrlDecode(value: string): string {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") +
    "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return decoder.decode(
    Uint8Array.from(binary, (character) => character.codePointAt(0)!),
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length >= 1 && value.length <= 4 &&
    value.every((item) => typeof item === "string" && item.length <= 512);
}

function parseEncodedCursor(value: unknown): EncodedCursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCursorError("cursor payload must be an object");
  }
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (
    keys.length !== 4 || keys[0] !== "filter" || keys[1] !== "position" ||
    keys[2] !== "scope" || keys[3] !== "v"
  ) {
    throw new InvalidCursorError("cursor payload has unsupported fields");
  }
  if (
    object.v !== 1 || typeof object.scope !== "string" ||
    !SCOPE_PATTERN.test(object.scope) || typeof object.filter !== "string" ||
    object.filter.length > 1_024 || !isStringArray(object.position)
  ) {
    throw new InvalidCursorError("cursor payload is invalid");
  }
  return {
    v: 1,
    scope: object.scope,
    filter: object.filter,
    position: object.position,
  };
}

export function encodeCursor(
  scope: string,
  filter: string,
  position: readonly string[],
): string {
  if (!SCOPE_PATTERN.test(scope)) {
    throw new TypeError("cursor scope has an invalid format");
  }
  if (filter.length > 1_024 || !isStringArray(position)) {
    throw new TypeError("cursor payload is invalid");
  }
  const encoded = base64UrlEncode(JSON.stringify(
    {
      v: 1,
      scope,
      filter,
      position,
    } satisfies EncodedCursor,
  ));
  if (encoded.length > MAX_CURSOR_LENGTH) {
    throw new TypeError("cursor exceeds the public size limit");
  }
  return encoded;
}

export function decodeCursor(
  cursor: string,
  scope: string,
  filter: string,
  positionLength: number,
): readonly string[] {
  if (
    cursor.length < 1 || cursor.length > MAX_CURSOR_LENGTH ||
    !CURSOR_PATTERN.test(cursor)
  ) {
    throw new InvalidCursorError("cursor has an invalid format");
  }
  let parsed: EncodedCursor;
  try {
    parsed = parseEncodedCursor(JSON.parse(base64UrlDecode(cursor)));
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError("cursor is not valid base64url JSON");
  }
  if (
    parsed.scope !== scope || parsed.filter !== filter ||
    parsed.position.length !== positionLength
  ) {
    throw new InvalidCursorError("cursor does not match this query");
  }
  return parsed.position;
}
