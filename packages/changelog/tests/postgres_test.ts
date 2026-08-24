import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import pg from "pg";
import {
  acceptLegalDocument,
  createChangelogDraft,
  createLegalDocumentDraft,
  createMutationArtifacts,
  getPublishedChangelogBySlug,
  GovernanceIdempotencyConflictError,
  isValidSemver,
  listAdminChangelog,
  listChangelogRevisions,
  listPendingLegalDocuments,
  listPublishedChangelog,
  listPublishedLegalDocuments,
  publishChangelogRelease,
  publishLegalDocument,
  reviseChangelogDraft,
  reviseLegalDocumentDraft,
  unpublishChangelogRelease,
  unpublishLegalDocument,
} from "../src/index.ts";
import type {
  ChangelogDraftInput,
  GovernanceMutationContext,
  LegalDocumentInput,
  Queryable,
} from "../src/index.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const privilegedDatabaseUrl = Deno.env.get("AUTH_SECURITY_TEST_DATABASE_URL");

function requireAppDatabase(value: string): URL {
  const url = new URL(value);
  if (url.username !== "relay_app") {
    throw new Error(
      "changelog PostgreSQL tests require DATABASE_URL to connect as relay_app",
    );
  }
  return url;
}

function requireMatchingPrivilegedDatabase(appUrl: URL, value: string): URL {
  const privilegedUrl = new URL(value);
  if (
    privilegedUrl.username !== "relay_migrator" ||
    privilegedUrl.host !== appUrl.host ||
    privilegedUrl.pathname !== appUrl.pathname
  ) {
    throw new Error(
      "AUTH_SECURITY_TEST_DATABASE_URL must connect as relay_migrator to DATABASE_URL",
    );
  }
  return privilegedUrl;
}

if (databaseUrl !== undefined) requireAppDatabase(databaseUrl);

function asQueryable(client: pg.Client): Queryable {
  return {
    async query<Row extends Record<string, unknown>>(
      text: string,
      values: unknown[] = [],
    ): Promise<{ readonly rows: Row[] }> {
      const result = await client.query(text, values);
      return { rows: result.rows as Row[] };
    },
  };
}

interface Fixture {
  readonly suffix: string;
  readonly slugPrefix: string;
  readonly documentPrefix: string;
  readonly requestPrefix: string;
  readonly adminUserId: string;
  readonly workspaceAdminUserId: string;
  readonly memberUserId: string;
  readonly outsiderUserId: string;
  readonly workspaceId: string;
  readonly freshAdminSessionId: string;
  readonly staleAdminSessionId: string;
  readonly workspaceAdminSessionId: string;
  readonly memberSessionId: string;
  readonly outsiderSessionId: string;
  readonly auditTriggerName: string;
  readonly auditFunctionName: string;
  readonly atomicRequestId: string;
  readonly userIds: readonly string[];
}

function buildFixture(): Fixture {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const requestPrefix = `changelog-${suffix}`;
  const adminUserId = `changelog-admin-${suffix}`;
  const workspaceAdminUserId = `changelog-org-admin-${suffix}`;
  const memberUserId = `changelog-member-${suffix}`;
  const outsiderUserId = `changelog-outsider-${suffix}`;
  return {
    suffix,
    slugPrefix: `changelog-${suffix}`,
    documentPrefix: `changelog_${suffix}`,
    requestPrefix,
    adminUserId,
    workspaceAdminUserId,
    memberUserId,
    outsiderUserId,
    workspaceId: `changelog-workspace-${suffix}`,
    freshAdminSessionId: `changelog-fresh-${suffix}`,
    staleAdminSessionId: `changelog-stale-${suffix}`,
    workspaceAdminSessionId: `changelog-org-admin-session-${suffix}`,
    memberSessionId: `changelog-member-session-${suffix}`,
    outsiderSessionId: `changelog-outsider-session-${suffix}`,
    auditTriggerName: `changelog_audit_probe_${suffix}`,
    auditFunctionName: `changelog_audit_probe_${suffix}`,
    atomicRequestId: `${requestPrefix}-atomic-audit`,
    userIds: [
      adminUserId,
      workspaceAdminUserId,
      memberUserId,
      outsiderUserId,
    ],
  };
}

async function createFixture(
  owner: pg.Client,
  fixture: Fixture,
): Promise<void> {
  await owner.query("begin");
  try {
    await owner.query(
      `insert into auth."user" (id, name, email, "emailVerified")
       values
         ($1, 'Changelog admin', $2, true),
         ($3, 'Workspace admin', $4, true),
         ($5, 'Workspace member', $6, true),
         ($7, 'Outsider', $8, true)`,
      [
        fixture.adminUserId,
        `${fixture.adminUserId}@example.invalid`,
        fixture.workspaceAdminUserId,
        `${fixture.workspaceAdminUserId}@example.invalid`,
        fixture.memberUserId,
        `${fixture.memberUserId}@example.invalid`,
        fixture.outsiderUserId,
        `${fixture.outsiderUserId}@example.invalid`,
      ],
    );
    await owner.query(
      `insert into auth.organization (id, name, slug, "createdAt")
       values ($1, 'Changelog PostgreSQL test', $2, now())`,
      [fixture.workspaceId, `changelog-${fixture.suffix}`],
    );
    await owner.query(
      `insert into auth.member
         (id, "organizationId", "userId", role, "createdAt")
       values
         ($1, $2, $3, 'owner', now()),
         ($4, $2, $5, 'admin', now()),
         ($6, $2, $7, 'member', now())`,
      [
        `changelog-owner-membership-${fixture.suffix}`,
        fixture.workspaceId,
        fixture.adminUserId,
        `changelog-admin-membership-${fixture.suffix}`,
        fixture.workspaceAdminUserId,
        `changelog-member-membership-${fixture.suffix}`,
        fixture.memberUserId,
      ],
    );
    await owner.query(
      `insert into auth.session
         (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
       values
         ($1, now() + interval '1 hour', $2, now(), now(), $3),
         ($4, now() + interval '1 hour', $5,
            now() - interval '16 minutes', now(), $3),
         ($6, now() + interval '1 hour', $7, now(), now(), $8),
         ($9, now() + interval '1 hour', $10, now(), now(), $11),
         ($12, now() + interval '1 hour', $13, now(), now(), $14)`,
      [
        fixture.freshAdminSessionId,
        `token-${crypto.randomUUID()}`,
        fixture.adminUserId,
        fixture.staleAdminSessionId,
        `token-${crypto.randomUUID()}`,
        fixture.workspaceAdminSessionId,
        `token-${crypto.randomUUID()}`,
        fixture.workspaceAdminUserId,
        fixture.memberSessionId,
        `token-${crypto.randomUUID()}`,
        fixture.memberUserId,
        fixture.outsiderSessionId,
        `token-${crypto.randomUUID()}`,
        fixture.outsiderUserId,
      ],
    );
    await owner.query(
      `insert into relay.system_role_assignments (user_id, role, granted_by)
       values ($1, 'superadmin', $1)`,
      [fixture.adminUserId],
    );
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }
}

const GOVERNANCE_TRIGGER_DDL = [
  ["changelog_items", "changelog_items_immutable"],
  ["changelog_publication_events", "changelog_publication_events_immutable"],
  ["changelog_releases", "changelog_releases_no_delete"],
  ["changelog_revisions", "changelog_revisions_immutable"],
  [
    "governance_operation_idempotency",
    "governance_operation_idempotency_immutable",
  ],
  ["legal_acceptances", "legal_acceptances_immutable"],
  [
    "legal_document_publication_events",
    "legal_document_publication_events_immutable",
  ],
  ["legal_documents", "legal_documents_immutable"],
] as const;

async function cleanupFixture(
  owner: pg.Client,
  fixture: Fixture,
): Promise<void> {
  await owner.query("begin");
  try {
    await owner.query(
      `drop trigger if exists ${fixture.auditTriggerName} on relay.audit_events`,
    );
    await owner.query(
      `drop function if exists relay.${fixture.auditFunctionName}()`,
    );
    for (const [table, trigger] of GOVERNANCE_TRIGGER_DDL) {
      await owner.query(
        `alter table relay.${table} disable trigger ${trigger}`,
      );
    }

    const releases = await owner.query<{ id: string }>(
      `select id::text as id from relay.changelog_releases
       where pg_catalog.left(slug, $1) = $2`,
      [fixture.slugPrefix.length, fixture.slugPrefix],
    );
    const releaseIds = releases.rows.map((row: { id: string }) => row.id);
    const documents = await owner.query<{ id: string }>(
      `select id::text as id from relay.legal_documents
       where pg_catalog.left(document_type, $1) = $2`,
      [fixture.documentPrefix.length, fixture.documentPrefix],
    );
    const documentIds = documents.rows.map((row: { id: string }) => row.id);

    await owner.query("set constraints all deferred");
    await owner.query(
      "delete from relay.changelog_publication_events where release_id = any($1::bigint[])",
      [releaseIds],
    );
    await owner.query(
      "delete from relay.changelog_items where release_id = any($1::bigint[])",
      [releaseIds],
    );
    await owner.query(
      "delete from relay.changelog_revisions where release_id = any($1::bigint[])",
      [releaseIds],
    );
    await owner.query(
      "delete from relay.changelog_releases where id = any($1::bigint[])",
      [releaseIds],
    );
    await owner.query(
      "delete from relay.legal_acceptances where legal_document_id = any($1::bigint[])",
      [documentIds],
    );
    await owner.query(
      `delete from relay.legal_document_publication_events
       where document_id = any($1::bigint[])
          or superseded_document_id = any($1::bigint[])`,
      [documentIds],
    );
    await owner.query(
      "delete from relay.legal_documents where id = any($1::bigint[])",
      [documentIds],
    );
    await owner.query(
      `delete from relay.governance_operation_idempotency
       where operator_user_id = any($1::text[])`,
      [[...fixture.userIds]],
    );
    await owner.query(
      `delete from relay.audit_events
       where actor_user_id = any($1::text[])
          or pg_catalog.left(coalesce(request_id, ''), $2) = $3
          or target_id = any($4::text[])`,
      [
        [...fixture.userIds],
        fixture.requestPrefix.length,
        fixture.requestPrefix,
        [...releaseIds, ...documentIds],
      ],
    );
    await owner.query(
      "delete from relay.system_role_assignments where user_id = any($1::text[])",
      [[...fixture.userIds]],
    );
    await owner.query("delete from auth.organization where id = $1", [
      fixture.workspaceId,
    ]);
    await owner.query('delete from auth."user" where id = any($1::text[])', [
      [...fixture.userIds],
    ]);
    await owner.query("set constraints all immediate");

    for (const [table, trigger] of GOVERNANCE_TRIGGER_DDL) {
      await owner.query(`alter table relay.${table} enable trigger ${trigger}`);
    }
    await owner.query("commit");
  } catch (error) {
    await owner.query("rollback");
    throw error;
  }

  const residue = await owner.query<{ count: string }>(
    `select (
       (select count(*) from relay.changelog_releases
         where pg_catalog.left(slug, $1) = $2) +
       (select count(*) from relay.legal_documents
         where pg_catalog.left(document_type, $3) = $4) +
       (select count(*) from auth."user" where id = any($5::text[]))
     )::text as count`,
    [
      fixture.slugPrefix.length,
      fixture.slugPrefix,
      fixture.documentPrefix.length,
      fixture.documentPrefix,
      [...fixture.userIds],
    ],
  );
  assertEquals(residue.rows[0]?.count, "0");
}

function key(fixture: Fixture, label: string): string {
  return `${fixture.requestPrefix}-${label}`;
}

function mutationContext(
  fixture: Fixture,
  sessionId: string,
  label: string,
  requestId = `${fixture.requestPrefix}-${label}`,
): GovernanceMutationContext {
  return {
    sessionId,
    idempotencyKey: key(fixture, label),
    requestId,
    traceId: `${fixture.requestPrefix}-trace-${label}`,
  };
}

function releaseInput(
  fixture: Fixture,
  patch: {
    readonly label: string;
    readonly version: string;
    readonly title?: string;
    readonly releasedAt?: string;
  },
): ChangelogDraftInput {
  const title = patch.title ?? `Release ${patch.label}`;
  return {
    version: patch.version,
    slug: `${fixture.slugPrefix}-${patch.label}`,
    title,
    summary: `${title} summary`,
    gitTag: `v${patch.version}`,
    commitSha: "b".repeat(40),
    releasedAt: patch.releasedAt ?? "2099-12-31T12:00:00.000Z",
    items: [{
      category: "improved",
      area: "governance",
      title: `${title} item`,
      description: `${title} is governed by an immutable revision.`,
      sortOrder: 0,
    }],
  };
}

function legalInput(
  fixture: Fixture,
  label: string,
  version: string,
  contentSha256: string,
  acceptanceScope: "user" | "workspace" = "user",
): LegalDocumentInput {
  const documentType = `${fixture.documentPrefix}_${label}`;
  return {
    documentType,
    version,
    effectiveAt: "2020-01-01T00:00:00.000Z",
    canonicalUrl: `https://legal.example.invalid/${documentType}/${version}`,
    contentSha256,
    requiresAcceptance: true,
    acceptanceScope,
  };
}

async function capturedDatabaseError(
  operation: () => Promise<unknown>,
): Promise<{ readonly code?: string; readonly message: string }> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof Error) {
      const code = (error as Error & { code?: unknown }).code;
      return {
        code: typeof code === "string" ? code : undefined,
        message: error.message,
      };
    }
    return { message: String(error) };
  }
  throw new Error("expected database operation to fail");
}

async function assertPromisePending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  assertEquals(
    settled,
    false,
    "operation should be waiting on a governance lock",
  );
}

Deno.test({
  name: "changelog and legal governance hold in PostgreSQL",
  ignore: databaseUrl === undefined || privilegedDatabaseUrl === undefined,
  fn: async () => {
    const appUrl = requireAppDatabase(databaseUrl!);
    const fixture = buildFixture();
    const owner = new pg.Client({
      connectionString: requireMatchingPrivilegedDatabase(
        appUrl,
        privilegedDatabaseUrl!,
      ).toString(),
    });
    const app = new pg.Client({ connectionString: appUrl.toString() });
    let fixtureCreated = false;

    await owner.connect();
    await owner.query(
      "select pg_advisory_lock(pg_catalog.hashtextextended('relay.changelog.postgres-test', 0))",
    );
    await owner.query("set role relay_owner");
    await app.connect();
    const db = asQueryable(app);

    try {
      await createFixture(owner, fixture);
      fixtureCreated = true;

      const authorizationInput = releaseInput(fixture, {
        label: "authorization",
        version: `0.9.0+${fixture.suffix}`,
      });
      assertEquals(
        await createChangelogDraft(
          db,
          mutationContext(
            fixture,
            fixture.staleAdminSessionId,
            "stale-create",
          ),
          authorizationInput,
        ),
        { kind: "reauthentication_required", replayed: false },
      );
      assertEquals(
        await createChangelogDraft(
          db,
          mutationContext(
            fixture,
            fixture.outsiderSessionId,
            "outsider-create",
          ),
          authorizationInput,
        ),
        { kind: "denied", replayed: false },
      );
      assertEquals(
        await listAdminChangelog(db, {
          sessionId: fixture.staleAdminSessionId,
        }),
        { kind: "reauthentication_required" },
      );
      assertEquals(
        await listAdminChangelog(db, {
          sessionId: fixture.outsiderSessionId,
        }),
        { kind: "denied" },
      );

      const mainInput = releaseInput(fixture, {
        label: "main",
        version: `1.0.0+${fixture.suffix}`,
        title: "First published snapshot",
        releasedAt: "2099-12-30T12:00:00.000Z",
      });
      const createContext = mutationContext(
        fixture,
        fixture.freshAdminSessionId,
        "create-main",
      );
      const created = await createChangelogDraft(db, createContext, mainInput);
      assert(
        created.kind === "created" && created.releaseId !== undefined &&
          created.revision === 1,
      );
      const mainReleaseId = created.releaseId;
      const adminList = await listAdminChangelog(db, {
        sessionId: fixture.freshAdminSessionId,
      });
      assertEquals(adminList.kind, "ok");
      if (adminList.kind === "ok") {
        assertEquals(
          adminList.value.some((entry) => entry.releaseId === mainReleaseId),
          true,
        );
      }

      assertEquals(
        await createChangelogDraft(db, createContext, mainInput),
        { ...created, replayed: true },
      );
      await assertRejects(
        () =>
          createChangelogDraft(db, createContext, {
            ...mainInput,
            title: "Conflicting idempotent request",
          }),
        GovernanceIdempotencyConflictError,
      );
      const createState = await owner.query<{
        revisions: string;
        operations: string;
        audits: string;
        key_hash: string;
      }>(
        `select
           (select count(*) from relay.changelog_revisions
             where release_id = $1::bigint)::text as revisions,
           (select count(*) from relay.governance_operation_idempotency
             where operation = 'changelog.create'
               and operator_user_id = $2)::text as operations,
           (select count(*) from relay.audit_events
             where action = 'changelog.release.create'
               and target_id = $1::text)::text as audits,
           operation.idempotency_key_hash as key_hash
         from relay.governance_operation_idempotency as operation
         where operation.operation = 'changelog.create'
           and operation.operator_user_id = $2`,
        [mainReleaseId, fixture.adminUserId],
      );
      assertEquals(createState.rows.length, 1);
      assertEquals(createState.rows[0]?.revisions, "1");
      assertEquals(createState.rows[0]?.operations, "1");
      assertEquals(createState.rows[0]?.audits, "1");
      assertMatch(createState.rows[0]?.key_hash ?? "", /^[0-9a-f]{64}$/u);

      await owner.query(`
        create function relay.${fixture.auditFunctionName}()
        returns trigger
        language plpgsql
        set search_path = pg_catalog
        as $function$
        begin
          if new.request_id = '${fixture.atomicRequestId}' then
            raise exception 'forced protected audit failure'
              using errcode = '23514';
          end if;
          return new;
        end;
        $function$;
        create trigger ${fixture.auditTriggerName}
          before insert on relay.audit_events
          for each row execute function relay.${fixture.auditFunctionName}();
      `);
      const atomicInput = releaseInput(fixture, {
        label: "atomic",
        version: `0.9.1+${fixture.suffix}`,
      });
      const atomicKey = key(fixture, "atomic-create");
      try {
        await assertRejects(() =>
          createChangelogDraft(
            db,
            {
              sessionId: fixture.freshAdminSessionId,
              idempotencyKey: atomicKey,
              requestId: fixture.atomicRequestId,
              traceId: `${fixture.requestPrefix}-atomic-trace`,
            },
            atomicInput,
          )
        );
      } finally {
        await owner.query(
          `drop trigger if exists ${fixture.auditTriggerName} on relay.audit_events`,
        );
        await owner.query(
          `drop function if exists relay.${fixture.auditFunctionName}()`,
        );
      }
      const atomicArtifacts = await createMutationArtifacts(
        "changelog.create",
        atomicKey,
        atomicInput,
      );
      const atomicState = await owner.query<{
        releases: string;
        operations: string;
        audits: string;
      }>(
        `select
           (select count(*) from relay.changelog_releases
             where slug = $1)::text as releases,
           (select count(*) from relay.governance_operation_idempotency
             where idempotency_key_hash = $2)::text as operations,
           (select count(*) from relay.audit_events
             where request_id = $3)::text as audits`,
        [atomicInput.slug, atomicArtifacts.keyHash, fixture.atomicRequestId],
      );
      assertEquals(atomicState.rows[0], {
        releases: "0",
        operations: "0",
        audits: "0",
      });

      const firstPublish = await publishChangelogRelease(
        db,
        mutationContext(fixture, fixture.freshAdminSessionId, "publish-main-1"),
        mainReleaseId,
        1,
      );
      assert(firstPublish.kind === "published");
      assertEquals(
        (await getPublishedChangelogBySlug(db, mainInput.slug))?.title,
        mainInput.title,
      );
      const revisedInput = {
        ...mainInput,
        title: "Superseding snapshot",
        items: [{ ...mainInput.items[0], title: "Superseding item" }],
      };
      const revised = await reviseChangelogDraft(
        db,
        mutationContext(fixture, fixture.freshAdminSessionId, "revise-main"),
        mainReleaseId,
        1,
        revisedInput,
      );
      assert(revised.kind === "revised");
      assertEquals(revised.revision, 2);
      assertEquals(
        (await getPublishedChangelogBySlug(db, mainInput.slug))?.title,
        mainInput.title,
      );
      const revisions = await listChangelogRevisions(
        db,
        { sessionId: fixture.freshAdminSessionId },
        mainReleaseId,
      );
      assertEquals(revisions.kind, "ok");
      if (revisions.kind === "ok") {
        assertEquals(revisions.value.map((entry) => entry.revision), [2, 1]);
      }
      assertEquals(
        (await capturedDatabaseError(() =>
          owner.query(
            `update relay.changelog_revisions set title = 'rewritten'
             where release_id = $1::bigint and revision = 1`,
            [mainReleaseId],
          )
        )).code,
        "55000",
      );
      const superseded = await publishChangelogRelease(
        db,
        mutationContext(fixture, fixture.freshAdminSessionId, "publish-main-2"),
        mainReleaseId,
        2,
      );
      assert(superseded.kind === "superseded");
      assertEquals(superseded.supersededRevision, 1);
      assertEquals(
        (await getPublishedChangelogBySlug(db, mainInput.slug))?.title,
        revisedInput.title,
      );
      assertEquals(
        (await unpublishChangelogRelease(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "unpublish-main",
          ),
          mainReleaseId,
          2,
        )).kind,
        "unpublished",
      );
      assertEquals(await getPublishedChangelogBySlug(db, mainInput.slug), null);
      const publicationEvents = await owner.query<{ action: string }>(
        `select action from relay.changelog_publication_events
         where release_id = $1::bigint order by id`,
        [mainReleaseId],
      );
      assertEquals(
        publicationEvents.rows.map((row: { action: string }) => row.action),
        ["publish", "supersede", "unpublish"],
      );

      assertEquals(isValidSemver("1.0.0-rc.1+build.001"), true);
      assertEquals(isValidSemver("1.0.0-01"), false);
      const invalidSemver = await createChangelogDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-invalid-semver",
        ),
        releaseInput(fixture, {
          label: "invalid-semver",
          version: `1.0.0-01+${fixture.suffix}`,
        }),
      );
      assert(
        invalidSemver.kind === "created" &&
          invalidSemver.releaseId !== undefined,
      );
      const rejectedPublish = await publishChangelogRelease(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "publish-invalid-semver",
        ),
        invalidSemver.releaseId,
        1,
      );
      assert(rejectedPublish.kind === "not_publishable");
      assertEquals(rejectedPublish.reasons, ["invalid_version"]);
      const validPrerelease = await createChangelogDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-valid-prerelease",
        ),
        releaseInput(fixture, {
          label: "valid-prerelease",
          version: `1.0.0-rc.1+${fixture.suffix}`,
        }),
      );
      assert(
        validPrerelease.kind === "created" &&
          validPrerelease.releaseId !== undefined,
      );
      assertEquals(
        (await publishChangelogRelease(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "publish-valid-prerelease",
          ),
          validPrerelease.releaseId,
          1,
        )).kind,
        "published",
      );
      assertEquals(
        (await unpublishChangelogRelease(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "unpublish-valid-prerelease",
          ),
          validPrerelease.releaseId,
          1,
        )).kind,
        "unpublished",
      );

      const pageSlugs: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const input = releaseInput(fixture, {
          label: `page-${index}`,
          version: `2.0.${index}+${fixture.suffix}`,
          releasedAt: "9999-12-31T12:00:00.000Z",
        });
        pageSlugs.push(input.slug);
        const pageDraft = await createChangelogDraft(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            `create-page-${index}`,
          ),
          input,
        );
        assert(
          pageDraft.kind === "created" && pageDraft.releaseId !== undefined,
        );
        assertEquals(
          (await publishChangelogRelease(
            db,
            mutationContext(
              fixture,
              fixture.freshAdminSessionId,
              `publish-page-${index}`,
            ),
            pageDraft.releaseId,
            1,
          )).kind,
          "published",
        );
      }
      const firstPage = await listPublishedChangelog(db, { limit: 2 });
      assertEquals(
        firstPage.entries.map((entry) => entry.slug),
        [pageSlugs[2], pageSlugs[1]],
      );
      assert(firstPage.nextCursor !== null);
      const secondPage = await listPublishedChangelog(db, {
        limit: 1,
        cursor: firstPage.nextCursor,
      });
      assertEquals(secondPage.entries[0]?.slug, pageSlugs[0]);
      assertEquals(
        new Set(
          [...firstPage.entries, ...secondPage.entries].map((entry) =>
            entry.slug
          ),
        ).size,
        3,
      );
      assertEquals(
        await getPublishedChangelogBySlug(db, authorizationInput.slug),
        null,
      );

      const currentTimedTerms = legalInput(
        fixture,
        "timed_terms",
        "current",
        "4".repeat(64),
      );
      const currentTimedCreated = await createLegalDocumentDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-current-timed",
        ),
        currentTimedTerms,
      );
      assert(
        currentTimedCreated.kind === "created" &&
          currentTimedCreated.documentId !== undefined,
      );
      assertEquals(
        (await publishLegalDocument(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "publish-current-timed",
          ),
          currentTimedCreated.documentId,
        )).kind,
        "published",
      );
      const futureClock = await owner.query<{ effective_at: Date }>(
        "select statement_timestamp() + interval '1 second' as effective_at",
      );
      const futureEffectiveAt = futureClock.rows[0]!.effective_at.toISOString();
      const futureTimedTerms = {
        ...legalInput(
          fixture,
          "timed_terms",
          "future",
          "5".repeat(64),
        ),
        effectiveAt: futureEffectiveAt,
      };
      const futureTimedCreated = await createLegalDocumentDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-future-timed",
        ),
        futureTimedTerms,
      );
      assert(
        futureTimedCreated.kind === "created" &&
          futureTimedCreated.documentId !== undefined,
      );
      const futureTimedPublish = await publishLegalDocument(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "publish-future-timed",
        ),
        futureTimedCreated.documentId,
      );
      assert(futureTimedPublish.kind === "superseded");
      assertEquals(
        futureTimedPublish.supersededDocumentId,
        currentTimedCreated.documentId,
      );
      assertEquals(
        (await listPublishedLegalDocuments(db)).find((entry) =>
          entry.documentType === currentTimedTerms.documentType
        )?.documentId,
        currentTimedCreated.documentId,
      );
      assertEquals(
        (await acceptLegalDocument(
          db,
          {
            sessionId: fixture.workspaceAdminSessionId,
            requestId: `${fixture.requestPrefix}-accept-current-timed`,
          },
          {
            documentType: currentTimedTerms.documentType,
            version: currentTimedTerms.version,
            revision: 1,
            contentSha256: currentTimedTerms.contentSha256,
            acceptanceScope: "user",
          },
        )).kind,
        "accepted",
      );
      assertEquals(
        (await acceptLegalDocument(
          db,
          { sessionId: fixture.workspaceAdminSessionId },
          {
            documentType: futureTimedTerms.documentType,
            version: futureTimedTerms.version,
            revision: 1,
            contentSha256: futureTimedTerms.contentSha256,
            acceptanceScope: "user",
          },
        )).kind,
        "not_current",
      );
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(0, new Date(futureEffectiveAt).getTime() - Date.now() + 200),
        )
      );
      assertEquals(
        (await listPublishedLegalDocuments(db)).find((entry) =>
          entry.documentType === futureTimedTerms.documentType
        )?.documentId,
        futureTimedCreated.documentId,
      );
      assertEquals(
        (await acceptLegalDocument(
          db,
          { sessionId: fixture.workspaceAdminSessionId },
          {
            documentType: currentTimedTerms.documentType,
            version: currentTimedTerms.version,
            revision: 1,
            contentSha256: currentTimedTerms.contentSha256,
            acceptanceScope: "user",
          },
        )).kind,
        "not_current",
      );
      assertEquals(
        (await acceptLegalDocument(
          db,
          {
            sessionId: fixture.workspaceAdminSessionId,
            requestId: `${fixture.requestPrefix}-accept-future-timed`,
          },
          {
            documentType: futureTimedTerms.documentType,
            version: futureTimedTerms.version,
            revision: 1,
            contentSha256: futureTimedTerms.contentSha256,
            acceptanceScope: "user",
          },
        )).kind,
        "accepted",
      );

      const cancellationCurrent = legalInput(
        fixture,
        "cancellation_terms",
        "current",
        "6".repeat(64),
      );
      const cancellationCurrentCreated = await createLegalDocumentDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-cancel-current",
        ),
        cancellationCurrent,
      );
      assert(
        cancellationCurrentCreated.kind === "created" &&
          cancellationCurrentCreated.documentId !== undefined,
      );
      assertEquals(
        (await publishLegalDocument(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "publish-cancel-current",
          ),
          cancellationCurrentCreated.documentId,
        )).kind,
        "published",
      );
      const cancellationFuture = {
        ...legalInput(
          fixture,
          "cancellation_terms",
          "future",
          "7".repeat(64),
        ),
        effectiveAt: "2100-01-01T00:00:00.000Z",
      };
      const cancellationFutureCreated = await createLegalDocumentDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-cancel-future",
        ),
        cancellationFuture,
      );
      assert(
        cancellationFutureCreated.kind === "created" &&
          cancellationFutureCreated.documentId !== undefined,
      );
      assertEquals(
        (await publishLegalDocument(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "publish-cancel-future",
          ),
          cancellationFutureCreated.documentId,
        )).kind,
        "superseded",
      );
      assertEquals(
        (await unpublishLegalDocument(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "cancel-future",
          ),
          cancellationFuture.documentType,
          cancellationFutureCreated.documentId,
        )).kind,
        "unpublished",
      );
      assertEquals(
        (await listPublishedLegalDocuments(db)).find((entry) =>
          entry.documentType === cancellationCurrent.documentType
        )?.documentId,
        cancellationCurrentCreated.documentId,
      );

      const termsV1 = legalInput(
        fixture,
        "product_terms",
        "2026-terms",
        "8".repeat(64),
      );
      const termsCreated = await createLegalDocumentDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-terms",
        ),
        termsV1,
      );
      assert(
        termsCreated.kind === "created" &&
          termsCreated.documentId !== undefined,
      );
      assertEquals(
        (await publishLegalDocument(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "publish-terms-1",
          ),
          termsCreated.documentId,
        )).kind,
        "published",
      );
      const firstUserAcceptance = await acceptLegalDocument(
        db,
        {
          sessionId: fixture.workspaceAdminSessionId,
          requestId: `${fixture.requestPrefix}-accept-terms-admin`,
        },
        {
          documentType: termsV1.documentType,
          version: termsV1.version,
          revision: 1,
          contentSha256: termsV1.contentSha256,
          acceptanceScope: "user",
        },
      );
      const secondUserAcceptance = await acceptLegalDocument(
        db,
        {
          sessionId: fixture.memberSessionId,
          requestId: `${fixture.requestPrefix}-accept-terms-member`,
        },
        {
          documentType: termsV1.documentType,
          version: termsV1.version,
          revision: 1,
          contentSha256: termsV1.contentSha256,
          acceptanceScope: "user",
        },
      );
      assert(
        firstUserAcceptance.kind === "accepted" &&
          secondUserAcceptance.kind === "accepted" &&
          firstUserAcceptance.acceptanceId !==
            secondUserAcceptance.acceptanceId,
      );
      assertEquals(
        (await owner.query<{ count: string }>(
          `select count(*)::text as count from relay.legal_acceptances
           where legal_document_id = $1::bigint and acceptance_scope = 'user'`,
          [termsCreated.documentId],
        )).rows[0]?.count,
        "2",
      );

      const termsV2 = {
        ...termsV1,
        canonicalUrl: `${termsV1.canonicalUrl}-revised`,
        contentSha256: "9".repeat(64),
      };
      const termsRevised = await reviseLegalDocumentDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "revise-terms",
        ),
        1,
        termsV2,
      );
      assert(
        termsRevised.kind === "revised" &&
          termsRevised.documentId !== undefined && termsRevised.revision === 2,
      );
      const termsSuperseded = await publishLegalDocument(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "publish-terms-2",
        ),
        termsRevised.documentId,
      );
      assert(termsSuperseded.kind === "superseded");
      assertEquals(
        termsSuperseded.supersededDocumentId,
        termsCreated.documentId,
      );
      assertEquals(
        (await acceptLegalDocument(
          db,
          { sessionId: fixture.workspaceAdminSessionId },
          {
            documentType: termsV1.documentType,
            version: termsV1.version,
            revision: 1,
            contentSha256: termsV1.contentSha256,
            acceptanceScope: "user",
          },
        )).kind,
        "not_current",
      );
      assertEquals(
        (await acceptLegalDocument(
          db,
          {
            sessionId: fixture.workspaceAdminSessionId,
            requestId: `${fixture.requestPrefix}-accept-terms-v2`,
          },
          {
            documentType: termsV2.documentType,
            version: termsV2.version,
            revision: 2,
            contentSha256: termsV2.contentSha256,
            acceptanceScope: "user",
          },
        )).kind,
        "accepted",
      );
      assertEquals(
        (await capturedDatabaseError(() =>
          owner.query(
            `update relay.legal_documents
             set canonical_url = 'https://legal.example.invalid/rewritten'
             where id = $1::bigint`,
            [termsCreated.documentId],
          )
        )).code,
        "55000",
      );
      assertEquals(
        (await unpublishLegalDocument(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "unpublish-terms",
          ),
          termsV2.documentType,
          termsRevised.documentId,
        )).kind,
        "unpublished",
      );
      assertEquals(
        (await listPublishedLegalDocuments(db)).some((entry) =>
          entry.documentType === termsV2.documentType
        ),
        false,
      );

      const workspacePolicy = legalInput(
        fixture,
        "workspace_policy",
        "2026-policy",
        "a".repeat(64),
        "workspace",
      );
      const workspacePolicyCreated = await createLegalDocumentDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-workspace-policy",
        ),
        workspacePolicy,
      );
      assert(
        workspacePolicyCreated.kind === "created" &&
          workspacePolicyCreated.documentId !== undefined,
      );
      assertEquals(
        (await publishLegalDocument(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "publish-workspace-policy",
          ),
          workspacePolicyCreated.documentId,
        )).kind,
        "published",
      );
      assertEquals(
        await listPendingLegalDocuments(
          db,
          { sessionId: fixture.outsiderSessionId },
          fixture.workspaceId,
        ),
        { kind: "denied" },
      );
      assertEquals(
        await acceptLegalDocument(
          db,
          { sessionId: fixture.memberSessionId },
          {
            documentType: workspacePolicy.documentType,
            version: workspacePolicy.version,
            revision: 1,
            contentSha256: workspacePolicy.contentSha256,
            acceptanceScope: "workspace",
            workspaceId: fixture.workspaceId,
          },
        ),
        { kind: "denied", replayed: false },
      );
      const workspaceAcceptance = await acceptLegalDocument(
        db,
        {
          sessionId: fixture.workspaceAdminSessionId,
          requestId: `${fixture.requestPrefix}-accept-workspace-policy`,
        },
        {
          documentType: workspacePolicy.documentType,
          version: workspacePolicy.version,
          revision: 1,
          contentSha256: workspacePolicy.contentSha256,
          acceptanceScope: "workspace",
          workspaceId: fixture.workspaceId,
        },
      );
      assert(
        workspaceAcceptance.kind === "accepted" &&
          workspaceAcceptance.acceptanceId !== undefined &&
          !workspaceAcceptance.replayed,
      );
      const ownerReplay = await acceptLegalDocument(
        db,
        { sessionId: fixture.freshAdminSessionId },
        {
          documentType: workspacePolicy.documentType,
          version: workspacePolicy.version,
          revision: 1,
          contentSha256: workspacePolicy.contentSha256,
          acceptanceScope: "workspace",
          workspaceId: fixture.workspaceId,
        },
      );
      assertEquals(ownerReplay.kind, "accepted");
      assertEquals(ownerReplay.replayed, true);
      if (ownerReplay.kind === "accepted") {
        assertEquals(
          ownerReplay.acceptanceId,
          workspaceAcceptance.acceptanceId,
        );
      }
      assertEquals(
        (await owner.query<{ count: string }>(
          `select count(*)::text as count from relay.legal_acceptances
           where legal_document_id = $1::bigint
             and acceptance_scope = 'workspace'
             and workspace_id = $2`,
          [workspacePolicyCreated.documentId, fixture.workspaceId],
        )).rows[0]?.count,
        "1",
      );
      const memberPending = await listPendingLegalDocuments(
        db,
        { sessionId: fixture.memberSessionId },
        fixture.workspaceId,
      );
      assertEquals(memberPending.kind, "ok");
      if (memberPending.kind === "ok") {
        assertEquals(
          memberPending.value.some((entry) =>
            entry.documentType === workspacePolicy.documentType
          ),
          false,
        );
      }

      const revisionLockV1 = legalInput(
        fixture,
        "revision_lock_terms",
        "2026-lock",
        "c".repeat(64),
      );
      const revisionLockCreated = await createLegalDocumentDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-revision-lock",
        ),
        revisionLockV1,
      );
      assert(
        revisionLockCreated.kind === "created" &&
          revisionLockCreated.documentId !== undefined,
      );
      const revisionClient = new pg.Client({
        connectionString: appUrl.toString(),
      });
      await revisionClient.connect();
      const revisionDb = asQueryable(revisionClient);
      let revisionTransactionOpen = false;
      let blockedPublish: ReturnType<typeof publishLegalDocument> | undefined;
      try {
        await revisionClient.query("begin");
        revisionTransactionOpen = true;
        const uncommittedRevision = await reviseLegalDocumentDraft(
          revisionDb,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "revise-revision-lock",
          ),
          1,
          { ...revisionLockV1, contentSha256: "d".repeat(64) },
        );
        assert(uncommittedRevision.kind === "revised");
        blockedPublish = publishLegalDocument(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "publish-revision-lock",
          ),
          revisionLockCreated.documentId,
        );
        await assertPromisePending(blockedPublish);
        await revisionClient.query("commit");
        revisionTransactionOpen = false;
        const stalePublish = await blockedPublish;
        assert(stalePublish.kind === "revision_conflict");
        assertEquals(stalePublish.actualRevision, 2);
      } finally {
        if (revisionTransactionOpen) await revisionClient.query("rollback");
        if (blockedPublish !== undefined) {
          await blockedPublish.catch(() => undefined);
        }
        await revisionClient.end();
      }
      assertEquals(
        (await listPublishedLegalDocuments(db)).some((entry) =>
          entry.documentType === revisionLockV1.documentType
        ),
        false,
      );

      const acceptanceLockDocument = legalInput(
        fixture,
        "acceptance_lock_terms",
        "2026-lock",
        "e".repeat(64),
      );
      const acceptanceLockCreated = await createLegalDocumentDraft(
        db,
        mutationContext(
          fixture,
          fixture.freshAdminSessionId,
          "create-acceptance-lock",
        ),
        acceptanceLockDocument,
      );
      assert(
        acceptanceLockCreated.kind === "created" &&
          acceptanceLockCreated.documentId !== undefined,
      );
      assertEquals(
        (await publishLegalDocument(
          db,
          mutationContext(
            fixture,
            fixture.freshAdminSessionId,
            "publish-acceptance-lock",
          ),
          acceptanceLockCreated.documentId,
        )).kind,
        "published",
      );
      const publicationClient = new pg.Client({
        connectionString: appUrl.toString(),
      });
      await publicationClient.connect();
      const publicationDb = asQueryable(publicationClient);
      let publicationTransactionOpen = false;
      let blockedAcceptance: ReturnType<typeof acceptLegalDocument> | undefined;
      try {
        await publicationClient.query("begin");
        publicationTransactionOpen = true;
        assertEquals(
          (await unpublishLegalDocument(
            publicationDb,
            mutationContext(
              fixture,
              fixture.freshAdminSessionId,
              "unpublish-acceptance-lock",
            ),
            acceptanceLockDocument.documentType,
            acceptanceLockCreated.documentId,
          )).kind,
          "unpublished",
        );
        blockedAcceptance = acceptLegalDocument(
          db,
          { sessionId: fixture.memberSessionId },
          {
            documentType: acceptanceLockDocument.documentType,
            version: acceptanceLockDocument.version,
            revision: 1,
            contentSha256: acceptanceLockDocument.contentSha256,
            acceptanceScope: "user",
          },
        );
        await assertPromisePending(blockedAcceptance);
        await publicationClient.query("commit");
        publicationTransactionOpen = false;
        assertEquals((await blockedAcceptance).kind, "not_current");
      } finally {
        if (publicationTransactionOpen) {
          await publicationClient.query("rollback");
        }
        if (blockedAcceptance !== undefined) {
          await blockedAcceptance.catch(() => undefined);
        }
        await publicationClient.end();
      }

      const auditState = await owner.query<{
        changelog_audits: string;
        legal_audits: string;
        acceptance_audits: string;
      }>(
        `select
           count(*) filter (where action like 'changelog.%')::text
             as changelog_audits,
           count(*) filter (where action like 'legal_document.%')::text
             as legal_audits,
           count(*) filter (where action = 'legal_document.accept')::text
             as acceptance_audits
         from relay.audit_events
         where actor_user_id = any($1::text[])
            or pg_catalog.left(coalesce(request_id, ''), $2) = $3`,
        [
          [...fixture.userIds],
          fixture.requestPrefix.length,
          fixture.requestPrefix,
        ],
      );
      assert(Number(auditState.rows[0]?.changelog_audits) > 0);
      assert(Number(auditState.rows[0]?.legal_audits) > 0);
      assert(Number(auditState.rows[0]?.acceptance_audits) >= 6);
    } finally {
      try {
        await app.end();
      } finally {
        try {
          if (fixtureCreated) await cleanupFixture(owner, fixture);
        } finally {
          await owner.query("reset role");
          await owner.query(
            "select pg_advisory_unlock(pg_catalog.hashtextextended('relay.changelog.postgres-test', 0))",
          );
          await owner.end();
        }
      }
    }
  },
});
