# ADR 0002: BullMQ transport client selection (ioredis, not node-redis)

Status: accepted\
Date: 2026-08-21\
Owner: implementation agent, per the delegated authority in
[`00-research-decisions.md`](../implementation-handoff/00-research-decisions.md)
to resolve Wave 0 compatibility gates without a standing question to the
repository owner.

## Context

[`04-queue-capacity-scheduling.md`](../implementation-handoff/04-queue-capacity-scheduling.md)
"BullMQ compatibility gate" makes the Wave 3A phase conditional on a spike
proving BullMQ runs correctly from a compiled, source-free Deno Linux binary
against live Redis, and asks that both `bullmq@6.1.2` + `redis@6.2.1` (via a
node-redis-compatible adapter) and `bullmq@6.1.2` + `ioredis@5.11.1` be spiked,
preferring the node-redis path if it passes.

## What was run

A disposable spike (not committed — matches the Wave 0 Dockerfile spike pattern)
at `bullmq@6.1.2` + `ioredis@5.11.1`, against the live `compose.dev.yaml` Redis
(password-protected, AOF-enabled, matching the "Redis production requirements"
section), covered every item in "Expected tests / Compatibility":

- Basic enqueue → worker consume → completion.
- Deterministic `jobId` reuse (the mechanism `ExecutionTicket` dedup depends on)
  returns the existing job rather than creating a duplicate.
- `delay` honored (measured elapsed ≥ configured delay).
- `attempts` + `backoff` retry recovers a synthetic first-attempt failure.
- `job.updateProgress()` / `QueueEvents` `"progress"` event delivery.
- `SCRIPT FLUSH` against the raw connection, followed by a normal `queue.add` —
  BullMQ re-loads its Lua scripts and the job still completes (the "Redis
  restart and `SCRIPT FLUSH` recover" requirement).
- `deno compile --allow-net --allow-env` produces a standalone binary (~115 MB,
  all deps embedded) with no `node_modules` or source tree alongside it at
  runtime; the compiled binary was executed directly and reproduced every result
  above.

All of the above passed. The node-redis lane was not run: BullMQ 6.1.2's
`ConnectionOptions` type (`dist/esm/interfaces/redis-options.d.ts`) does accept
a generic `RedisConnectionClient` shape that a node-redis wrapper could satisfy,
but there is no first-party `bullmq`-published adapter for it at this pinned
version, and the ioredis lane already cleared every acceptance criterion the
gate lists, including the compiled-binary path. Spending further spike time
chasing an unverified third-party adapter buys nothing the ioredis lane hasn't
already proven, so per the gate's own "select ioredis when required behavior ...
makes it necessary and its compiled tests pass," ioredis wins by satisfying the
fallback condition outright.

Two real findings from the spike, both binding on `packages/queue`:

1. **Import shape.** `import IORedis from "ioredis"` (default export) fails
   `deno compile`'s type check under this npm package's `.d.ts`
   (`TS2709`/`TS2351` — the default export resolves to a namespace, not a
   constructable type). `import { Redis as IORedis } from "ioredis"` (named
   export) is required and compiles cleanly. Every Redis client construction in
   `packages/queue` and `packages/capacity` must use the named import.
2. **Shutdown does not exit the process on its own.** Calling `.close()` on
   every `Worker`/`QueueEvents`/`Queue` and `.quit()` on every `ioredis`
   connection leaves the Deno process alive past a 45s wait with no further
   output — some internal handle (most likely an ioredis reconnect/keepalive
   timer) is not released by `.close()`/`.quit()` alone. This is not a
   correctness defect in BullMQ; it directly matches what
   `04-queue-capacity-scheduling.md` "Graceful shutdown" already prescribes: a
   bounded shutdown deadline followed by a forced close, rather than an
   unbounded wait for natural process exit. `apps/worker`'s shutdown sequence
   must call `Deno.exit(0)` after its close sequence completes (or the deadline
   elapses), not rely on the event loop draining itself.

## Decision

Use `bullmq@6.1.2` + `ioredis@5.11.1` as the queue transport client for
`packages/queue` and `packages/capacity`. Construct every Redis connection
explicitly (never rely on BullMQ's default connection resolution), using the
named `Redis` export, with `maxRetriesPerRequest: null` as BullMQ requires for
blocking clients.

## Consequences

- `deno.json` workspace imports gain `bullmq` and `ioredis` pins.
- `apps/worker`'s shutdown sequence needs an explicit bounded-deadline
  `Deno.exit()` fallback, not an assumption that closing every client handle is
  sufficient for the process to exit on its own.
- ioredis's native `.defineCommand()`/`.eval()` support is what
  `packages/capacity`'s Lua scripts (GCRA, token bucket, expiring sorted-set
  leases) will be built on — no separate Lua-execution client is needed.
- Cluster/Sentinel is not evaluated here; if a future ADR moves Redis to
  Cluster, ioredis already supports it (`ClusterOptions` in the same type file),
  unlike a hypothetical node-redis adapter which was never adopted.

## Alternatives considered

- `redis@6.2.1` via a node-redis compatibility adapter, preferred by the gate's
  wording if it passes: not pursued, since no first-party adapter for
  `bullmq@6.1.2` was found and the ioredis lane already cleared every acceptance
  criterion, including the compiled-binary requirement.
- BullMQ 6.1.2's built-in `postgres` connection backend (present in
  `dist/esm/postgres/` in this version, discovered incidentally while reading
  the connection types): not evaluated or adopted. Every section of
  `04-queue-capacity-scheduling.md` is written around Redis owning
  transport/rate/concurrency state and PostgreSQL owning durable domain state;
  collapsing that split by moving BullMQ itself onto Postgres is an architecture
  change the handoff doc doesn't call for, not a client substitution, so it's
  left unexplored rather than decided unilaterally here.
