import type { Redis } from "@relay/queue";
import {
  acquireLease,
  type AcquireLeaseResult,
  defineLeaseCommands,
  type LeaseClient,
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

/**
 * "Execution lease checks": global tool active limit, capacity-pool /
 * provider active limit, workspace-total active limit, workspace-tool
 * active limit. Scheduling-class share limiting is a fair-scheduler
 * concern layered on top of this, not implemented here yet.
 */
export interface ExecutionLeaseLimits {
  readonly globalTool: number;
  readonly pool: number;
  readonly workspaceTotal: number;
  readonly workspaceTool: number;
}

export interface AcquiredExecutionLease extends AcquireLeaseResult {
  readonly scopeKeys: readonly string[];
}

/**
 * Domain interface over Redis, per "Capacity coordinator": "Expose a
 * domain interface rather than Redis keys." Callers (the worker's job
 * dispatcher) never see key names or Lua; they pass tool/workspace/pool
 * identifiers and limits sourced from `relay.capacity_pools` /
 * `relay.capacity_policies`.
 *
 * Scope: unweighted concurrency (each lease occupies exactly one slot
 * per scope). `relay.execution_capacity_leases.units` for weighted/
 * variable-cost concurrency is not implemented yet -- every acquisition
 * here costs 1 unit regardless of the job's actual estimated cost.
 */
export class CapacityCoordinator {
  private readonly leaseClient: LeaseClient;
  private readonly rateClient: RateLimitClient;
  private readonly cooldownClient: CooldownClient;

  constructor(
    connection: Redis,
    private readonly config: CapacityCoordinatorConfig,
  ) {
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
  ): Promise<AcquiredExecutionLease> {
    const scopeKeys = this.executionScopeKeys(scope);
    const scopeLimits = [
      limits.globalTool,
      limits.pool,
      limits.workspaceTotal,
      limits.workspaceTool,
    ];
    const result = await acquireLease(
      this.leaseClient,
      scopeKeys,
      scopeLimits,
      this.config.leaseDurationMs,
    );
    return { ...result, scopeKeys };
  }

  async renewExecutionLease(
    scopeKeys: readonly string[],
    leaseId: string,
  ): Promise<{ ok: boolean; expiresAt?: number; blockedScopeIndex?: number }> {
    return await renewLease(
      this.leaseClient,
      scopeKeys,
      leaseId,
      this.config.leaseDurationMs,
    );
  }

  async releaseExecutionLease(
    scopeKeys: readonly string[],
    leaseId: string,
  ): Promise<void> {
    await releaseLease(this.leaseClient, scopeKeys, leaseId);
  }

  /**
   * "Submission permit checks": global tool start rate, provider/model
   * request rate, provider cooldown, weighted cost/token limits when
   * applicable. `checks` supplies the GCRA-limited rate keys (tool/
   * provider/token-weighted, as the caller's policy requires); this
   * coordinator always folds in the pool's cooldown key so a caller
   * cannot forget to check it.
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

  async setProviderCooldown(
    poolId: string,
    expiresAtMs: number,
  ): Promise<boolean> {
    return await setProviderCooldown(
      this.cooldownClient,
      cooldownKey(this.config.env, poolId),
      expiresAtMs,
    );
  }

  /**
   * Read-only snapshot of current occupancy across the given scope keys,
   * purging expired entries first for accuracy. Not a single atomic Lua
   * script like the others above (it spans a variable, caller-chosen set
   * of scope keys purely for reporting), so it fetches Redis's own `TIME`
   * as a distinct round trip rather than trusting a caller-supplied clock
   * -- same reasoning as `ACQUIRE_SCRIPT` in leases.ts, just not
   * script-internal here.
   */
  async inspectCapacity(
    scopeKeys: readonly string[],
  ): Promise<Readonly<Record<string, number>>> {
    const [seconds, microseconds] = await this.leaseClient.time();
    const nowMs = Number(seconds) * 1000 +
      Math.floor(Number(microseconds) / 1000);
    const pipeline = this.leaseClient.pipeline();
    for (const key of scopeKeys) {
      pipeline.zremrangebyscore(key, "-inf", nowMs);
      pipeline.zcard(key);
    }
    const results = await pipeline.exec();
    if (results === null) {
      throw new Error("inspectCapacity pipeline returned no results");
    }

    const counts: Record<string, number> = {};
    scopeKeys.forEach((key, index) => {
      const [error, count] = results[index * 2 + 1];
      if (error) throw error;
      counts[key] = Number(count);
    });
    return counts;
  }

  rateKeys = {
    tool: (toolKey: string): string => rateToolKey(this.config.env, toolKey),
    provider: (providerModelId: string): string =>
      rateProviderKey(this.config.env, providerModelId),
  };
}
