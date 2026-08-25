export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type JsonSchema = Readonly<Record<string, unknown>>;

export type ContractValidationCode =
  | "invalid_type"
  | "invalid_value"
  | "missing_field"
  | "unknown_field"
  | "out_of_range";

export interface ContractValidationIssue {
  readonly path: string;
  readonly code: ContractValidationCode;
  readonly message: string;
}

export class ContractValidationError extends TypeError {
  override readonly name = "ContractValidationError";
  readonly issues: readonly ContractValidationIssue[];

  constructor(issue: ContractValidationIssue) {
    super(`${issue.path}: ${issue.message}`);
    this.issues = Object.freeze([issue]);
  }
}

export type ContractParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: ContractValidationError };

export interface ContractSchema<T> {
  readonly name: string;
  /** JSON Schema for HTTP OpenAPI and MCP adapters; runtime parsing stays canonical. */
  readonly jsonSchema: JsonSchema;
  parse(value: unknown): T;
  safeParse(value: unknown): ContractParseResult<T>;
  is(value: unknown): value is T;
}

export type ContractParser<T> = (value: unknown, path: string) => T;

export function validationError(
  path: string,
  code: ContractValidationCode,
  message: string,
): never {
  throw new ContractValidationError({ path, code, message });
}

export function defineContractSchema<T>(
  name: string,
  jsonSchema: JsonSchema,
  parser: ContractParser<T>,
): ContractSchema<T> {
  return Object.freeze({
    name,
    jsonSchema: Object.freeze(jsonSchema),
    parse(value: unknown): T {
      return parser(value, "$input");
    },
    safeParse(value: unknown): ContractParseResult<T> {
      try {
        return { success: true, data: parser(value, "$input") };
      } catch (error) {
        if (error instanceof ContractValidationError) {
          return { success: false, error };
        }
        throw error;
      }
    },
    is(value: unknown): value is T {
      try {
        parser(value, "$input");
        return true;
      } catch (error) {
        if (error instanceof ContractValidationError) return false;
        throw error;
      }
    },
  });
}

export function strictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    return validationError(path, "invalid_type", "must be an object");
  }
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      validationError(`${path}.${key}`, "unknown_field", "is not supported");
    }
  }
  return value as Record<string, unknown>;
}

export function required(
  object: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(object, key)) {
    validationError(`${path}.${key}`, "missing_field", "is required");
  }
  return object[key];
}

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly trim?: boolean;
}

export function stringValue(
  value: unknown,
  path: string,
  options: StringOptions = {},
): string {
  if (typeof value !== "string") {
    return validationError(path, "invalid_type", "must be a string");
  }
  const parsed = options.trim ? value.trim() : value;
  if ((options.minLength ?? 0) > parsed.length) {
    validationError(path, "out_of_range", "is too short");
  }
  if (options.maxLength !== undefined && parsed.length > options.maxLength) {
    validationError(path, "out_of_range", "is too long");
  }
  if (options.pattern !== undefined && !options.pattern.test(parsed)) {
    validationError(path, "invalid_value", "has an invalid format");
  }
  return parsed;
}

export function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    return validationError(path, "invalid_type", "must be a boolean");
  }
  return value;
}

export interface IntegerOptions {
  readonly minimum?: number;
  readonly maximum?: number;
}

export function integerValue(
  value: unknown,
  path: string,
  options: IntegerOptions = {},
): number {
  if (!Number.isSafeInteger(value)) {
    return validationError(path, "invalid_type", "must be a safe integer");
  }
  const parsed = value as number;
  if (options.minimum !== undefined && parsed < options.minimum) {
    validationError(
      path,
      "out_of_range",
      `must be at least ${options.minimum}`,
    );
  }
  if (options.maximum !== undefined && parsed > options.maximum) {
    validationError(path, "out_of_range", `must be at most ${options.maximum}`);
  }
  return parsed;
}

export function enumValue<const Values extends readonly string[]>(
  value: unknown,
  path: string,
  values: Values,
): Values[number] {
  if (
    typeof value !== "string" ||
    !(values as readonly string[]).includes(value)
  ) {
    return validationError(
      path,
      "invalid_value",
      `must be one of: ${values.join(", ")}`,
    );
  }
  return value as Values[number];
}

export function nullable<T>(
  value: unknown,
  path: string,
  parser: ContractParser<T>,
): T | null {
  return value === null ? null : parser(value, path);
}

export function optional<T>(
  object: Record<string, unknown>,
  key: string,
  path: string,
  parser: ContractParser<T>,
): T | undefined {
  return Object.hasOwn(object, key) && object[key] !== undefined
    ? parser(object[key], `${path}.${key}`)
    : undefined;
}

export function optionalNullable<T>(
  object: Record<string, unknown>,
  key: string,
  path: string,
  parser: ContractParser<T>,
): T | null | undefined {
  if (!Object.hasOwn(object, key) || object[key] === undefined) {
    return undefined;
  }
  return object[key] === null ? null : parser(object[key], `${path}.${key}`);
}

export function arrayValue<T>(
  value: unknown,
  path: string,
  parser: ContractParser<T>,
  options: { readonly maxItems?: number; readonly minItems?: number } = {},
): readonly T[] {
  if (!Array.isArray(value)) {
    return validationError(path, "invalid_type", "must be an array");
  }
  if (options.minItems !== undefined && value.length < options.minItems) {
    validationError(path, "out_of_range", "contains too few items");
  }
  if (options.maxItems !== undefined && value.length > options.maxItems) {
    validationError(path, "out_of_range", "contains too many items");
  }
  return value.map((item, index) => parser(item, `${path}[${index}]`));
}

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isoTimestamp(value: unknown, path: string): string {
  const parsed = stringValue(value, path, {
    minLength: 24,
    maxLength: 24,
    pattern: ISO_TIMESTAMP_PATTERN,
  });
  if (!Number.isFinite(Date.parse(parsed))) {
    return validationError(path, "invalid_value", "must be an ISO timestamp");
  }
  return parsed;
}

const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 4_096;
const MAX_JSON_BYTES = 256 * 1024;
const RAW_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\//i;

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

interface JsonValidationOptions {
  readonly rejectUrls?: boolean;
  readonly maxBytes?: number;
}

interface JsonTraversalState {
  nodes: number;
  readonly seen: WeakSet<object>;
  readonly rejectUrls: boolean;
}

function inspectJson(
  value: unknown,
  path: string,
  depth: number,
  state: JsonTraversalState,
): JsonValue {
  state.nodes += 1;
  if (depth > MAX_JSON_DEPTH || state.nodes > MAX_JSON_NODES) {
    return validationError(path, "out_of_range", "is too complex");
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return validationError(path, "invalid_value", "must be finite");
    }
    return value;
  }
  if (typeof value === "string") {
    if (state.rejectUrls && RAW_URL_PATTERN.test(value)) {
      return validationError(path, "invalid_value", "must not contain a URL");
    }
    return value;
  }
  if (typeof value !== "object") {
    return validationError(path, "invalid_type", "must be JSON-compatible");
  }
  if (state.seen.has(value)) {
    return validationError(path, "invalid_value", "must not contain cycles");
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return validationError(path, "invalid_type", "must contain JSON objects");
  }

  state.seen.add(value);
  let parsed: JsonValue;
  if (Array.isArray(value)) {
    parsed = value.map((item, index) =>
      inspectJson(item, `${path}[${index}]`, depth + 1, state)
    );
  } else {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (key.length === 0 || key.length > 256 || hasControlCharacter(key)) {
        validationError(path, "invalid_value", "contains an invalid key");
      }
      if (state.rejectUrls && RAW_URL_PATTERN.test(key)) {
        validationError(path, "invalid_value", "must not contain a URL");
      }
      result[key] = inspectJson(item, `${path}.${key}`, depth + 1, state);
    }
    parsed = result;
  }
  state.seen.delete(value);
  return parsed;
}

export function jsonValue(
  value: unknown,
  path: string,
  options: JsonValidationOptions = {},
): JsonValue {
  const parsed = inspectJson(value, path, 0, {
    nodes: 0,
    seen: new WeakSet(),
    rejectUrls: options.rejectUrls ?? false,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
  if (bytes > (options.maxBytes ?? MAX_JSON_BYTES)) {
    validationError(path, "out_of_range", "is too large");
  }
  return parsed;
}

export function jsonObject(
  value: unknown,
  path: string,
  options: JsonValidationOptions = {},
): JsonObject {
  const parsed = jsonValue(value, path, options);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return validationError(path, "invalid_type", "must be a JSON object");
  }
  return parsed as JsonObject;
}

export function stringRecord(
  value: unknown,
  path: string,
): Readonly<Record<string, string>> {
  const object = strictObject(value, path, Object.keys(value ?? {}));
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(object)) {
    if (key.length === 0 || key.length > 256) {
      validationError(path, "invalid_value", "contains an invalid key");
    }
    result[key] = stringValue(item, `${path}.${key}`, { maxLength: 4_096 });
  }
  return result;
}
