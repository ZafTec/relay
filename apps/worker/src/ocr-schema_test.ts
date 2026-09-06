import { assertEquals, assertThrows } from "@std/assert";
import { compileOcrSchema, parseOcrAnnotation } from "./ocr-schema.ts";

Deno.test("OCR extraction validates local definitions without coercing provider output", () => {
  const validate = compileOcrSchema({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    required: ["total", "items"],
    additionalProperties: false,
    $defs: { amount: { type: "number", minimum: 0 } },
    properties: {
      total: { $ref: "#/$defs/amount" },
      items: { type: "array", items: { type: "string" }, minItems: 1 },
    },
  });
  assertEquals(
    parseOcrAnnotation('{"total":12,"items":["Book"]}', validate).valid,
    true,
  );
  for (
    const value of [
      null,
      "not JSON",
      '{"total":"12","items":["Book"]}',
      '{"total":-1,"items":[]}',
      '{"total":12}',
      '{"total":12,"items":["Book"],"extra":true}',
    ]
  ) {
    assertEquals(parseOcrAnnotation(value, validate), { valid: false });
  }
});

Deno.test("OCR rejects remote, async, invalid, and overly deep schemas before submission", () => {
  const schemas: Parameters<typeof compileOcrSchema>[0][] = [
    { $ref: "https://example.test/schema.json" },
    { type: "object", properties: { child: { $ref: "file:///secret" } } },
    { $async: true, type: "object" },
    { type: "unknown" },
    { required: "name" },
    { type: "string", pattern: "(a+)+$" },
    {
      $defs: { recursive: { $ref: "#/$defs/recursive" } },
      $ref: "#/$defs/recursive",
    },
  ];
  for (const schema of schemas) {
    assertThrows(() => compileOcrSchema(schema));
  }
  let schema: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 40; i++) schema = { type: "array", items: schema };
  assertThrows(() =>
    compileOcrSchema(schema as Parameters<typeof compileOcrSchema>[0])
  );
});

Deno.test("OCR schema restrictions do not reject ordinary field names", () => {
  const validate = compileOcrSchema({
    type: "object",
    properties: { pattern: { type: "string" }, $ref: { type: "string" } },
  });
  assertEquals(
    validate({ pattern: "anything", $ref: "data, not a schema" }),
    true,
  );
});

Deno.test("OCR annotations have independent size and depth bounds", () => {
  assertEquals(
    parseOcrAnnotation(JSON.stringify("x".repeat(256 * 1024))).valid,
    false,
  );
  assertEquals(
    parseOcrAnnotation("[".repeat(40) + "0" + "]".repeat(40)).valid,
    false,
  );
});
