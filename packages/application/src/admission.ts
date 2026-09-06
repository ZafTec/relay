import type { HandlerRegistry } from "@relay/catalog";
import {
  type CreateRunRequest,
  createRunRequestSchema,
  type CreateRunResult,
  createRunResultSchema,
  PUBLIC_ID_PATTERNS,
} from "@relay/contracts";
import type { DatabasePool } from "@relay/database";
import {
  type AdmissionUsagePort,
  type AdmissionUsageQuote,
  type AdmissionUsageRequest,
  admitToolRun,
} from "@relay/queue";
import type { WorkspaceActorContext } from "./context.ts";
import {
  validateIdempotencyKey,
  validateWorkspaceActorContext,
} from "./context.ts";
import type { RunAdmissionApplicationService } from "./services.ts";
import { loadRunDetail } from "./postgres/runs.ts";

export interface RunAdmissionPolicy {
  readonly admissionDeadlineMs: number;
  readonly runDeadlineMs: number | null;
}

export interface RunAdmissionAdapterOptions extends RunAdmissionPolicy {
  readonly pool: DatabasePool;
  readonly handlers: HandlerRegistry;
  readonly usage: AdmissionUsagePort;
}

const MAX_DEADLINE_MS = 30 * 24 * 60 * 60 * 1_000;

function positiveDeadline(value: number, field: string): number {
  if (
    !Number.isSafeInteger(value) || value < 1 || value > MAX_DEADLINE_MS
  ) {
    throw new RangeError(`${field} must be between 1 and ${MAX_DEADLINE_MS}`);
  }
  return value;
}

export function requireMeteredAdmissionUsagePort(
  usage: AdmissionUsagePort,
): AdmissionUsagePort {
  if (
    usage === undefined || usage === null ||
    typeof usage.quote !== "function" ||
    typeof usage.reserve !== "function"
  ) {
    throw new TypeError("an AdmissionUsagePort is required");
  }
  return Object.freeze({
    quote(
      client: Parameters<AdmissionUsagePort["quote"]>[0],
      request: AdmissionUsageRequest,
    ): ReturnType<AdmissionUsagePort["quote"]> {
      return usage.quote(client, request);
    },
    async reserve(
      client: Parameters<AdmissionUsagePort["reserve"]>[0],
      request: AdmissionUsageRequest,
      quote: AdmissionUsageQuote,
    ): ReturnType<AdmissionUsagePort["reserve"]> {
      const reservation = await usage.reserve(client, request, quote);
      if (reservation !== null && typeof reservation !== "string") {
        return reservation;
      }
      if (
        reservation === null ||
        !PUBLIC_ID_PATTERNS.usageReservation.test(reservation)
      ) {
        return { kind: "usage_unavailable", reason: "invalid_configuration" };
      }
      return reservation;
    },
  });
}

export class RunAdmissionAdapter implements RunAdmissionApplicationService {
  readonly #pool: DatabasePool;
  readonly #handlers: HandlerRegistry;
  readonly #usage: AdmissionUsagePort;
  readonly #policy: RunAdmissionPolicy;

  constructor(options: RunAdmissionAdapterOptions) {
    if (
      options.handlers === undefined || options.handlers === null ||
      typeof options.handlers.get !== "function" ||
      typeof options.handlers.isCompatible !== "function"
    ) {
      throw new TypeError("a HandlerRegistry is required");
    }
    this.#pool = options.pool;
    this.#handlers = options.handlers;
    this.#usage = requireMeteredAdmissionUsagePort(options.usage);
    this.#policy = {
      admissionDeadlineMs: positiveDeadline(
        options.admissionDeadlineMs,
        "admissionDeadlineMs",
      ),
      runDeadlineMs: options.runDeadlineMs === null
        ? null
        : positiveDeadline(options.runDeadlineMs, "runDeadlineMs"),
    };
  }

  async create(
    rawContext: WorkspaceActorContext,
    rawRequest: CreateRunRequest,
    rawIdempotencyKey: string,
    expectedToolVersionId?: string,
  ): Promise<CreateRunResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const request = createRunRequestSchema.parse(rawRequest);
    const idempotencyKey = validateIdempotencyKey(rawIdempotencyKey);
    if (
      expectedToolVersionId !== undefined &&
      !PUBLIC_ID_PATTERNS.toolVersion.test(expectedToolVersionId)
    ) {
      throw new TypeError("expectedToolVersionId has an invalid format");
    }

    // Resolve the public key only after proving current membership. A missing
    // workspace and an inaccessible workspace are intentionally indistinguishable.
    const resolution = await this.#pool.query<{
      readonly member: boolean;
      readonly tool_version_id: string | null;
    }>(
      `select
         exists (
           select 1 from auth.member member
            where member."organizationId" = $1 and member."userId" = $2
         ) as member,
         (
           select tool.active_version_id
             from relay.tools tool
             join relay.tool_versions version
               on version.id = tool.active_version_id
            where tool.key = $3
              and ($4::text is null or tool.active_version_id = $4)
              and tool.visibility = 'public'
              and tool.lifecycle in ('published', 'deprecated')
              and version.published_at is not null
              and version.retired_at is null
         ) as tool_version_id`,
      [
        context.workspaceId,
        context.actorUserId,
        request.toolKey,
        expectedToolVersionId ?? null,
      ],
    );
    const resolved = resolution.rows[0];
    if (resolved?.member !== true) return { kind: "not_found" };
    if (resolved.tool_version_id === null) return { kind: "tool_unavailable" };

    const admitted = await admitToolRun(
      this.#pool,
      {
        workspaceId: context.workspaceId,
        toolVersionId: resolved.tool_version_id,
        createdBy: context.actorUserId,
        input: request.input,
        idempotencyKey,
        requestedModelVersion: request.requestedModelVersion ?? null,
        admissionDeadlineMs: this.#policy.admissionDeadlineMs,
        runDeadlineMs: this.#policy.runDeadlineMs,
      },
      { handlers: this.#handlers, usage: this.#usage },
    );

    switch (admitted.kind) {
      case "not_a_member":
        return { kind: "not_found" };
      case "tool_version_unavailable":
      case "no_provider_binding":
        return { kind: "tool_unavailable" };
      case "idempotency_conflict":
        return { kind: "idempotency_conflict" };
      case "not_entitled":
        return { kind: "not_entitled" };
      case "allowance_exceeded":
        return admitted;
      case "usage_unavailable":
        return admitted;
      case "queue_full":
        return { kind: "queue_full", scope: admitted.scope };
      case "admitted":
      case "replayed": {
        const current = await loadRunDetail(
          this.#pool,
          context,
          admitted.runId,
        );
        if (current.kind === "not_found") return current;
        if (current.run.reservation === null) {
          return { kind: "usage_unavailable", reason: "invalid_configuration" };
        }
        return createRunResultSchema.parse({
          kind: "accepted",
          run: current.run,
          replayed: admitted.kind === "replayed",
          queueReason: current.run.status === "queued"
            ? "awaiting_dispatch"
            : null,
        });
      }
    }
  }
}

export function createRunAdmissionAdapter(
  options: RunAdmissionAdapterOptions,
): RunAdmissionApplicationService {
  return new RunAdmissionAdapter(options);
}

export type { AdmissionUsagePort, HandlerRegistry };
