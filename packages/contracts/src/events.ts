import {
  type ContractSchema,
  defineContractSchema,
  enumValue,
  isoTimestamp,
  nullable,
  required,
  strictObject,
  stringValue,
} from "./schema.ts";
import {
  artifactIdParser,
  runIdParser,
  safeCodeParser,
  shareLinkIdParser,
  toolKeyParser,
} from "./identifiers.ts";
import { RUN_STATUSES, type RunStatus } from "./statuses.ts";
import {
  createCursorPageSchema,
  type CursorPage,
  type CursorPaginationRequest,
  cursorPaginationRequestSchema,
} from "./pagination.ts";

export const WORKSPACE_EVENT_TYPES = [
  "run.created",
  "run.status_changed",
  "run.progress_changed",
  "run.completed",
  "artifact.created",
  "share_link.changed",
  "usage.changed",
  "tool.availability_changed",
  "session.permission_changed",
] as const;
export type WorkspaceEventType = (typeof WORKSPACE_EVENT_TYPES)[number];

export type WorkspaceEventData =
  | {
    readonly type: "run.created" | "run.progress_changed";
    readonly runId: string;
  }
  | {
    readonly type: "run.status_changed" | "run.completed";
    readonly runId: string;
    readonly status: RunStatus;
  }
  | {
    readonly type: "artifact.created";
    readonly artifactId: string;
    readonly runId: string | null;
  }
  | {
    readonly type: "share_link.changed";
    readonly shareLinkId: string;
    readonly artifactId: string;
  }
  | {
    readonly type: "usage.changed";
    readonly metric: string | null;
  }
  | {
    readonly type: "tool.availability_changed";
    readonly toolKey: string;
  }
  | {
    readonly type: "session.permission_changed";
    readonly reason: "membership_changed" | "role_changed";
  };

export interface WorkspaceEventEnvelope {
  /** PostgreSQL bigint serialized as text; suitable for an SSE `id` field. */
  readonly id: string;
  readonly workspaceId: string;
  readonly occurredAt: string;
  readonly event: WorkspaceEventData;
}

export interface ListWorkspaceEventsRequest extends CursorPaginationRequest {}

export type ListWorkspaceEventsResult =
  | ({ readonly kind: "ok" } & CursorPage<WorkspaceEventEnvelope>)
  | { readonly kind: "not_found" };

function workspaceEventData(value: unknown, path: string): WorkspaceEventData {
  const broad = strictObject(value, path, [
    "type",
    "runId",
    "status",
    "artifactId",
    "shareLinkId",
    "metric",
    "toolKey",
    "reason",
  ]);
  const type = enumValue(
    required(broad, "type", path),
    `${path}.type`,
    WORKSPACE_EVENT_TYPES,
  );
  switch (type) {
    case "run.created":
    case "run.progress_changed": {
      const object = strictObject(value, path, ["type", "runId"]);
      return {
        type,
        runId: runIdParser(required(object, "runId", path), `${path}.runId`),
      };
    }
    case "run.status_changed":
    case "run.completed": {
      const object = strictObject(value, path, ["type", "runId", "status"]);
      return {
        type,
        runId: runIdParser(required(object, "runId", path), `${path}.runId`),
        status: enumValue(
          required(object, "status", path),
          `${path}.status`,
          RUN_STATUSES,
        ),
      };
    }
    case "artifact.created": {
      const object = strictObject(value, path, ["type", "artifactId", "runId"]);
      return {
        type,
        artifactId: artifactIdParser(
          required(object, "artifactId", path),
          `${path}.artifactId`,
        ),
        runId: nullable(
          required(object, "runId", path),
          `${path}.runId`,
          runIdParser,
        ),
      };
    }
    case "share_link.changed": {
      const object = strictObject(value, path, [
        "type",
        "shareLinkId",
        "artifactId",
      ]);
      return {
        type,
        shareLinkId: shareLinkIdParser(
          required(object, "shareLinkId", path),
          `${path}.shareLinkId`,
        ),
        artifactId: artifactIdParser(
          required(object, "artifactId", path),
          `${path}.artifactId`,
        ),
      };
    }
    case "usage.changed": {
      const object = strictObject(value, path, ["type", "metric"]);
      return {
        type,
        metric: nullable(
          required(object, "metric", path),
          `${path}.metric`,
          safeCodeParser,
        ),
      };
    }
    case "tool.availability_changed": {
      const object = strictObject(value, path, ["type", "toolKey"]);
      return {
        type,
        toolKey: toolKeyParser(
          required(object, "toolKey", path),
          `${path}.toolKey`,
        ),
      };
    }
    case "session.permission_changed": {
      const object = strictObject(value, path, ["type", "reason"]);
      return {
        type,
        reason: enumValue(
          required(object, "reason", path),
          `${path}.reason`,
          ["membership_changed", "role_changed"] as const,
        ),
      };
    }
  }
}

export const workspaceEventEnvelopeSchema: ContractSchema<
  WorkspaceEventEnvelope
> = defineContractSchema(
  "WorkspaceEventEnvelope",
  {
    type: "object",
    additionalProperties: false,
    required: ["id", "workspaceId", "occurredAt", "event"],
    properties: {
      id: { type: "string", pattern: "^[1-9][0-9]*$" },
      workspaceId: { type: "string", minLength: 1, maxLength: 255 },
      occurredAt: { type: "string", format: "date-time" },
      event: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "runId"],
            properties: {
              type: { enum: ["run.created", "run.progress_changed"] },
              runId: { type: "string", pattern: "^run_[0-9a-f]{32}$" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "runId", "status"],
            properties: {
              type: { enum: ["run.status_changed", "run.completed"] },
              runId: { type: "string", pattern: "^run_[0-9a-f]{32}$" },
              status: { type: "string", enum: RUN_STATUSES },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "artifactId", "runId"],
            properties: {
              type: { const: "artifact.created" },
              artifactId: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
              runId: { type: ["string", "null"] },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "shareLinkId", "artifactId"],
            properties: {
              type: { const: "share_link.changed" },
              shareLinkId: {
                type: "string",
                pattern: "^share_[0-9a-f]{32}$",
              },
              artifactId: { type: "string", pattern: "^art_[0-9a-f]{32}$" },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "metric"],
            properties: {
              type: { const: "usage.changed" },
              metric: { type: ["string", "null"], maxLength: 128 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "toolKey"],
            properties: {
              type: { const: "tool.availability_changed" },
              toolKey: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "reason"],
            properties: {
              type: { const: "session.permission_changed" },
              reason: { enum: ["membership_changed", "role_changed"] },
            },
          },
        ],
      },
    },
  },
  (value, path): WorkspaceEventEnvelope => {
    const object = strictObject(value, path, [
      "id",
      "workspaceId",
      "occurredAt",
      "event",
    ]);
    return {
      id: stringValue(required(object, "id", path), `${path}.id`, {
        minLength: 1,
        maxLength: 20,
        pattern: /^[1-9][0-9]*$/,
      }),
      workspaceId: stringValue(
        required(object, "workspaceId", path),
        `${path}.workspaceId`,
        { minLength: 1, maxLength: 255 },
      ),
      occurredAt: isoTimestamp(
        required(object, "occurredAt", path),
        `${path}.occurredAt`,
      ),
      event: workspaceEventData(
        required(object, "event", path),
        `${path}.event`,
      ),
    };
  },
);

export const listWorkspaceEventsRequestSchema: ContractSchema<
  ListWorkspaceEventsRequest
> = cursorPaginationRequestSchema;
const workspaceEventPageSchema: ContractSchema<
  CursorPage<WorkspaceEventEnvelope>
> = createCursorPageSchema(
  workspaceEventEnvelopeSchema,
);

export const listWorkspaceEventsResultSchema: ContractSchema<
  ListWorkspaceEventsResult
> = defineContractSchema(
  "ListWorkspaceEventsResult",
  {
    oneOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "items", "nextCursor"],
        properties: {
          kind: { const: "ok" },
          ...(workspaceEventPageSchema.jsonSchema.properties as Record<
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
  (value, path): ListWorkspaceEventsResult => {
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
    const page = workspaceEventPageSchema.parse({
      items: required(object, "items", path),
      nextCursor: required(object, "nextCursor", path),
    });
    return { kind, ...page };
  },
);
