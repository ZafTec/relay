import assert from "node:assert/strict";
import {
  acceptLegalDocument,
  createChangelogDraft,
  createLegalDocumentDraft,
  GovernanceIdempotencyConflictError,
  listPublishedChangelog,
} from "../src/index.ts";
import type { Queryable } from "../src/types.ts";

class FakeDatabase implements Queryable {
  readonly calls: { readonly sql: string; readonly values: unknown[] }[] = [];
  responses: unknown[][] = [];
  errorCode: string | undefined;

  query<Row extends Record<string, unknown>>(
    sql: string,
    values: unknown[] = [],
  ): Promise<{ readonly rows: Row[] }> {
    this.calls.push({ sql, values });
    if (this.errorCode !== undefined) {
      const code = this.errorCode;
      this.errorCode = undefined;
      return Promise.reject(
        Object.assign(new Error("database rejected"), { code }),
      );
    }
    return Promise.resolve({ rows: (this.responses.shift() ?? []) as Row[] });
  }
}

const releaseInput = {
  version: "0.4.0",
  slug: "release-0-4-0",
  title: "Release",
  gitTag: "v0.4.0",
  commitSha: "a".repeat(40),
  releasedAt: "2026-08-23T12:00:00Z",
  items: [{
    category: "added" as const,
    title: "A durable changelog",
    description: "Only published revisions are public.",
    sortOrder: 0,
  }],
};

Deno.test("admin mutations send only a session, hashed key, and JSON payload", async () => {
  const db = new FakeDatabase();
  db.responses.push([{
    result: { kind: "created", replayed: false, releaseId: "42", revision: 1 },
  }]);

  assert.deepEqual(
    await createChangelogDraft(
      db,
      {
        sessionId: "session-admin-0001",
        idempotencyKey: "create-release-0001",
        requestId: "request-1",
      },
      releaseInput,
    ),
    { kind: "created", replayed: false, releaseId: "42", revision: 1 },
  );
  assert.match(db.calls[0].sql, /relay\.mutate_changelog/);
  assert.equal(db.calls[0].values.length, 6);
  assert.equal(db.calls[0].values[0], "create");
  assert.equal(db.calls[0].values[1], "session-admin-0001");
  assert.match(String(db.calls[0].values[2]), /^[0-9a-f]{64}$/);
  assert.notEqual(db.calls[0].values[2], "create-release-0001");
  assert.equal(
    JSON.parse(String(db.calls[0].values[3])).slug,
    "release-0-4-0",
  );
});

Deno.test("authorization and idempotency database errors become typed outcomes", async () => {
  for (
    const [code, expected] of [
      ["42501", { kind: "denied", replayed: false }],
      ["28000", { kind: "reauthentication_required", replayed: false }],
      ["55000", { kind: "reauthentication_required", replayed: false }],
    ] as const
  ) {
    const db = new FakeDatabase();
    db.errorCode = code;
    assert.deepEqual(
      await createChangelogDraft(
        db,
        {
          sessionId: "session-admin-0001",
          idempotencyKey: `create-release-${code}`,
        },
        releaseInput,
      ),
      expected,
    );
  }

  const conflict = new FakeDatabase();
  conflict.errorCode = "RG001";
  await assert.rejects(
    () =>
      createChangelogDraft(
        conflict,
        {
          sessionId: "session-admin-0001",
          idempotencyKey: "create-release-conflict",
        },
        releaseInput,
      ),
    GovernanceIdempotencyConflictError,
  );

  const validationFailure = new FakeDatabase();
  validationFailure.errorCode = "22023";
  await assert.rejects(
    () =>
      createChangelogDraft(
        validationFailure,
        {
          sessionId: "session-admin-0001",
          idempotencyKey: "create-release-validation",
        },
        releaseInput,
      ),
    /database rejected/,
  );
});

Deno.test("public pagination overfetches once and emits a keyset cursor", async () => {
  const db = new FakeDatabase();
  const snapshot = (version: string, slug: string) => ({
    version,
    slug,
    title: version,
    summary: null,
    gitTag: `v${version}`,
    commitSha: "a".repeat(40),
    releasedAt: `2026-08-${version.endsWith("1") ? "23" : "22"}T12:00:00Z`,
    items: [],
    contentSha256: "b".repeat(64),
  });
  db.responses.push([
    {
      release_id: "9",
      revision: 1,
      snapshot: snapshot("0.4.1", "release-0-4-1"),
      published_at: "2026-08-23T13:00:00Z",
    },
    {
      release_id: "8",
      revision: 2,
      snapshot: snapshot("0.4.0", "release-0-4-0"),
      published_at: "2026-08-22T13:00:00Z",
    },
  ]);

  const page = await listPublishedChangelog(db, { limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].slug, "release-0-4-1");
  assert.notEqual(page.nextCursor, null);
  assert.deepEqual(db.calls[0].values, [2, null, null]);
});

Deno.test("legal services pass operator metadata without document content", async () => {
  const db = new FakeDatabase();
  db.responses.push([{
    result: { kind: "created", replayed: false, documentId: "7", revision: 1 },
  }]);
  const input = {
    documentType: "product_terms",
    version: "2026-08-23",
    effectiveAt: "2026-08-23T00:00:00Z",
    canonicalUrl: "https://legal.example.invalid/relay/terms",
    contentSha256: "c".repeat(64),
    requiresAcceptance: true,
  };

  await createLegalDocumentDraft(
    db,
    {
      sessionId: "session-admin-0001",
      idempotencyKey: "legal-document-0001",
    },
    input,
  );
  const payload = JSON.parse(String(db.calls[0].values[3]));
  assert.equal(payload.canonicalUrl, input.canonicalUrl);
  assert.equal(payload.contentSha256, input.contentSha256);
  assert.equal("content" in payload, false);

  db.responses.push([{
    result: {
      kind: "accepted",
      replayed: false,
      acceptanceId: "11",
      acceptedAt: "2026-08-23T12:00:00Z",
    },
  }]);
  await acceptLegalDocument(
    db,
    { sessionId: "session-user-0001" },
    {
      documentType: input.documentType,
      version: input.version,
      revision: 1,
      contentSha256: input.contentSha256,
      acceptanceScope: "user",
    },
  );
  assert.equal(db.calls[1].values.length, 11);
  assert.deepEqual(db.calls[1].values.slice(0, 3), [
    "session-user-0001",
    "user",
    null,
  ]);
  assert.equal(db.calls[1].values[6], input.contentSha256);

  db.responses.push([{
    result: {
      kind: "accepted",
      replayed: false,
      acceptanceId: "12",
      acceptedAt: "2026-08-23T12:00:00Z",
    },
  }]);
  await acceptLegalDocument(
    db,
    { sessionId: "session-owner-0001" },
    {
      documentType: input.documentType,
      version: input.version,
      revision: 1,
      contentSha256: input.contentSha256,
      acceptanceScope: "workspace",
      workspaceId: "workspace-0001",
    },
  );
  assert.deepEqual(db.calls[2].values.slice(0, 3), [
    "session-owner-0001",
    "workspace",
    "workspace-0001",
  ]);

  await assert.rejects(
    () =>
      acceptLegalDocument(
        db,
        { sessionId: "session-owner-0001" },
        {
          documentType: input.documentType,
          version: input.version,
          revision: 1,
          contentSha256: input.contentSha256,
          acceptanceScope: "workspace",
          workspaceId: "",
        },
      ),
    /workspaceId must not be empty/,
  );
});
