import type { Redis } from "ioredis";
import {
  acquireLease,
  type AcquireLeaseResult,
  defineLeaseCommands,
  inspectLeaseUnits,
  type LeaseClient,
  type LeaseHandle,
  type LeaseRequest,
  releaseLease,
  renewLease,
} from "./leases.ts";
import {
  type AcquirePermitResult,
  acquireSubmissionPermit,
  defineRateLimitCommands,
  type RateLimitCheck,
  type RateLimitClient,
} from "./rate-limit.ts";
import {
  type CooldownClient,
  defineCooldownCommands,
  setProviderCooldown,
} from "./cooldown.ts";
import {
  activePoolKey,
  activeToolKey,
  activeWorkspaceKey,
  activeWorkspaceToolKey,
  cooldownKey,
  executionLeaseJobKey,
  rateProviderKey,
  rateToolKey,
} from "./keys.ts";

export interface CapacityCoordinatorConfig {
  readonly env: string;
  readonly leaseDurationMs: number;
}

export interface ExecutionLeaseScope {
  readonly toolKey: string;
  readonly workspaceId: string;
  readonly poolId: string;
}

/** Limits and occupancy are weighted execution units, not lease counts. */
export interface ExecutionLeaseLimits {
  readonly globalTool: number;
  readonly pool: number;
  readonly workspaceTotal: number;
  readonly workspaceTool: number;
}

export type ExecutionLeaseRequest = LeaseRequest;
export type ExecutionLease = LeaseHandle;

export type AcquireExecutionLeaseResult =
  | {
    readonly ok: true;
    readonly lease: ExecutionLease;
    readonly reused: boolean;
  }
  | (Extract<AcquireLeaseResult, { readonly ok: false }> & {
    readonly scopeKeys: readonly string[];
  });

/**
 * Domain interface over Redis. Execution leases are weighted and fenced by the
 * durable job identity (`jobId`, `leaseEpoch`) plus the worker `ownerId` and an
 * unguessable lease ID. Renew/release therefore cannot be performed by a stale
 * owner, and a newer epoch atomically supersedes an older active lease.
 */
export class CapacityCoordinator {
  private readonly leaseClient: LeaseClient;
  private readonly rateClient: RateLimitClient;
  private readonly cooldownClient: CooldownClient;

  constructor(
    connection: Redis,
    private readonly config: CapacityCoordinatorConfig,
  ) {
    if (config.env.length === 0) throw new Error("env must not be empty");
    if (
      !Number.isSafeInteger(config.leaseDurationMs) ||
      config.leaseDurationMs <= 0
    ) {
      throw new Error("leaseDurationMs must be a positive safe integer");
    }
    this.leaseClient = defineLeaseCommands(connection);
    this.rateClient = defineRateLimitCommands(connection);
    this.cooldownClient = defineCooldownCommands(connection);
  }

  private executionScopeKeys(scope: ExecutionLeaseScope): readonly string[] {
    return [
      activeToolKey(this.config.env, scope.toolKey),
      activePoolKey(this.config.env, scope.poolId),
      activeWorkspaceKey(this.config.env, scope.workspaceId),
      activeWorkspaceToolKey(this.config.env, scope.workspaceId, scope.toolKey),
    ];
  }

  async acquireExecutionLease(
    scope: ExecutionLeaseScope,
    limits: ExecutionLeaseLimits,
    request: ExecutionLeaseRequest,
  ): Promise<AcquireExecutionLeaseResult> {
    const scopeKeys = this.executionScopeKeys(scope);
    const jobKey = executionLeaseJobKey(this.config.env, request.jobId);
    const result = await acquireLease(
      this.leaseClient,
      jobKey,
      scopeKeys,
      [
        limits.globalTool,
        limits.pool,
        limits.workspaceTotal,
        limits.workspaceTool,
      ],
      this.config.leaseDurationMs,
      request,
    );

    if (!result.ok) return { ...result, scopeKeys };
    return {
      ok: true,
      reused: result.reused,
      lease: {
        ...request,
        leaseId: result.leaseId,
        expiresAt: result.expiresAt,
        jobKey,
        scopeKeys,
      },
    };
  }

  async renewExecutionLease(
    lease: ExecutionLease,
  ): Promise<
    { readonly ok: true; readonly lease: ExecutionLease } | {
      readonly ok: false;
      readonly missingScopeIndex?: number;
    }
  > {
    const result = await renewLease(
      this.leaseClient,
      lease,
      this.config.leaseDurationMs,
    );
    if (!result.ok) return result;
    return { ok: true, lease: { ...lease, expiresAt: result.expiresAt } };
  }

  /** Returns false when the caller's owner/job/epoch/lease fence is stale. */
  async releaseExecutionLease(lease: ExecutionLease): Promise<boolean> {
    return await releaseLease(this.leaseClient, lease);
  }

  /**
   * GCRA checks and the provider cooldown are one all-or-none script. Callers
   * supply only server-resolved rate policy; Redis `TIME` supplies the clock.
   */
  async acquireSubmissionPermit(
    poolId: string,
    checks: readonly RateLimitCheck[],
  ): Promise<AcquirePermitResult> {
    return await acquireSubmissionPermit(
      this.rateClient,
      checks,
      [cooldownKey(this.config.env, poolId)],
    );
  }

  /** Extend the pool cooldown by a relative duration measured from Redis time. */
  async setProviderCooldown(
    poolId: string,
    durationMs: number,
  ): Promise<boolean> {
    return await setProviderCooldown(
      this.cooldownClient,
      cooldownKey(this.config.env, poolId),
      durationMs,
    );
  }

  /** Atomic, Redis-time-based weighted occupancy after expired-lease cleanup. */
  async inspectCapacity(
    scopeKeys: readonly string[],
  ): Promise<Readonly<Record<string, number>>> {
    return await inspectLeaseUnits(this.leaseClient, scopeKeys);
  }

  rateKeys = {
    tool: (toolKey: string): string => rateToolKey(this.config.env, toolKey),
    provider: (providerModelId: string): string =>
      rateProviderKey(this.config.env, providerModelId),
  };
}
