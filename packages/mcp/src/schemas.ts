import { z } from "zod/v4";
import {
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  PUBLIC_ID_PATTERNS,
  RUN_STATUSES,
  TOOL_KEY_PATTERN,
} from "@relay/contracts";

const cursorSchema = z.string().min(1).max(MAX_CURSOR_LENGTH).regex(
  /^[A-Za-z0-9_-]+$/,
).nullable().optional();
const limitSchema = z.number().int().min(1).max(MAX_PAGE_SIZE).optional();
const toolKeySchema = z.string().min(1).max(128).regex(TOOL_KEY_PATTERN);
const runIdSchema = z.string().regex(PUBLIC_ID_PATTERNS.run);
const artifactIdSchema = z.string().regex(PUBLIC_ID_PATTERNS.artifact);
const artifactVersionIdSchema = z.string().regex(
  PUBLIC_ID_PATTERNS.artifactVersion,
);
const artifactUploadIdSchema = z.string().regex(
  PUBLIC_ID_PATTERNS.artifactUpload,
);
const shareLinkIdSchema = z.string().regex(PUBLIC_ID_PATTERNS.shareLink);
const isoTimestampSchema = z.string().min(24).max(24);

export const listToolsInputSchema = z.object({
  cursor: cursorSchema,
  limit: limitSchema,
  category: z.string().min(1).max(64).optional(),
  search: z.string().min(1).max(100).optional(),
}).strict();

export const getToolInputSchema = z.object({
  toolKey: toolKeySchema,
}).strict();

export const listRunsInputSchema = z.object({
  cursor: cursorSchema,
  limit: limitSchema,
  statuses: z.array(z.enum(RUN_STATUSES)).min(1).max(RUN_STATUSES.length)
    .optional(),
  toolKey: toolKeySchema.optional(),
  acceptedAfter: isoTimestampSchema.optional(),
  acceptedBefore: isoTimestampSchema.optional(),
}).strict();

export const getRunInputSchema = z.object({
  runId: runIdSchema,
}).strict();

export const cancelRunInputSchema = getRunInputSchema;

const newArtifactTargetSchema = z.object({
  kind: z.literal("new_artifact"),
  name: z.string().min(1).max(255),
  mediaKind: z.string().min(1).max(64),
  retentionPolicyId: z.string().min(1).max(255).nullable().optional(),
}).strict();

const newVersionTargetSchema = z.object({
  kind: z.literal("new_version"),
  artifactId: artifactIdSchema,
}).strict();

export const createArtifactUploadInputSchema = z.object({
  target: z.discriminatedUnion("kind", [
    newArtifactTargetSchema,
    newVersionTargetSchema,
  ]),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().min(1).max(255),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentMd5: z.string().regex(/^[A-Za-z0-9+/]{22}==$/),
  width: z.number().int().positive().nullable().optional(),
  height: z.number().int().positive().nullable().optional(),
  durationMs: z.number().int().positive().nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sourceRunId: runIdSchema.nullable().optional(),
}).strict();

export const completeArtifactUploadInputSchema = z.object({
  uploadId: artifactUploadIdSchema,
}).strict();

export const listArtifactsInputSchema = z.object({
  cursor: cursorSchema,
  limit: limitSchema,
  mediaKind: z.string().max(64).optional(),
  sourceRunId: runIdSchema.optional(),
  shared: z.boolean().optional(),
  search: z.string().min(1).max(100).optional(),
}).strict();

export const getArtifactInputSchema = z.object({
  artifactId: artifactIdSchema,
}).strict();

export const createShareLinkInputSchema = z.object({
  artifactId: artifactIdSchema,
  followCurrent: z.boolean(),
  artifactVersionId: artifactVersionIdSchema.nullable().optional(),
  expiresAt: isoTimestampSchema.nullable().optional(),
  maxResolutions: z.number().int().positive().nullable().optional(),
  requireAuth: z.boolean().optional(),
  contentDisposition: z.enum(["attachment", "inline"]),
}).strict();

export const revokeShareLinkInputSchema = z.object({
  artifactId: artifactIdSchema,
  shareLinkId: shareLinkIdSchema,
}).strict();

export const executableToolResultSchema = z.object({
  runId: runIdSchema,
  status: z.enum(RUN_STATUSES),
  replayed: z.boolean(),
  queueReason: z.enum([
    "awaiting_dispatch",
    "capacity_wait",
    "retry_backoff",
  ]).nullable(),
  reservation: z.object({
    metric: z.string().min(1).max(128),
    unit: z.string().min(1).max(128),
    amount: z.string(),
    status: z.enum(["active", "committed", "released", "expired"]),
    expiresAt: isoTimestampSchema,
  }).strict().nullable(),
  statusTool: z.literal("relay.runs.get"),
}).strict();
