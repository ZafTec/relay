import { type ContractSchema, ContractValidationError } from "@relay/contracts";
import { invalidRequest } from "./errors.ts";

export const DEFAULT_MAX_JSON_BODY_BYTES = 256 * 1024;

export type QueryValueKind = "string" | "integer" | "boolean" | "strings";
export type QueryShape = Readonly<Record<string, QueryValueKind>>;

function publicField(path: string): string {
  return /^[A-Za-z0-9_$.[\]-]{1,128}$/.test(path) ? path : "$input";
}

export function parseContractInput<T>(
  schema: ContractSchema<T>,
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ContractValidationError) {
      const issue = error.issues[0];
      throw invalidRequest({
        field: publicField(issue?.path ?? "$input"),
        reason: issue?.code ?? "invalid_value",
      });
    }
    throw error;
  }
}

function coerceQueryValue(value: string, kind: QueryValueKind): unknown {
  switch (kind) {
    case "string":
      return value;
    case "integer":
      return /^(?:0|[1-9][0-9]*)$/.test(value) &&
          Number.isSafeInteger(Number(value))
        ? Number(value)
        : value;
    case "boolean":
      return value === "true" ? true : value === "false" ? false : value;
    case "strings":
      return value.split(",");
  }
}

export function parseQuery<T>(
  request: Request,
  schema: ContractSchema<T>,
  shape: QueryShape,
): T {
  const params = new URL(request.url).searchParams;
  const raw: Record<string, unknown> = Object.create(null);
  const visited = new Set<string>();

  for (const key of params.keys()) {
    if (visited.has(key)) continue;
    visited.add(key);
    const values = params.getAll(key);
    const kind = shape[key];
    if (kind === "strings") {
      raw[key] = values.flatMap((value) =>
        coerceQueryValue(value, kind) as string[]
      );
      continue;
    }
    if (values.length !== 1) {
      throw invalidRequest({ field: key, reason: "duplicate_query_parameter" });
    }
    raw[key] = kind === undefined
      ? values[0]
      : coerceQueryValue(values[0], kind);
  }

  return parseContractInput(schema, raw);
}

export function assertNoQuery(request: Request): void {
  const first = new URL(request.url).searchParams.keys().next();
  if (!first.done) {
    throw invalidRequest({
      field: first.value,
      reason: "unsupported_query_parameter",
    });
  }
}

function validateBodyLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxJsonBodyBytes must be a positive safe integer");
  }
  return maxBytes;
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array> {
  const limit = validateBodyLimit(maxBytes);
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      throw invalidRequest({
        field: "content-length",
        reason: "invalid_value",
      });
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      throw invalidRequest({ field: "content-length", reason: "out_of_range" });
    }
    if (parsedLength > limit) {
      throw invalidRequest({ field: "body", reason: "body_too_large" }, 413);
    }
  }

  if (request.body === null) {
    throw invalidRequest({ field: "body", reason: "missing_body" });
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw invalidRequest({ field: "body", reason: "body_too_large" }, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function requireJsonContentType(request: Request): void {
  const contentEncoding = request.headers.get("content-encoding");
  if (
    contentEncoding !== null && contentEncoding !== "" &&
    contentEncoding.toLowerCase() !== "identity"
  ) {
    throw invalidRequest(
      { field: "content-encoding", reason: "unsupported_content_encoding" },
      415,
    );
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]
    .trim().toLowerCase();
  if (contentType !== "application/json") {
    throw invalidRequest(
      { field: "content-type", reason: "application_json_required" },
      415,
    );
  }
}

export async function readJsonBody(
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<unknown> {
  requireJsonContentType(request);
  const bytes = await readBoundedBody(request, maxBytes);
  if (bytes.byteLength === 0) {
    throw invalidRequest({ field: "body", reason: "missing_body" });
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidRequest({ field: "body", reason: "invalid_utf8" });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw invalidRequest({ field: "body", reason: "malformed_json" });
  }
}

export async function readOptionalJsonObject(
  request: Request,
  maxBytes = DEFAULT_MAX_JSON_BODY_BYTES,
): Promise<Record<string, unknown>> {
  if (request.body === null) return {};
  const value = await readJsonBody(request, maxBytes);
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw invalidRequest({ field: "$input", reason: "invalid_type" });
  }
  return value as Record<string, unknown>;
}

export async function assertEmptyBody(request: Request): Promise<void> {
  if (request.body === null) return;
  const reader = request.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value.byteLength > 0) {
        await reader.cancel();
        throw invalidRequest({ field: "body", reason: "body_not_allowed" });
      }
    }
  } finally {
    reader.releaseLock();
  }
}
