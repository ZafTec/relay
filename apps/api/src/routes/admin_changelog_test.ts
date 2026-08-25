import { assertEquals, assertThrows } from "@std/assert";
import type { Auth } from "@relay/auth";
import { GovernanceIdempotencyConflictError } from "@relay/changelog";
import {
  type AdminChangelogDraftInput,
  type AdminChangelogRelease,
  adminChangelogReleasePath,
  type AdminChangelogSummary,
  type ErrorCode,
  errorEnvelopeSchema,
  HTTP_PATHS,
  type PublicErrorDetails,
} from "@relay/contracts";
import {
  type AdminChangelogService,
  createAdminChangelogRoutes,
} from "./admin_changelog.ts";

const REQUEST_ID = "req_admin-changelog-0001";
const SESSION_ID = "session-admin-0001";
const ORIGIN = "https://console.relay.test";
const IDEMPOTENCY_KEY = "admin-change-0001";
const NOW = "2026-08-25T10:00:00.000Z";

const DRAFT: AdminChangelogDraftInput = {
  version: "1.2.3",
  slug: "release-1-2-3",
  title: "Relay 1.2.3",
  summary: "A reviewed release.",
  gitTag: "v1.2.3",
  commitSha: "a".repeat(40),
  releasedAt: NOW,
  items: [{
    category: "added",
    area: "API",
    title: "Admin changelog",
    description: "Superadmins can manage changelog releases.",
    sortOrder: 0,
  }],
};

const SUMMARY: AdminChangelogSummary = {
  releaseId: "42",
  version: DRAFT.version,
  slug: DRAFT.slug,
  status: "draft",
  latestRevision: 1,
  publishedRevision: null,
  hasUnpublishedChanges: true,
  updatedAt: NOW,
};

const RELEASE: AdminChangelogRelease = {
  releaseId: "42",
  status: "draft",
  latestRevision: 1,
  publishedRevision: null,
  hasUnpublishedChanges: true,
  firstPublishedAt: null,
  lastPublishedAt: null,
  latest: {
    ...DRAFT,
    contentSha256: "b".repeat(64),
  },
  published: null,
};

const AUTH_SESSION = {
  session: {
    id: SESSION_ID,
    userId: "user-admin-0001",
    createdAt: new Date(NOW),
    activeOrganizationId: "workspace-must-not-be-used",
    isSuperadmin: false,
  },
  user: {
    id: "user-must-not-be-used",
    email: "admin@relay.test",
    name: "Relay Admin",
  },
};

function fakeAuth(
  getSession: () => Promise<typeof AUTH_SESSION | null> = () =>
    Promise.resolve(AUTH_SESSION),
): Auth {
  return {
    api: { getSession },
  } as unknown as Auth;
}

function service(
  overrides: Partial<AdminChangelogService> = {},
): AdminChangelogService {
  return {
    list: () => Promise.resolve({ kind: "ok", value: [SUMMARY] }),
    get: () => Promise.resolve({ kind: "ok", value: RELEASE }),
    create: () =>
      Promise.resolve({
        kind: "created",
        replayed: false,
        releaseId: RELEASE.releaseId,
        revision: 1,
      }),
    revise: () =>
      Promise.resolve({
        kind: "revised",
        replayed: false,
        releaseId: RELEASE.releaseId,
        revision: 2,
      }),
    publish: () =>
      Promise.resolve({
        kind: "published",
        replayed: false,
        releaseId: RELEASE.releaseId,
        revision: 1,
        supersededRevision: null,
      }),
    unpublish: () =>
      Promise.resolve({
        kind: "unpublished",
        replayed: false,
        releaseId: RELEASE.releaseId,
        revision: 1,
      }),
    ...overrides,
  };
}

function routes(
  overrides: Partial<AdminChangelogService> = {},
  auth: Auth = fakeAuth(),
  options: {
    readonly maxJsonBodyBytes?: number;
    readonly allowedOrigins?: readonly string[];
    readonly onUnexpectedError?: (
      error: unknown,
      requestId: string,
      routePath: string,
    ) => void;
  } = {},
) {
  return createAdminChangelogRoutes({
    auth,
    service: service(overrides),
    allowedOrigins: options.allowedOrigins ?? [ORIGIN],
    createRequestId: () => REQUEST_ID,
    ...(options.maxJsonBodyBytes === undefined
      ? {}
      : { maxJsonBodyBytes: options.maxJsonBodyBytes }),
    ...(options.onUnexpectedError === undefined
      ? {}
      : { onUnexpectedError: options.onUnexpectedError }),
  });
}

function mutationRequest(
  method: "POST" | "PATCH",
  body: unknown,
  options: {
    readonly origin?: string | null;
    readonly idempotencyKey?: string | null;
    readonly rawBody?: boolean;
  } = {},
): RequestInit {
  const headers = new Headers({ "content-type": "application/json" });
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const idempotencyKey = options.idempotencyKey === undefined
    ? IDEMPOTENCY_KEY
    : options.idempotencyKey;
  if (origin !== null) headers.set("origin", origin);
  if (idempotencyKey !== null) {
    headers.set("idempotency-key", idempotencyKey);
  }
  return {
    method,
    headers,
    body: options.rawBody ? String(body) : JSON.stringify(body),
  };
}

function assertAdminHeaders(response: Response): void {
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
  assertEquals(response.headers.get("x-request-id"), REQUEST_ID);
}

async function assertError(
  response: Response,
  status: number,
  code: ErrorCode,
  details?: PublicErrorDetails,
): Promise<void> {
  assertEquals(response.status, status);
  assertAdminHeaders(response);
  const envelope = errorEnvelopeSchema.parse(await response.json());
  assertEquals(envelope.error.code, code);
  if (details !== undefined) assertEquals(envelope.error.details, details);
}

Deno.test("admin changelog reads use only the Better Auth session ID", async () => {
  let listArguments: unknown;
  let getArguments: unknown;
  let authCalls = 0;
  const app = routes(
    {
      list(session, request) {
        listArguments = { session, request };
        return Promise.resolve({ kind: "ok", value: [SUMMARY] });
      },
      get(session, releaseId) {
        getArguments = { session, releaseId };
        return Promise.resolve({ kind: "ok", value: RELEASE });
      },
    },
    fakeAuth(() => {
      authCalls += 1;
      return Promise.resolve(AUTH_SESSION);
    }),
  );

  const list = await app.request(
    `${HTTP_PATHS.adminChangelog}?limit=1&beforeReleaseId=43`,
  );
  assertEquals(list.status, 200);
  assertEquals(await list.json(), { releases: [SUMMARY] });
  assertEquals(listArguments, {
    session: { sessionId: SESSION_ID },
    request: { limit: 1, beforeReleaseId: "43" },
  });
  assertAdminHeaders(list);

  const detail = await app.request(
    adminChangelogReleasePath(RELEASE.releaseId),
  );
  assertEquals(detail.status, 200);
  assertEquals(await detail.json(), RELEASE);
  assertEquals(getArguments, {
    session: { sessionId: SESSION_ID },
    releaseId: RELEASE.releaseId,
  });
  assertAdminHeaders(detail);
  assertEquals(authCalls, 2);
});

Deno.test("admin changelog create validates input and preserves replay metadata", async () => {
  let received: unknown;
  const result = {
    kind: "created" as const,
    replayed: true,
    releaseId: RELEASE.releaseId,
    revision: 1,
  };
  const app = routes({
    create(context, input) {
      received = { context, input };
      return Promise.resolve(result);
    },
  });

  const response = await app.request(
    HTTP_PATHS.adminChangelog,
    mutationRequest("POST", DRAFT),
  );

  assertEquals(response.status, 201);
  assertEquals(
    response.headers.get("location"),
    adminChangelogReleasePath("42"),
  );
  assertEquals(await response.json(), result);
  assertEquals(received, {
    context: {
      sessionId: SESSION_ID,
      idempotencyKey: IDEMPOTENCY_KEY,
      requestId: REQUEST_ID,
    },
    input: DRAFT,
  });
  assertAdminHeaders(response);
});

Deno.test("mutation origins are rejected before session lookup", async () => {
  let authCalls = 0;
  const app = routes(
    {},
    fakeAuth(() => {
      authCalls += 1;
      return Promise.resolve(AUTH_SESSION);
    }),
  );

  for (
    const origin of [
      null,
      `${ORIGIN}/`,
      "ftp://console.relay.test",
      "https://attacker.test",
    ]
  ) {
    const response = await app.request(
      HTTP_PATHS.adminChangelog,
      mutationRequest("POST", "{", {
        origin,
        rawBody: true,
      }),
    );
    await assertError(response, 403, "authorization_denied", {});
  }
  await assertError(
    await app.request(
      adminChangelogReleasePath("42"),
      mutationRequest("PATCH", { expectedRevision: 1, ...DRAFT }, {
        origin: null,
      }),
    ),
    403,
    "authorization_denied",
    {},
  );
  assertEquals(authCalls, 0);

  const trusted = await app.request(
    HTTP_PATHS.adminChangelog,
    mutationRequest("POST", "{", { rawBody: true }),
  );
  await assertError(trusted, 400, "invalid_request", {
    field: "body",
    reason: "malformed_json",
  });
  assertEquals(authCalls, 1);
});

Deno.test("configured mutation origins are normalized and safely bounded", async () => {
  assertThrows(
    () => {
      createAdminChangelogRoutes({
        auth: fakeAuth(),
        service: service(),
        allowedOrigins: [],
      });
    },
    TypeError,
    "allowedOrigins",
  );

  for (
    const origin of [
      "ftp://console.relay.test",
      "console.relay.test",
      `${ORIGIN}/nested`,
      `${ORIGIN}?tenant=1`,
      "https://user@console.relay.test",
    ]
  ) {
    assertThrows(
      () => {
        createAdminChangelogRoutes({
          auth: fakeAuth(),
          service: service(),
          allowedOrigins: [origin],
        });
      },
      TypeError,
      "allowedOrigins",
    );
  }

  const normalized = routes({}, fakeAuth(), {
    allowedOrigins: ["HTTPS://CONSOLE.RELAY.TEST/"],
  });
  await assertError(
    await normalized.request(
      HTTP_PATHS.adminChangelog,
      mutationRequest("POST", "{", { rawBody: true }),
    ),
    400,
    "invalid_request",
    { field: "body", reason: "malformed_json" },
  );
});

Deno.test("missing sessions return authentication_required without service access", async () => {
  let serviceCalls = 0;
  const app = routes({
    list: () => {
      serviceCalls += 1;
      return Promise.resolve({ kind: "ok", value: [] });
    },
    create: () => {
      serviceCalls += 1;
      return Promise.resolve({
        kind: "created",
        replayed: false,
        releaseId: "42",
        revision: 1,
      });
    },
  }, fakeAuth(() => Promise.resolve(null)));

  await assertError(
    await app.request(HTTP_PATHS.adminChangelog),
    401,
    "authentication_required",
    {},
  );
  await assertError(
    await app.request(
      HTTP_PATHS.adminChangelog,
      mutationRequest("POST", DRAFT),
    ),
    401,
    "authentication_required",
    {},
  );
  assertEquals(serviceCalls, 0);
});

Deno.test("database authorization and freshness outcomes map to safe HTTP errors", async () => {
  await assertError(
    await routes({
      list: () => Promise.resolve({ kind: "denied" }),
    }).request(HTTP_PATHS.adminChangelog),
    403,
    "authorization_denied",
    {},
  );

  await assertError(
    await routes({
      get: () => Promise.resolve({ kind: "reauthentication_required" }),
    }).request(adminChangelogReleasePath("42")),
    401,
    "reauthentication_required",
    {},
  );

  await assertError(
    await routes({
      get: () => Promise.resolve({ kind: "not_found" }),
    }).request(adminChangelogReleasePath("42")),
    404,
    "not_found",
    { resource: "changelog_release" },
  );

  await assertError(
    await routes({
      create: () => Promise.resolve({ kind: "denied", replayed: false }),
    }).request(
      HTTP_PATHS.adminChangelog,
      mutationRequest("POST", DRAFT),
    ),
    403,
    "authorization_denied",
    {},
  );

  await assertError(
    await routes({
      unpublish: () =>
        Promise.resolve({
          kind: "reauthentication_required",
          replayed: false,
        }),
    }).request(
      `${adminChangelogReleasePath("42")}/unpublish`,
      mutationRequest("POST", { expectedPublishedRevision: 1 }),
    ),
    401,
    "reauthentication_required",
    {},
  );
});

Deno.test("idempotency keys are validated before mutation bodies", async () => {
  let createCalls = 0;
  const app = routes({
    create: () => {
      createCalls += 1;
      return Promise.resolve({
        kind: "created",
        replayed: false,
        releaseId: "42",
        revision: 1,
      });
    },
  });

  for (
    const idempotencyKey of [null, "short", "invalid key with spaces"]
  ) {
    const response = await app.request(
      HTTP_PATHS.adminChangelog,
      mutationRequest("POST", "{", {
        idempotencyKey,
        rawBody: true,
      }),
    );
    await assertError(response, 400, "invalid_request", {
      field: "idempotency-key",
      reason: idempotencyKey === null ? "missing_header" : "invalid_header",
    });
  }
  assertEquals(createCalls, 0);
});

Deno.test("governance idempotency conflicts map to 409 without error reporting", async () => {
  let reports = 0;
  const response = await routes(
    {
      publish: () => Promise.reject(new GovernanceIdempotencyConflictError()),
    },
    fakeAuth(),
    { onUnexpectedError: () => reports += 1 },
  ).request(
    `${adminChangelogReleasePath("42")}/publish`,
    mutationRequest("POST", { expectedRevision: 1 }),
  );

  await assertError(response, 409, "idempotency_conflict", {});
  assertEquals(reports, 0);
});

Deno.test("admin changelog rejects unsupported query, path, body, and method shapes", async () => {
  const app = routes();
  for (
    const path of [
      `${HTTP_PATHS.adminChangelog}?cursor=opaque`,
      `${HTTP_PATHS.adminChangelog}?limit=1&limit=2`,
      `${HTTP_PATHS.adminChangelog}?limit=0`,
      `${HTTP_PATHS.adminChangelog}?beforeReleaseId=0`,
    ]
  ) {
    await assertError(
      await app.request(path),
      400,
      "invalid_request",
    );
  }

  await assertError(
    await app.request(`${adminChangelogReleasePath("42")}?expand=revisions`),
    400,
    "invalid_request",
    { field: "expand", reason: "unsupported_query_parameter" },
  );
  await assertError(
    await app.request(
      `${adminChangelogReleasePath("42")}/publish?force=true`,
      mutationRequest("POST", { expectedRevision: 1 }),
    ),
    400,
    "invalid_request",
    { field: "force", reason: "unsupported_query_parameter" },
  );
  await assertError(
    await app.request(adminChangelogReleasePath("0")),
    404,
    "not_found",
    { resource: "changelog_release" },
  );
  await assertError(
    await app.request(adminChangelogReleasePath("9223372036854775808")),
    404,
    "not_found",
    { resource: "changelog_release" },
  );
  await assertError(
    await app.request(adminChangelogReleasePath("42"), { method: "DELETE" }),
    404,
    "not_found",
    { resource: "changelog_release" },
  );

  await assertError(
    await app.request(
      HTTP_PATHS.adminChangelog,
      mutationRequest("POST", { ...DRAFT, actorUserId: "forged-user" }),
    ),
    400,
    "invalid_request",
  );
  await assertError(
    await app.request(
      `${adminChangelogReleasePath("42")}/publish`,
      mutationRequest("POST", {
        expectedRevision: 1,
        sessionId: "forged-session",
      }),
    ),
    400,
    "invalid_request",
  );

  const tooLarge = routes({}, fakeAuth(), { maxJsonBodyBytes: 32 });
  await assertError(
    await tooLarge.request(
      HTTP_PATHS.adminChangelog,
      mutationRequest("POST", DRAFT),
    ),
    413,
    "invalid_request",
    { field: "body", reason: "body_too_large" },
  );
});

Deno.test("revise maps success, identity, revision, and resource outcomes", async () => {
  const path = adminChangelogReleasePath("42");
  const body = { expectedRevision: 1, ...DRAFT };
  const successes = [
    {
      kind: "revised" as const,
      replayed: false,
      releaseId: "42",
      revision: 2,
    },
    {
      kind: "unchanged" as const,
      replayed: true,
      releaseId: "42",
      revision: 1,
    },
  ];
  for (const result of successes) {
    const response = await routes({
      revise: () => Promise.resolve(result),
    }).request(path, mutationRequest("PATCH", body));
    assertEquals(response.status, 200);
    assertEquals(await response.json(), result);
    assertAdminHeaders(response);
  }

  const cases = [
    {
      result: {
        kind: "revision_conflict",
        replayed: false,
        releaseId: "42",
        actualRevision: 7,
      },
      status: 409,
      code: "invalid_request" as const,
      details: { reason: "revision_conflict", actualRevision: 7 },
    },
    {
      result: {
        kind: "identity_locked",
        replayed: false,
        releaseId: "42",
        revision: 1,
      },
      status: 409,
      code: "invalid_request" as const,
      details: { reason: "identity_locked", actualRevision: 1 },
    },
    {
      result: {
        kind: "conflict",
        replayed: false,
        releaseId: "42",
        reason: "slug",
      },
      status: 409,
      code: "invalid_request" as const,
      details: { reason: "slug" },
    },
    {
      result: { kind: "not_found", replayed: false },
      status: 404,
      code: "not_found" as const,
      details: { resource: "changelog_release" },
    },
  ];
  for (const testCase of cases) {
    const response = await routes({
      revise: () => Promise.resolve(testCase.result as never),
    }).request(path, mutationRequest("PATCH", body));
    await assertError(
      response,
      testCase.status,
      testCase.code,
      testCase.details as PublicErrorDetails,
    );
  }
});

Deno.test("create identity conflicts map to safe 409 details", async () => {
  for (const reason of ["version", "slug", "version_and_slug"] as const) {
    const response = await routes({
      create: () =>
        Promise.resolve({ kind: "conflict", replayed: false, reason }),
    }).request(
      HTTP_PATHS.adminChangelog,
      mutationRequest("POST", DRAFT),
    );
    await assertError(response, 409, "invalid_request", { reason });
  }
});

Deno.test("publish maps successful and rejected domain outcomes", async () => {
  const path = `${adminChangelogReleasePath("42")}/publish`;
  const successes = [
    {
      kind: "published" as const,
      replayed: false,
      releaseId: "42",
      revision: 2,
      supersededRevision: null,
    },
    {
      kind: "superseded" as const,
      replayed: true,
      releaseId: "42",
      revision: 2,
      supersededRevision: 1,
    },
    {
      kind: "unchanged" as const,
      replayed: true,
      releaseId: "42",
      revision: 2,
      supersededRevision: null,
    },
  ];
  for (const result of successes) {
    const response = await routes({
      publish: () => Promise.resolve(result),
    }).request(
      path,
      mutationRequest("POST", { expectedRevision: 2 }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), result);
    assertAdminHeaders(response);
  }

  const cases = [
    {
      result: {
        kind: "revision_conflict",
        replayed: false,
        releaseId: "42",
        actualRevision: 3,
      },
      status: 409,
      code: "invalid_request" as const,
      details: { reason: "revision_conflict", actualRevision: 3 },
    },
    {
      result: {
        kind: "not_publishable",
        replayed: false,
        releaseId: "42",
        revision: 2,
        reasons: ["missing_git_tag", "missing_items"],
      },
      status: 422,
      code: "invalid_request" as const,
      details: {
        reason: "not_publishable",
        reasons: ["missing_git_tag", "missing_items"],
      },
    },
    {
      result: { kind: "not_found", replayed: false },
      status: 404,
      code: "not_found" as const,
      details: { resource: "changelog_release" },
    },
  ];
  for (const testCase of cases) {
    const response = await routes({
      publish: () => Promise.resolve(testCase.result as never),
    }).request(
      path,
      mutationRequest("POST", { expectedRevision: 2 }),
    );
    await assertError(
      response,
      testCase.status,
      testCase.code,
      testCase.details as PublicErrorDetails,
    );
  }
});

Deno.test("unpublish maps successful, stale, and missing outcomes", async () => {
  const path = `${adminChangelogReleasePath("42")}/unpublish`;
  const successes = [
    {
      kind: "unpublished" as const,
      replayed: false,
      releaseId: "42",
      revision: 2,
    },
    {
      kind: "unchanged" as const,
      replayed: true,
      releaseId: "42",
      revision: null,
    },
  ];
  for (const result of successes) {
    const response = await routes({
      unpublish: () => Promise.resolve(result),
    }).request(
      path,
      mutationRequest("POST", { expectedPublishedRevision: 2 }),
    );
    assertEquals(response.status, 200);
    assertEquals(await response.json(), result);
    assertAdminHeaders(response);
  }

  const stale = await routes({
    unpublish: () =>
      Promise.resolve({
        kind: "revision_conflict",
        replayed: false,
        releaseId: "42",
        actualRevision: 3,
      }),
  }).request(
    path,
    mutationRequest("POST", { expectedPublishedRevision: 2 }),
  );
  await assertError(stale, 409, "invalid_request", {
    reason: "revision_conflict",
    actualRevision: 3,
  });

  const missing = await routes({
    unpublish: () => Promise.resolve({ kind: "not_found", replayed: false }),
  }).request(
    path,
    mutationRequest("POST", { expectedPublishedRevision: 2 }),
  );
  await assertError(missing, 404, "not_found", {
    resource: "changelog_release",
  });
});

Deno.test("service outputs are parsed and internal failures are redacted", async () => {
  const invalidRead = await routes({
    list: () =>
      Promise.resolve({
        kind: "ok",
        value: [{ ...SUMMARY, releaseId: "database-secret" }],
      } as never),
  }).request(HTTP_PATHS.adminChangelog);
  const invalidReadBody = await invalidRead.clone().text();
  await assertError(invalidRead, 500, "internal_error", {});
  assertEquals(invalidReadBody.includes("database-secret"), false);

  const invalidMutation = await routes({
    publish: () =>
      Promise.resolve({
        kind: "published",
        replayed: false,
        releaseId: "42",
        revision: 1,
        supersededRevision: null,
        rawDatabaseValue: "database-secret",
      } as never),
  }).request(
    `${adminChangelogReleasePath("42")}/publish`,
    mutationRequest("POST", { expectedRevision: 1 }),
  );
  const invalidMutationBody = await invalidMutation.clone().text();
  await assertError(invalidMutation, 500, "internal_error", {});
  assertEquals(invalidMutationBody.includes("database-secret"), false);

  let reported: {
    readonly error: unknown;
    readonly requestId: string;
    readonly routePath: string;
  } | undefined;
  const thrown = await routes(
    {
      create: () =>
        Promise.reject(new Error("postgres password=database-secret")),
    },
    fakeAuth(),
    {
      onUnexpectedError: (error, requestId, routePath) => {
        reported = { error, requestId, routePath };
      },
    },
  ).request(
    HTTP_PATHS.adminChangelog,
    mutationRequest("POST", DRAFT),
  );
  const thrownBody = await thrown.clone().text();
  await assertError(thrown, 500, "internal_error", {});
  assertEquals(thrownBody.includes("database-secret"), false);
  assertEquals(reported?.requestId, REQUEST_ID);
  assertEquals(reported?.routePath, HTTP_PATHS.adminChangelog);
  assertEquals(reported?.error instanceof Error, true);
});
