import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  ArtifactIdempotencyInvariantError,
  type ArtifactMutationClaim,
  type ArtifactMutationQueryExecutor,
  canonicalJson,
  fingerprintArtifactMutationRequest,
  hashArtifactMutationIdempotencyKey,
  PostgresArtifactMutationIdempotencyRepository,
} from "./idempotency.ts";

interface QueryCall {
  readonly text: string;
  readonly params: unknown[];
}

class ScriptedExecutor implements ArtifactMutationQueryExecutor {
  readonly calls: QueryCall[] = [];
  readonly #responses: unknown[][];

  constructor(responses: unknown[][]) {
    this.#responses = [...responses];
  }

  query<Row>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: Row[] }> {
    this.calls.push({ text, params });
    const rows = this.#responses.shift();
    if (rows === undefined) throw new Error(`Unexpected query: ${text}`);
    return Promise.resolve({ rows: rows as Row[] });
  }
}

function completedRow(input: {
  workspaceId: string;
  actorUserId: string;
  operation: string;
  keyHash: string;
  fingerprint: string;
  response: unknown;
}) {
  return {
    workspace_id: input.workspaceId,
    actor_user_id: input.actorUserId,
    operation: input.operation,
    idempotency_key_hash: input.keyHash,
    request_hash: input.fingerprint,
    response: input.response,
  };
}

Deno.test("canonical artifact JSON is stable and rejects non-JSON ambiguity", async () => {
  const left = {
    z: [3, { b: true, a: "x" }],
    a: 1,
    "10": "ten",
    "2": "two",
  };
  const right = {
    "2": "two",
    "10": "ten",
    a: 1,
    z: [3, { a: "x", b: true }],
  };
  const expected = '{"10":"ten","2":"two","a":1,"z":[3,{"a":"x","b":true}]}';
  assertEquals(canonicalJson(left), expected);
  assertEquals(canonicalJson(right), expected);
  assertEquals(canonicalJson({ value: -0 }), '{"value":0}');

  const first = await fingerprintArtifactMutationRequest("create_upload", left);
  const second = await fingerprintArtifactMutationRequest(
    "create_upload",
    right,
  );
  assertEquals(first, second);
  assertMatch(first, /^[0-9a-f]{64}$/);
  assertNotEquals(
    first,
    await fingerprintArtifactMutationRequest("complete_upload", right),
  );

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assertThrows(() => canonicalJson(cyclic), TypeError, "cycles");
  assertThrows(() => canonicalJson({ missing: undefined }), TypeError);
  assertThrows(() => canonicalJson({ value: Number.NaN }), TypeError, "finite");
  assertThrows(() => canonicalJson(new Date()), TypeError, "plain objects");
  assertThrows(() => canonicalJson(Array(1)), TypeError, "sparse");
});

Deno.test("idempotency key hashes are actor-scoped and domain separated", async () => {
  const base = {
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    operation: "create_share" as const,
    idempotencyKey: "request-key-0001",
  };
  const first = await hashArtifactMutationIdempotencyKey(base);
  assertEquals(first, await hashArtifactMutationIdempotencyKey(base));
  assertMatch(first, /^[0-9a-f]{64}$/);
  assertEquals(first.includes(base.idempotencyKey), false);
  assertNotEquals(
    first,
    await hashArtifactMutationIdempotencyKey({
      ...base,
      workspaceId: "workspace-2",
    }),
  );
  assertNotEquals(
    first,
    await hashArtifactMutationIdempotencyKey({
      ...base,
      actorUserId: "user-2",
    }),
  );
  assertNotEquals(
    first,
    await hashArtifactMutationIdempotencyKey({
      ...base,
      operation: "revoke_share",
    }),
  );
});

Deno.test("PostgreSQL idempotency claims send only hashes to storage", async () => {
  const executor = new ScriptedExecutor([[], []]);
  const repository = new PostgresArtifactMutationIdempotencyRepository();
  const rawKey = "raw-client-key-0001";
  const requestSecret = "must-not-be-persisted";
  const result = await repository.claim(executor, {
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    operation: "create_share",
    idempotencyKey: rawKey,
    request: { artifactId: "artifact-1", token: requestSecret },
  });

  assertEquals(result.kind, "claimed");
  if (result.kind !== "claimed") throw new Error("expected a claim");
  assertMatch(result.claim.idempotencyKeyHash, /^[0-9a-f]{64}$/);
  assertMatch(result.claim.requestFingerprint, /^[0-9a-f]{64}$/);
  assertEquals(executor.calls.length, 2);
  const databaseParameters = JSON.stringify(
    executor.calls.map((call) => call.params),
  );
  assertEquals(databaseParameters.includes(rawKey), false);
  assertEquals(databaseParameters.includes(requestSecret), false);
});

Deno.test("PostgreSQL idempotency distinguishes replay and conflict", async () => {
  const repository = new PostgresArtifactMutationIdempotencyRepository();
  const workspaceId = "workspace-1";
  const actorUserId = "user-1";
  const operation = "complete_upload" as const;
  const idempotencyKey = "complete-key-0001";
  const request = { uploadId: "upl_1" };
  const keyHash = await hashArtifactMutationIdempotencyKey({
    workspaceId,
    actorUserId,
    operation,
    idempotencyKey,
  });
  const fingerprint = await fingerprintArtifactMutationRequest(operation, {
    workspaceId,
    actorUserId,
    request,
  });

  const replayExecutor = new ScriptedExecutor([
    [],
    [completedRow({
      workspaceId,
      actorUserId,
      operation,
      keyHash,
      fingerprint,
      response: { kind: "artifact_upload", uploadId: "upl_1" },
    })],
  ]);
  assertEquals(
    await repository.claim(replayExecutor, {
      workspaceId,
      actorUserId,
      operation,
      idempotencyKey,
      request,
    }),
    {
      kind: "replay",
      reference: { kind: "artifact_upload", uploadId: "upl_1" },
    },
  );

  const conflictExecutor = new ScriptedExecutor([
    [],
    [completedRow({
      workspaceId,
      actorUserId,
      operation,
      keyHash,
      fingerprint: "0".repeat(64),
      response: { kind: "artifact_upload", uploadId: "upl_1" },
    })],
  ]);
  assertEquals(
    await repository.claim(conflictExecutor, {
      workspaceId,
      actorUserId,
      operation,
      idempotencyKey,
      request,
    }),
    { kind: "conflict" },
  );
});

Deno.test("PostgreSQL idempotency completion persists a typed reference only", async () => {
  const repository = new PostgresArtifactMutationIdempotencyRepository();
  const claim: ArtifactMutationClaim<"create_share"> = {
    workspaceId: "workspace-1",
    actorUserId: "user-1",
    operation: "create_share",
    idempotencyKeyHash: "1".repeat(64),
    requestFingerprint: "2".repeat(64),
  };
  const row = completedRow({
    workspaceId: claim.workspaceId,
    actorUserId: claim.actorUserId,
    operation: claim.operation,
    keyHash: claim.idempotencyKeyHash,
    fingerprint: claim.requestFingerprint,
    response: { kind: "share_link", shareLinkId: "share_1" },
  });

  const first = new ScriptedExecutor([[], [], [row]]);
  assertEquals(
    await repository.complete(first, claim, {
      kind: "share_link",
      shareLinkId: "share_1",
    }),
    {
      kind: "completed",
      reference: { kind: "share_link", shareLinkId: "share_1" },
    },
  );
  assertEquals(
    first.calls[2].params[5],
    '{"kind":"share_link","shareLinkId":"share_1"}',
  );

  const retry = new ScriptedExecutor([[], [row]]);
  assertEquals(
    await repository.complete(retry, claim, {
      kind: "share_link",
      shareLinkId: "share_1",
    }),
    {
      kind: "replay",
      reference: { kind: "share_link", shareLinkId: "share_1" },
    },
  );

  const conflict = new ScriptedExecutor([[], [row]]);
  assertEquals(
    await repository.complete(conflict, claim, {
      kind: "share_link",
      shareLinkId: "share_2",
    }),
    { kind: "conflict" },
  );

  await assertRejects(
    () =>
      repository.complete(
        new ScriptedExecutor([]),
        claim,
        { kind: "artifact_upload", uploadId: "upl_1" } as never,
      ),
    TypeError,
    "does not match",
  );
});

Deno.test("completed idempotency rows fail closed on invalid references", async () => {
  const repository = new PostgresArtifactMutationIdempotencyRepository();
  const workspaceId = "workspace-1";
  const actorUserId = "user-1";
  const operation = "create_share" as const;
  const idempotencyKey = "share-key-0001";
  const request = { artifactId: "artifact-1" };
  const keyHash = await hashArtifactMutationIdempotencyKey({
    workspaceId,
    actorUserId,
    operation,
    idempotencyKey,
  });
  const fingerprint = await fingerprintArtifactMutationRequest(operation, {
    workspaceId,
    actorUserId,
    request,
  });
  const executor = new ScriptedExecutor([
    [],
    [completedRow({
      workspaceId,
      actorUserId,
      operation,
      keyHash,
      fingerprint,
      response: {
        kind: "share_link",
        shareLinkId: "share_wrong",
        token: "must-not-be-accepted",
      },
    })],
  ]);

  await assertRejects(
    () =>
      repository.claim(executor, {
        workspaceId,
        actorUserId,
        operation,
        idempotencyKey,
        request,
      }),
    ArtifactIdempotencyInvariantError,
  );
});
