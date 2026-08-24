import {
  type ContractParser,
  type ContractSchema,
  defineContractSchema,
  integerValue,
  nullable,
  optionalNullable,
  required,
  strictObject,
  stringValue,
  validationError,
} from "./schema.ts";

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MAX_CURSOR_LENGTH = 2_048;

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface CursorPaginationRequest {
  readonly cursor: string | null;
  readonly limit: number;
}

export interface CursorPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export const cursorPaginationRequestSchema: ContractSchema<
  CursorPaginationRequest
> = defineContractSchema(
  "CursorPaginationRequest",
  {
    type: "object",
    additionalProperties: false,
    properties: {
      cursor: {
        anyOf: [
          {
            type: "string",
            maxLength: MAX_CURSOR_LENGTH,
            pattern: "^[A-Za-z0-9_-]+$",
          },
          { type: "null" },
        ],
        default: null,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_PAGE_SIZE,
        default: DEFAULT_PAGE_SIZE,
      },
    },
  },
  (value, path): CursorPaginationRequest => {
    const object = strictObject(value, path, ["cursor", "limit"]);
    const cursor = optionalNullable(
      object,
      "cursor",
      path,
      (item, itemPath) =>
        stringValue(item, itemPath, {
          minLength: 1,
          maxLength: MAX_CURSOR_LENGTH,
          pattern: CURSOR_PATTERN,
        }),
    ) ?? null;
    const limit = Object.hasOwn(object, "limit")
      ? integerValue(object.limit, `${path}.limit`, {
        minimum: 1,
        maximum: MAX_PAGE_SIZE,
      })
      : DEFAULT_PAGE_SIZE;
    return { cursor, limit };
  },
);

export function createCursorPageSchema<Item>(
  itemSchema: ContractSchema<Item>,
): ContractSchema<CursorPage<Item>> {
  return defineContractSchema(
    `CursorPage<${itemSchema.name}>`,
    {
      type: "object",
      additionalProperties: false,
      required: ["items", "nextCursor"],
      properties: {
        items: {
          type: "array",
          maxItems: MAX_PAGE_SIZE,
          items: itemSchema.jsonSchema,
        },
        nextCursor: {
          anyOf: [
            {
              type: "string",
              maxLength: MAX_CURSOR_LENGTH,
              pattern: "^[A-Za-z0-9_-]+$",
            },
            { type: "null" },
          ],
        },
      },
    },
    (value, path): CursorPage<Item> => {
      const object = strictObject(value, path, ["items", "nextCursor"]);
      const rawItems = required(object, "items", path);
      if (!Array.isArray(rawItems)) {
        validationError(`${path}.items`, "invalid_type", "must be an array");
      }
      if (rawItems.length > MAX_PAGE_SIZE) {
        validationError(
          `${path}.items`,
          "out_of_range",
          `must contain at most ${MAX_PAGE_SIZE} items`,
        );
      }
      const parser = itemSchema.parse.bind(itemSchema) as (
        item: unknown,
      ) => Item;
      const items = rawItems.map((item) => parser(item));
      const nextCursor = nullable(
        required(object, "nextCursor", path),
        `${path}.nextCursor`,
        (item, itemPath) =>
          stringValue(item, itemPath, {
            minLength: 1,
            maxLength: MAX_CURSOR_LENGTH,
            pattern: CURSOR_PATTERN,
          }),
      );
      return { items, nextCursor };
    },
  );
}

export const cursorParser: ContractParser<string> = (value, path) =>
  stringValue(value, path, {
    minLength: 1,
    maxLength: MAX_CURSOR_LENGTH,
    pattern: CURSOR_PATTERN,
  });
