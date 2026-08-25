import { Redis } from "ioredis";
import type { RedisConfig } from "@relay/config";

export type { Redis };

/**
 * Named import required, not `import IORedis from "ioredis"` -- the
 * default export fails `deno compile`'s type check under this package's
 * `.d.ts` (see docs/adr/0002-bullmq-redis-client-selection.md). Every
 * Redis connection in the queue/capacity packages goes through this
 * factory so that gotcha only has to be worked around once.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ for blocking
 * clients (Workers, QueueEvents); a general-purpose script-running
 * connection (capacity coordinator) also passes here since it issues no
 * blocking commands and the setting is harmless for it.
 */
export function createRedisConnection(
  config: RedisConfig,
  connectionName: string,
): Redis {
  return new Redis(config.url.toString(), {
    connectTimeout: config.connectTimeoutMs,
    maxRetriesPerRequest: null,
    connectionName,
  });
}
