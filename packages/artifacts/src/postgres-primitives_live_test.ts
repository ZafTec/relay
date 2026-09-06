import { assertEquals } from "@std/assert";
import pg from "pg";
import type { ArtifactQueryable } from "./database.ts";
import {
  PostgresArtifactMutationIdempotencyRepository,
} from "./idempotency.ts";
import {
  type ArtifactStorageLimitProvider,
  PostgresArtifactQuota,
} from "./postgres-quota.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const runLive = databaseUrl !== undefined &&
  Deno.env.get("RUN_ARTIFACT_CONTRACT_TESTS") === "1";

type PgPool = InstanceType<typeof pg.Pool>;
type PgClient = InstanceType<typeof pg.PoolClient>;

function testPool(): PgPool {
  return new pg.Pool({
    connectionString: databaseUrl!,
    max: 5,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
  });
}

function unique(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function createWorkspace(
  pool: PgPool,
  workspaceId: string,
  actorUserId: string,
): Promise<void> {
  await pool.query(
    `insert into auth."user" (id, name, email, "emailVerified")
     values ($1, 'Artifact primitive fixture', $2, true)`,
    [actorUserId, `${unique("artifact-primitive")}@example.test`],
  );
  await pool.query(
    `insert into auth.organization (id, name, slug, "createdAt")
     values ($1, 'Artifact primitive fixture', $2, now())`,
    [workspaceId, unique("artifact-primitive")],
  );
}

async function inTransaction<T>(
  pool: PgPool,
  operation: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    try {
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  } finally {
    client.release();
  }
}

Deno.test({
  name:
    "artifact mutation idempotency serializes concurrent claims and stores references only",
  ignore: !runLive,
  fn: async () => {
    const pool = testPool();
    const workspaceId = unique("org_artifact_idempotency");
    const actorUserId = unique("user_artifact_idempotency");
    const repository = new PostgresArtifactMutationIdempotencyRepository();
    const idempotencyKey = unique("client-key");
    const request = {
      artifactId: unique("art"),
      token: "plaintext-share-token-must-not-be-stored",
      uploadUrl: "https://storage.example.test/signed-secret",
    };
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();

    try {
      await createWorkspace(pool, workspaceId, actorUserId);
      await firstClient.query("begin");
      await secondClient.query("begin");

      const first = await repository.claim(firstClient, {
        workspaceId,
        actorUserId,
        operation: "create_share",
        idempotencyKey,
        request,
      });
      if (first.kind !== "claimed") throw new Error("expected first claim");

      const replayPromise = repository.claim(secondClient, {
        workspaceId,
        actorUserId,
        operation: "create_share",
        idempotencyKey,
        request,
      });
      await repository.complete(firstClient, first.claim, {
        kind: "share_link",
        shareLinkId: unique("share"),
      });
      await firstClient.query("commit");

      const replay = await replayPromise;
      assertEquals(replay.kind, "replay");
      await secondClient.query("commit");

      const conflict = await inTransaction(
        pool,
        (client) =>
          repository.claim(client, {
            workspaceId,
            actorUserId,
            operation: "create_share",
            idempotencyKey,
            request: { ...request, artifactId: unique("art") },
          }),
      );
      assertEquals(conflict, { kind: "conflict" });

      const stored = await pool.query<{ document: string }>(
        `select pg_catalog.row_to_json(i)::text as document
           from relay.artifact_mutation_idempotency i
          where workspace_id = $1`,
        [workspaceId],
      );
      assertEquals(stored.rows.length, 1);
      assertEquals(stored.rows[0].document.includes(idempotencyKey), false);
      assertEquals(stored.rows[0].document.includes(request.token), false);
      assertEquals(stored.rows[0].document.includes(request.uploadUrl), false);
    } finally {
      try {
        await firstClient.query("rollback");
      } catch {
        // The transaction may already be committed.
      }
      try {
        await secondClient.query("rollback");
      } catch {
        // The transaction may already be committed.
      }
      firstClient.release();
      secondClient.release();
      await pool.end();
    }
  },
});

Deno.test({
  name:
    "artifact quota serializes concurrent reservations and settles every transition once",
  ignore: !runLive,
  fn: async () => {
    const pool = testPool();
    const workspaceId = unique("org_artifact_quota");
    const actorUserId = unique("user_artifact_quota");
    const limitProvider: ArtifactStorageLimitProvider = {
      getLimit: () => Promise.resolve({ kind: "limited", maxBytes: "10" }),
    };
    const quota = new PostgresArtifactQuota({ limitProvider });

    try {
      await createWorkspace(pool, workspaceId, actorUserId);
      const outcomes = await Promise.all([
        inTransaction(
          pool,
          (client) =>
            quota.reserve(client as ArtifactQueryable, {
              workspaceId,
              operationId: unique("upload"),
              bytes: 7,
            }),
        ),
        inTransaction(
          pool,
          (client) =>
            quota.reserve(client as ArtifactQueryable, {
              workspaceId,
              operationId: unique("upload"),
              bytes: 7,
            }),
        ),
      ]);
      assertEquals(
        outcomes.map((result) => result.kind).sort(),
        ["denied", "reserved"],
      );
      const winner = outcomes.find((result) => result.kind === "reserved");
      if (winner?.kind !== "reserved") throw new Error("expected reservation");

      const committed = {
        workspaceId,
        reservationId: winner.reservationId,
        bytes: 7,
      };
      await inTransaction(pool, async (client) => {
        await quota.commit(client, committed);
      });
      await inTransaction(pool, async (client) => {
        await quota.commit(client, committed);
      });

      const releasedReservation = await inTransaction(
        pool,
        (client) =>
          quota.reserve(client, {
            workspaceId,
            operationId: unique("upload"),
            bytes: 3,
          }),
      );
      if (releasedReservation.kind !== "reserved") {
        throw new Error("expected release fixture reservation");
      }
      const released = {
        workspaceId,
        reservationId: releasedReservation.reservationId,
        bytes: 3,
      };
      await inTransaction(pool, async (client) => {
        await quota.release(client, released);
      });
      await inTransaction(pool, async (client) => {
        await quota.release(client, released);
      });

      const decremented = {
        ...committed,
        operationId: unique("purge"),
      };
      await inTransaction(pool, async (client) => {
        await quota.decrementCommitted(client, decremented);
      });
      await inTransaction(pool, async (client) => {
        await quota.decrementCommitted(client, decremented);
      });

      const account = await pool.query<{
        committed_bytes: string;
        reserved_bytes: string;
      }>(
        `select committed_bytes::text, reserved_bytes::text
           from relay.artifact_storage_accounts
          where workspace_id = $1`,
        [workspaceId],
      );
      assertEquals(account.rows, [{
        committed_bytes: "0",
        reserved_bytes: "0",
      }]);
    } finally {
      await pool.end();
    }
  },
});
