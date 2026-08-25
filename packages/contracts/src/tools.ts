import {
  type ContractSchema,
  defineContractSchema,
  enumValue,
  integerValue,
  type JsonValue,
  jsonValue,
  nullable,
  optional,
  required,
  strictObject,
  stringValue,
} from "./schema.ts";
import {
  createCursorPageSchema,
  type CursorPage,
  type CursorPaginationRequest,
  cursorPaginationRequestSchema,
} from "./pagination.ts";
import {
  toolIdParser,
  toolKeyParser,
  toolVersionIdParser,
} from "./identifiers.ts";

export const PUBLIC_TOOL_LIFECYCLES = ["published", "deprecated"] as const;
export type PublicToolLifecycle = (typeof PUBLIC_TOOL_LIFECYCLES)[number];

export interface ToolSummary {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly category: string | null;
  readonly summary: string | null;
  readonly lifecycle: PublicToolLifecycle;
  readonly activeVersionId: string;
  readonly version: number;
}

export interface ToolDetail extends ToolSummary {
  readonly executionMode: string;
  readonly maxDurationSeconds: number;
  readonly inputSchema: JsonValue;
  readonly outputSchema: JsonValue;
}

export interface ListToolsRequest extends CursorPaginationRequest {
  readonly category?: string;
  readonly search?: string;
}

export type ListToolsResult =
  | ({ readonly kind: "ok" } & CursorPage<ToolSummary>)
  | { readonly kind: "not_found" };

export type GetToolResult =
  | { readonly kind: "found"; readonly tool: ToolDetail }
  | { readonly kind: "not_found" };

function toolSummary(value: unknown, path: string): ToolSummary {
  const object = strictObject(value, path, [
    "id",
    "key",
    "name",
    "category",
    "summary",
    "lifecycle",
    "activeVersionId",
    "version",
  ]);
  return {
    id: toolIdParser(required(object, "id", path), `${path}.id`),
    key: toolKeyParser(required(object, "key", path), `${path}.key`),
    name: stringValue(required(object, "name", path), `${path}.name`, {
      minLength: 1,
      maxLength: 255,
    }),
    category: nullable(
      required(object, "category", path),
      `${path}.category`,
      (item, itemPath) =>
        stringValue(item, itemPath, { minLength: 1, maxLength: 64 }),
    ),
    summary: nullable(
      required(object, "summary", path),
      `${path}.summary`,
      (item, itemPath) =>
        stringValue(item, itemPath, { minLength: 1, maxLength: 1_024 }),
    ),
    lifecycle: enumValue(
      required(object, "lifecycle", path),
      `${path}.lifecycle`,
      PUBLIC_TOOL_LIFECYCLES,
    ),
    activeVersionId: toolVersionIdParser(
      required(object, "activeVersionId", path),
      `${path}.activeVersionId`,
    ),
    version: integerValue(
      required(object, "version", path),
      `${path}.version`,
      { minimum: 1 },
    ),
  };
}

export const toolSummarySchema: ContractSchema<ToolSummary> =
  defineContractSchema(
    "ToolSummary",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "key",
        "name",
        "category",
        "summary",
        "lifecycle",
        "activeVersionId",
        "version",
      ],
      properties: {
        id: { type: "string", pattern: "^tool_[0-9a-f]{32}$" },
        key: { type: "string", minLength: 1, maxLength: 128 },
        name: { type: "string", minLength: 1, maxLength: 255 },
        category: { type: ["string", "null"], maxLength: 64 },
        summary: { type: ["string", "null"], maxLength: 1_024 },
        lifecycle: { type: "string", enum: PUBLIC_TOOL_LIFECYCLES },
        activeVersionId: { type: "string", pattern: "^tver_[0-9a-f]{32}$" },
        version: { type: "integer", minimum: 1 },
      },
    },
    toolSummary,
  );

export const toolDetailSchema: ContractSchema<ToolDetail> =
  defineContractSchema(
    "ToolDetail",
    {
      type: "object",
      additionalProperties: false,
      required: [
        "id",
        "key",
        "name",
        "category",
        "summary",
        "lifecycle",
        "activeVersionId",
        "version",
        "executionMode",
        "maxDurationSeconds",
        "inputSchema",
        "outputSchema",
      ],
      properties: {
        ...toolSummarySchema.jsonSchema.properties as Record<string, unknown>,
        executionMode: { type: "string", minLength: 1, maxLength: 64 },
        maxDurationSeconds: { type: "integer", minimum: 1, maximum: 86_400 },
        inputSchema: {},
        outputSchema: {},
      },
    },
    (value, path): ToolDetail => {
      const object = strictObject(value, path, [
        "id",
        "key",
        "name",
        "category",
        "summary",
        "lifecycle",
        "activeVersionId",
        "version",
        "executionMode",
        "maxDurationSeconds",
        "inputSchema",
        "outputSchema",
      ]);
      const summary = toolSummary(
        {
          id: object.id,
          key: object.key,
          name: object.name,
          category: object.category,
          summary: object.summary,
          lifecycle: object.lifecycle,
          activeVersionId: object.activeVersionId,
          version: object.version,
        },
        path,
      );
      return {
        ...summary,
        executionMode: stringValue(
          required(object, "executionMode", path),
          `${path}.executionMode`,
          { minLength: 1, maxLength: 64 },
        ),
        maxDurationSeconds: integerValue(
          required(object, "maxDurationSeconds", path),
          `${path}.maxDurationSeconds`,
          { minimum: 1, maximum: 86_400 },
        ),
        inputSchema: jsonValue(
          required(object, "inputSchema", path),
          `${path}.inputSchema`,
        ),
        outputSchema: jsonValue(
          required(object, "outputSchema", path),
          `${path}.outputSchema`,
        ),
      };
    },
  );

export const listToolsRequestSchema: ContractSchema<ListToolsRequest> =
  defineContractSchema(
    "ListToolsRequest",
    {
      type: "object",
      additionalProperties: false,
      properties: {
        ...cursorPaginationRequestSchema.jsonSchema.properties as Record<
          string,
          unknown
        >,
        category: { type: "string", minLength: 1, maxLength: 64 },
        search: { type: "string", minLength: 1, maxLength: 100 },
      },
    },
    (value, path): ListToolsRequest => {
      const object = strictObject(value, path, [
        "cursor",
        "limit",
        "category",
        "search",
      ]);
      const page = cursorPaginationRequestSchema.parse({
        ...(Object.hasOwn(object, "cursor") ? { cursor: object.cursor } : {}),
        ...(Object.hasOwn(object, "limit") ? { limit: object.limit } : {}),
      });
      const category = optional(
        object,
        "category",
        path,
        (item, itemPath) =>
          stringValue(item, itemPath, {
            minLength: 1,
            maxLength: 64,
            trim: true,
          }),
      );
      const search = optional(
        object,
        "search",
        path,
        (item, itemPath) =>
          stringValue(item, itemPath, {
            minLength: 1,
            maxLength: 100,
            trim: true,
          }),
      );
      return {
        ...page,
        ...(category === undefined ? {} : { category }),
        ...(search === undefined ? {} : { search }),
      };
    },
  );

const toolPageSchema: ContractSchema<CursorPage<ToolSummary>> =
  createCursorPageSchema(toolSummarySchema);

export const listToolsResultSchema: ContractSchema<ListToolsResult> =
  defineContractSchema(
    "ListToolsResult",
    {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "items", "nextCursor"],
          properties: {
            kind: { const: "ok" },
            ...(toolPageSchema.jsonSchema.properties as Record<
              string,
              unknown
            >),
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "not_found" } },
        },
      ],
    },
    (value, path): ListToolsResult => {
      const object = strictObject(value, path, ["kind", "items", "nextCursor"]);
      const kind = enumValue(
        required(object, "kind", path),
        `${path}.kind`,
        ["ok", "not_found"] as const,
      );
      if (kind === "not_found") {
        strictObject(value, path, ["kind"]);
        return { kind };
      }
      const page = toolPageSchema.parse({
        items: required(object, "items", path),
        nextCursor: required(object, "nextCursor", path),
      });
      return { kind, ...page };
    },
  );

export const getToolResultSchema: ContractSchema<GetToolResult> =
  defineContractSchema(
    "GetToolResult",
    {
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "tool"],
          properties: {
            kind: { const: "found" },
            tool: toolDetailSchema.jsonSchema,
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: { kind: { const: "not_found" } },
        },
      ],
    },
    (value, path): GetToolResult => {
      const object = strictObject(value, path, ["kind", "tool"]);
      const kind = enumValue(
        required(object, "kind", path),
        `${path}.kind`,
        ["found", "not_found"] as const,
      );
      if (kind === "not_found") {
        strictObject(value, path, ["kind"]);
        return { kind };
      }
      return {
        kind,
        tool: toolDetailSchema.parse(required(object, "tool", path)),
      };
    },
  );
