import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/2020";
import type { JsonObject } from "@relay/providers";

export type OcrSchemaValidator = (value: unknown) => boolean;

function inspectSize(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  if (++budget.nodes > 8_192 || depth > 32) {
    throw new Error("OCR JSON is too complex");
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      inspectSize(item, depth + 1, budget);
    }
  }
}

/** Compile a bounded, local schema before any billable provider submission. */
export function compileOcrSchema(schema: JsonObject): OcrSchemaValidator {
  inspectSize(schema);
  let nodes = 0;
  const active = new Set<object>();
  function inspect(value: unknown, depth: number): void {
    if (++nodes > 8_192 || depth > 32) {
      throw new Error("OCR schema is too complex");
    }
    if (value === null || typeof value !== "object") return;
    if (active.has(value)) {
      throw new Error("Recursive OCR schemas are unsupported");
    }
    active.add(value);
    const definition = value as Record<string, unknown>;
    // Native regular expressions have no execution deadline. Keep the MVP
    // schema subset structural so a caller cannot stall the worker event loop.
    for (
      const key of [
        "pattern",
        "patternProperties",
        "$async",
        "$data",
        "$dynamicRef",
        "$recursiveRef",
      ]
    ) {
      if (Object.hasOwn(definition, key)) {
        throw new Error("Unsupported OCR schema keyword");
      }
    }
    if (depth > 0 && Object.hasOwn(definition, "$id")) {
      throw new Error("Nested OCR schema identifiers are unsupported");
    }
    const reference = definition.$ref;
    if (reference !== undefined) {
      if (typeof reference !== "string" || !reference.startsWith("#/")) {
        throw new Error("OCR schemas may only reference local JSON pointers");
      }
      let target: unknown = schema;
      for (const segment of reference.slice(2).split("/")) {
        const key = decodeURIComponent(segment).replaceAll("~1", "/")
          .replaceAll("~0", "~");
        if (
          target === null || typeof target !== "object" ||
          !Object.hasOwn(target, key)
        ) {
          throw new Error("Unresolved OCR schema reference");
        }
        target = (target as Record<string, unknown>)[key];
      }
      inspect(target, depth + 1);
    }
    for (
      const key of [
        "properties",
        "$defs",
        "definitions",
        "dependentSchemas",
        "dependencies",
      ]
    ) {
      const children = definition[key];
      if (children !== null && typeof children === "object") {
        for (const child of Object.values(children)) {
          if (!Array.isArray(child)) inspect(child, depth + 1);
        }
      }
    }
    for (
      const key of [
        "items",
        "additionalItems",
        "additionalProperties",
        "contains",
        "not",
        "if",
        "then",
        "else",
        "propertyNames",
        "unevaluatedItems",
        "unevaluatedProperties",
        "contentSchema",
        "allOf",
        "anyOf",
        "oneOf",
        "prefixItems",
      ]
    ) {
      const child = definition[key];
      if (Array.isArray(child)) {
        for (const item of child) inspect(item, depth + 1);
      } else if (child !== undefined) inspect(child, depth + 1);
    }
    active.delete(value);
  }
  inspect(schema, 0);
  if (
    new TextEncoder().encode(JSON.stringify(schema)).byteLength > 256 * 1024
  ) {
    throw new Error("OCR schema is too large");
  }
  const Constructor =
    schema.$schema === "https://json-schema.org/draft/2020-12/schema"
      ? Ajv2020
      : Ajv;
  // No coercion, defaults, remote loading, async validation, or global schema cache.
  const ajv = new Constructor({
    strict: true,
    strictTypes: false,
    strictTuples: false,
    allowUnionTypes: true,
    allErrors: false,
    ownProperties: true,
    inlineRefs: false,
    logger: false,
  });
  const validate = ajv.compile(schema);
  return (value) => {
    try {
      inspectSize(value);
      return validate(value) === true;
    } catch {
      return false;
    }
  };
}

/** Invalid or missing structured output is never persisted as a JSON string. */
export function parseOcrAnnotation(
  annotation: string | null,
  validate?: OcrSchemaValidator,
): { readonly valid: true; readonly value: unknown } | {
  readonly valid: false;
} {
  if (annotation === null) return { valid: false };
  try {
    if (new TextEncoder().encode(annotation).byteLength > 256 * 1024) {
      return { valid: false };
    }
    const value: unknown = JSON.parse(annotation);
    inspectSize(value);
    if (validate !== undefined && !validate(value)) return { valid: false };
    return { valid: true, value };
  } catch {
    return { valid: false };
  }
}
