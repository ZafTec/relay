import type { DatabasePool } from "@relay/database";
import type { ExecutionTicket } from "./tickets.ts";

/**
 * "Worker claim and fencing" from
 * docs/implementation-handoff/04-queue-capacity-scheduling.md. This
 * module implements the PostgreSQL-side half of that section (claim,
 * defer, heartbeat) -- everything up to "acquire Redis execution
 * capacity" and "persist attempt/submission intent before provider
 * interaction". It deliberately stops there: what happens after a
 * capacity lease is acquired (the actual provider call and its outcome)
 * depends on the Wave 3B tool/provider contract, which doesn't exist
 * yet. `packages/capacity`'s `CapacityCoordinator` supplies the Redis
 * side; a caller composes the two once there's a provider to invoke.
 */

export interface ClaimedJob {
  readonly jobId: string;
  readonly runId: string;
  readonly leaseEpoch: number;
  readonly attemptNumber: number;
  readonly attemptId: string;
}

export type ClaimResult =
  | { readonly kind: "claimed"; readonly job: ClaimedJob }
  /** Already terminal, already claimed by a newer generation, or not actually queued -- BullMQ redelivery lands here safely. */
  | { readonly kind: "no_op" };

/**
 * Step 2-4 of "Worker claim and fencing": conditionally claim the job
 * (only if it's still `queued` at the ticket's own
 * `dispatch_generation` -- a stale or duplicate ticket delivery affects
 * zero rows), incrementing the monotonic `lease_epoch` in the same
 * statement. Step 6 (persist attempt/submission intent) happens in the
 * same transaction so a crash between the two can never leave a claimed
 * job with no attempt row.
 */
export async function claimJobForDispatch(
  pool: DatabasePool,
  ticket: ExecutionTicket,
  leaseOwner: string,
  leaseDurationMs: number,
): Promise<ClaimResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const claim = await client.query<
        {
          id: string;
          run_id: string;
          lease_epoch: string;
          attempt_count: number;
        }
      >(
        `update relay.execution_jobs
           set status = 'running',
               lease_epoch = lease_epoch + 1,
               lease_owner = $2,
               lease_expires_at = now() + ($3 || ' milliseconds')::interval,
               attempt_count = attempt_count + 1,
               state_version = state_version + 1
         where id = $1
           and dispatch_generation = $4
           and status = 'queued'
         returning id, run_id, lease_epoch, attempt_count`,
        [
          ticket.domainJobId,
          leaseOwner,
          leaseDurationMs,
          ticket.dispatchGeneration,
        ],
      );

      if (claim.rows.length === 0) {
        await client.query("rollback");
        return { kind: "no_op" };
      }

      const row = claim.rows[0];
      const attempt = await client.query<{ id: string }>(
        `insert into relay.job_attempts (job_id, attempt_number, lease_epoch, submission_state)
         values ($1, $2, $3, 'pending')
         returning id`,
        [row.id, row.attempt_count, row.lease_epoch],
      );

      await client.query("commit");
      return {
        kind: "claimed",
        job: {
          jobId: row.id,
          runId: row.run_id,
          leaseEpoch: Number(row.lease_epoch),
          attemptNumber: row.attempt_count,
          attemptId: attempt.rows[0].id,
        },
      };
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

/**
 * "Every state mutation from a worker must present the expected
 * epoch/owner" -- shared by every fenced update below. Returns whether
 * exactly one row matched; zero means a newer lease already superseded
 * this caller (recovery, expiry, or another worker), and the caller
 * must not proceed as if it still owned the job.
 */
async function fencedUpdate(
  pool: DatabasePool,
  sqlText: string,
  params: readonly unknown[],
): Promise<boolean> {
  const { rowCount } = await pool.query(sqlText, params as unknown[]);
  return rowCount === 1;
}

export async function heartbeatJob(
  pool: DatabasePool,
  jobId: string,
  leaseEpoch: number,
  leaseOwner: string,
  leaseDurationMs: number,
): Promise<boolean> {
  return await fencedUpdate(
    pool,
    `update relay.execution_jobs
       set lease_expires_at = now() + ($4 || ' milliseconds')::interval
     where id = $1 and lease_epoch = $2 and lease_owner = $3 and status = 'running'`,
    [jobId, leaseEpoch, leaseOwner, leaseDurationMs],
  );
}

/**
 * "Capacity deferral": no provider call happens, any partial lease is
 * already released by the caller before this is invoked, and the job
 * returns to `queued` through a fenced transition with a bumped
 * `dispatch_generation` -- so the BullMQ ticket that led to this claim
 * can never re-claim the job if it's redelivered, only a *new* ticket
 * for the new generation can. `deferral_count` increments, not
 * `attempt_count`: capacity waiting is not an attempt. A fresh outbox
 * `job.deferred` event lets the relay publish a new ticket once
 * `eligibleAt` arrives.
 */
export async function deferJob(
  pool: DatabasePool,
  jobId: string,
  runId: string,
  leaseEpoch: number,
  leaseOwner: string,
  eligibleAt: Date,
  reason: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const { rowCount } = await client.query(
        `update relay.execution_jobs
           set status = 'queued',
               dispatch_generation = dispatch_generation + 1,
               deferral_count = deferral_count + 1,
               eligible_at = $4,
               lease_owner = null,
               lease_expires_at = null,
               state_version = state_version + 1
         where id = $1 and lease_epoch = $2 and lease_owner = $3 and status = 'running'`,
        [jobId, leaseEpoch, leaseOwner, eligibleAt],
      );

      if (rowCount !== 1) {
        await client.query("rollback");
        return false;
      }

      await client.query(
        `insert into relay.outbox_events
           (aggregate_type, aggregate_id, aggregate_version, event_type, payload)
         values ('execution_job', $1, 1, 'job.deferred', $2)`,
        [jobId, JSON.stringify({ domainJobId: jobId, runId, reason })],
      );

      await client.query("commit");
      return true;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}
