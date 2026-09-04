import { assertEquals, assertThrows } from "@std/assert";
import type { Auth } from "@relay/auth";
import type { CapacityPolicy } from "../../../../packages/catalog/src/capacity-policies.ts";
import {
  type ErrorCode,
  errorEnvelopeSchema,
  type PublicErrorDetails,
} from "@relay/contracts";
import {
  ADMIN_CAPACITY_POLICIES_PATH,
  ADMIN_CAPACITY_POLICY_PATH,
  adminCapacityPolicyPath,
  type AdminCapacityService,
  createAdminCapacityRoutes,
} from "./admin_capacity.ts";

const REQUEST_ID = "req_admin-capacity-0001";
const SESSION_ID = "session-admin-capacity-0001";
const ORIGIN = "https://console.relay.test";
const IDEMPOTENCY_KEY = "capacity-change-0001";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;
const NOW = "2026-08-25T10:00:00.000Z";
const SCOPE_TYPE = "tool";
const SCOPE_ID = "tool_11111111111111111111111111111111";
const CONFIGURATION = {
  customLimits: {
    enabled: true,
    labels: ["interactive", null],
  },
  submissionRateDefaults: {
    providerPerMinute: 12,
  },
};
const CANONICAL_CONFIGURATION =
  '{"customLimits":{"enabled":true,"labels":["interactive",null]},"submissionRateDefaults":{"providerPerMinute":12}}';

const POLICY: CapacityPolicy = {
  policyId: "42",
  scopeType: SCOPE_TYPE,
  scopeId: SCOPE_ID,
  revision: 1,
  configuration: CONFIGURATION,
  canonicalJson: CANONICAL_CONFIGURATION,
  immutableHash: "a".repeat(64),
  effectiveAt: NOW,
  expiresAt: null,
};

const AUTH_SESSION = {
  session: {
    id: SESSION_ID,
    userId: "user-must-not-be-used",
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
  getSession: () => Promise<unknown> = () => Promise.resolve(AUTH_SESSION),
): Auth {
  return {
    api: { getSession },
  } as unknown as Auth;
}

function service(
  overrides: Partial<AdminCapacityService> = {},
): AdminCapacityService {
  return {
    list: () => Promise.resolve({ kind: "ok", value: [POLICY] }),
    get: () => Promise.resolve({ kind: "ok", value: POLICY }),
    revise: () =>
      Promise.resolve({
        kind: "revised",
        value: POLICY,
        replayed: false,
      }),
    ...overrides,
  };
}

function routes(
  overrides: Partial<AdminCapacityService> = {},
  auth: Auth = fakeAuth(),
  options: {
    readonly allowedOrigins?: readonly string[];
    readonly maxJsonBodyBytes?: number;
    readonly maxQueryBytes?: number;
    readonly createRequestId?: () => string;
    readonly onUnexpectedError?: (
      error: unknown,
      requestId: string,
      routePath: string,
    ) => void;
  } = {},
) {
  return createAdminCapacityRoutes({
    auth,
    service: service(overrides),
    allowedOrigins: options.allowedOrigins ?? [ORIGIN],
    createRequestId: options.createRequestId ?? (() => REQUEST_ID),
    ...(options.maxJsonBodyBytes === undefined
      ? {}
      : { maxJsonBodyBytes: options.maxJsonBodyBytes }),
    ...(options.maxQueryBytes === undefined
      ? {}
      : { maxQueryBytes: options.maxQueryBytes }),
    ...(options.onUnexpectedError === undefined
      ? {}
      : { onUnexpectedError: options.onUnexpectedError }),
  });
}

function mutationRequest(
  body: unknown,
  options: {
    readonly origin?: string | null;
    readonly idempotencyKey?: string | null;
    readonly traceparent?: string | null;
    readonly rawBody?: boolean;
    readonly contentType?: string | null;
  } = {},
): RequestInit {
  const headers = new Headers();
  const contentType = options.contentType === undefined
    ? "application/json"
    : options.contentType;
  const origin = options.origin === undefined ? ORIGIN : options.origin;
  const idempotencyKey = options.idempotencyKey === undefined
    ? IDEMPOTENCY_KEY
    : options.idempotencyKey;
  const traceparent = options.traceparent === undefined
    ? TRACEPARENT
    : options.traceparent;
  if (contentType !== null) headers.set("content-type", contentType);
  if (origin !== null) headers.set("origin", origin);
  if (idempotencyKey !== null) {
    headers.set("idempotency-key", idempotencyKey);
  }
  if (traceparent !== null) headers.set("traceparent", traceparent);
  return {
    method: "POST",
    headers,
    body: options.rawBody ? String(body) : JSON.stringify(body),
  };
}

function reviseBody(overrides: Record<string, unknown> = {}) {
  return {
    expectedRevision: 0,
    configuration: CONFIGURATION,
    effectiveAt: NOW,
    expiresAt: null,
    ...overrides,
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

Deno.test("admin capacity reads pass only the Better Auth session ID and audit correlation", async () => {
  const listCalls: unknown[] = [];
  const getCalls: unknown[] = [];
  let authCalls = 0;
  const app = routes(
    {
      list(session, options) {
        listCalls.push({ session, options });
        return Promise.resolve({ kind: "ok", value: [POLICY] });
      },
      get(session, input) {
        getCalls.push({ session, input });
        return Promise.resolve({ kind: "ok", value: POLICY });
      },
    },
    fakeAuth(() => {
      authCalls += 1;
      return Promise.resolve(AUTH_SESSION);
    }),
  );
  const headers = { traceparent: TRACEPARENT };

  const listed = await app.request(
    `${ADMIN_CAPACITY_POLICIES_PATH}?scopeType=tool&scopeId=${SCOPE_ID}&includeHistory=true&limit=2`,
    { headers },
  );
  assertEquals(listed.status, 200);
  assertEquals(await listed.json(), { policies: [POLICY] });
  assertEquals(listCalls, [{
    session: { sessionId: SESSION_ID },
    options: {
      scopeType: SCOPE_TYPE,
      scopeId: SCOPE_ID,
      includeHistory: true,
      effectiveAt: null,
      limit: 2,
      requestId: REQUEST_ID,
      traceId: TRACE_ID,
    },
  }]);
  assertAdminHeaders(listed);

  const exact = await app.request(
    `${adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID)}?revision=1`,
    { headers },
  );
  assertEquals(exact.status, 200);
  assertEquals(await exact.json(), POLICY);
  assertAdminHeaders(exact);

  const current = await app.request(
    `${adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID)}?effectiveAt=${
      encodeURIComponent(NOW)
    }`,
    { headers },
  );
  assertEquals(current.status, 200);
  assertEquals(await current.json(), POLICY);
  assertEquals(getCalls, [
    {
      session: { sessionId: SESSION_ID },
      input: {
        scopeType: SCOPE_TYPE,
        scopeId: SCOPE_ID,
        revision: 1,
        effectiveAt: null,
        requestId: REQUEST_ID,
        traceId: TRACE_ID,
      },
    },
    {
      session: { sessionId: SESSION_ID },
      input: {
        scopeType: SCOPE_TYPE,
        scopeId: SCOPE_ID,
        effectiveAt: NOW,
        requestId: REQUEST_ID,
        traceId: TRACE_ID,
      },
    },
  ]);
  assertEquals(authCalls, 3);
});

Deno.test("admin capacity revise preserves generic JSON and server-owned identity", async () => {
  let received: unknown;
  const app = routes({
    revise(session, input) {
      received = { session, input };
      return Promise.resolve({
        kind: "revised",
        value: POLICY,
        replayed: true,
      });
    },
  });

  const response = await app.request(
    adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID),
    mutationRequest(reviseBody()),
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), {
    kind: "revised",
    value: POLICY,
    replayed: true,
  });
  assertEquals(received, {
    session: { sessionId: SESSION_ID },
    input: {
      scopeType: SCOPE_TYPE,
      scopeId: SCOPE_ID,
      expectedRevision: 0,
      configuration: CONFIGURATION,
      effectiveAt: NOW,
      expiresAt: null,
      mutationKey: IDEMPOTENCY_KEY,
      requestId: REQUEST_ID,
      traceId: TRACE_ID,
    },
  });
  assertAdminHeaders(response);
});

Deno.test("mutation origins are exact and rejected before session lookup", async () => {
  let authCalls = 0;
  const app = routes(
    {},
    fakeAuth(() => {
      authCalls += 1;
      return Promise.resolve(AUTH_SESSION);
    }),
  );
  const path = adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID);

  for (
    const origin of [
      null,
      `${ORIGIN}/`,
      "ftp://console.relay.test",
      "https://attacker.test",
    ]
  ) {
    await assertError(
      await app.request(
        path,
        mutationRequest("{", { origin, rawBody: true }),
      ),
      403,
      "authorization_denied",
      {},
    );
  }
  assertEquals(authCalls, 0);

  const trusted = await app.request(
    path,
    mutationRequest("{", { rawBody: true }),
  );
  await assertError(trusted, 400, "invalid_request", {
    field: "body",
    reason: "malformed_json",
  });
  assertEquals(authCalls, 1);
});

Deno.test("route configuration normalizes origins and bounds body and query limits", async () => {
  assertThrows(
    () =>
      createAdminCapacityRoutes({
        auth: fakeAuth(),
        service: service(),
        allowedOrigins: [],
      }),
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
      () =>
        createAdminCapacityRoutes({
          auth: fakeAuth(),
          service: service(),
          allowedOrigins: [origin],
        }),
      TypeError,
      "allowedOrigins",
    );
  }

  for (const maxJsonBodyBytes of [0, 16 * 1024 * 1024 + 1, 1.5]) {
    assertThrows(
      () => routes({}, fakeAuth(), { maxJsonBodyBytes }),
      TypeError,
      "maxJsonBodyBytes",
    );
  }
  for (const maxQueryBytes of [0, 64 * 1024 + 1, 1.5]) {
    assertThrows(
      () => routes({}, fakeAuth(), { maxQueryBytes }),
      TypeError,
      "maxQueryBytes",
    );
  }

  const normalized = routes({}, fakeAuth(), {
    allowedOrigins: ["HTTPS://CONSOLE.RELAY.TEST/"],
  });
  await assertError(
    await normalized.request(
      adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID),
      mutationRequest("{", { rawBody: true }),
    ),
    400,
    "invalid_request",
    { field: "body", reason: "malformed_json" },
  );
});

Deno.test("missing or malformed sessions fail before service access", async () => {
  let serviceCalls = 0;
  const overrides: Partial<AdminCapacityService> = {
    list: () => {
      serviceCalls += 1;
      return Promise.resolve({ kind: "ok", value: [] });
    },
    revise: () => {
      serviceCalls += 1;
      return Promise.resolve({
        kind: "revised",
        value: POLICY,
        replayed: false,
      });
    },
  };

  for (
    const session of [
      null,
      { ...AUTH_SESSION, session: { ...AUTH_SESSION.session, id: " " } },
      {
        ...AUTH_SESSION,
        session: { ...AUTH_SESSION.session, id: "s".repeat(257) },
      },
    ]
  ) {
    const app = routes(overrides, fakeAuth(() => Promise.resolve(session)));
    await assertError(
      await app.request(ADMIN_CAPACITY_POLICIES_PATH),
      401,
      "authentication_required",
      {},
    );
    await assertError(
      await app.request(
        adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID),
        mutationRequest(reviseBody()),
      ),
      401,
      "authentication_required",
      {},
    );
  }
  assertEquals(serviceCalls, 0);
});

Deno.test("catalog authorization, freshness, and absence map without resource disclosure", async () => {
  await assertError(
    await routes({
      list: () => Promise.resolve({ kind: "denied" }),
    }).request(ADMIN_CAPACITY_POLICIES_PATH),
    403,
    "authorization_denied",
    {},
  );

  await assertError(
    await routes({
      get: () => Promise.resolve({ kind: "reauthentication_required" }),
    }).request(adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID)),
    401,
    "reauthentication_required",
    {},
  );

  await assertError(
    await routes({
      get: () => Promise.resolve({ kind: "not_found" }),
    }).request(adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID)),
    404,
    "not_found",
    {},
  );

  await assertError(
    await routes({
      revise: () => Promise.resolve({ kind: "denied", replayed: false }),
    }).request(
      adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID),
      mutationRequest(reviseBody()),
    ),
    403,
    "authorization_denied",
    {},
  );

  await assertError(
    await routes({
      revise: () =>
        Promise.resolve({
          kind: "reauthentication_required",
          replayed: false,
        }),
    }).request(
      adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID),
      mutationRequest(reviseBody()),
    ),
    401,
    "reauthentication_required",
    {},
  );
});

Deno.test("revise requires a valid idempotency key before reading the body", async () => {
  let reviseCalls = 0;
  const app = routes({
    revise: () => {
      reviseCalls += 1;
      return Promise.resolve({
        kind: "revised",
        value: POLICY,
        replayed: false,
      });
    },
  });
  const path = adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID);

  for (const idempotencyKey of [null, "short", "invalid key with spaces"]) {
    await assertError(
      await app.request(
        path,
        mutationRequest("{", {
          idempotencyKey,
          rawBody: true,
        }),
      ),
      400,
      "invalid_request",
      {
        field: "idempotency-key",
        reason: idempotencyKey === null ? "missing_header" : "invalid_header",
      },
    );
  }
  assertEquals(reviseCalls, 0);
});

Deno.test("list and detail queries are strict, bounded, and mutually exclusive", async () => {
  const app = routes();
  const invalidListQueries = [
    "unknown=value",
    "limit=1&limit=2",
    "limit=0",
    "limit=201",
    "limit=1.5",
    "includeHistory=1",
    `scopeId=${SCOPE_ID}`,
    `includeHistory=true&effectiveAt=${encodeURIComponent(NOW)}`,
    "scopeType=Tool",
  ];
  for (const query of invalidListQueries) {
    await assertError(
      await app.request(`${ADMIN_CAPACITY_POLICIES_PATH}?${query}`),
      400,
      "invalid_request",
    );
  }

  const path = adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID);
  for (
    const query of [
      "unknown=value",
      "revision=1&revision=2",
      "revision=0",
      `revision=1&effectiveAt=${encodeURIComponent(NOW)}`,
      "effectiveAt=not-a-timestamp",
    ]
  ) {
    await assertError(
      await app.request(`${path}?${query}`),
      400,
      "invalid_request",
    );
  }

  const bounded = routes({}, fakeAuth(), { maxQueryBytes: 7 });
  await assertError(
    await bounded.request(`${ADMIN_CAPACITY_POLICIES_PATH}?limit=1`),
    400,
    "invalid_request",
    { field: "query", reason: "query_too_large" },
  );
});

Deno.test("scope paths, unsupported queries, and methods are rejected safely", async () => {
  const app = routes();

  await assertError(
    await app.request(
      adminCapacityPolicyPath("Tool", SCOPE_ID),
    ),
    400,
    "invalid_request",
    { field: "scopeType", reason: "invalid_value" },
  );
  await assertError(
    await app.request(
      adminCapacityPolicyPath(SCOPE_TYPE, " "),
    ),
    400,
    "invalid_request",
    { field: "scopeId", reason: "invalid_value" },
  );
  await assertError(
    await app.request(
      `${adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID)}?force=true`,
      mutationRequest(reviseBody()),
    ),
    400,
    "invalid_request",
    { field: "force", reason: "unsupported_query_parameter" },
  );
  await assertError(
    await app.request(adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID), {
      method: "DELETE",
    }),
    404,
    "not_found",
    {},
  );
  await assertError(
    await app.request(`${ADMIN_CAPACITY_POLICIES_PATH}/only-one-segment`),
    404,
    "not_found",
    {},
  );
});

Deno.test("revise rejects malformed, forged, and oversized request bodies", async () => {
  const app = routes();
  const path = adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID);
  const invalidBodies = [
    [],
    { configuration: CONFIGURATION, effectiveAt: NOW },
    reviseBody({ actorUserId: "forged-user" }),
    reviseBody({ sessionId: "forged-session" }),
    reviseBody({ mutationKey: "body-owned-key" }),
    reviseBody({ configuration: [] }),
    reviseBody({ expectedRevision: -1 }),
    reviseBody({ effectiveAt: "not-a-timestamp" }),
    reviseBody({ expiresAt: NOW }),
  ];
  for (const body of invalidBodies) {
    await assertError(
      await app.request(path, mutationRequest(body)),
      400,
      "invalid_request",
    );
  }

  await assertError(
    await app.request(
      path,
      mutationRequest("{", { rawBody: true }),
    ),
    400,
    "invalid_request",
    { field: "body", reason: "malformed_json" },
  );
  await assertError(
    await app.request(
      path,
      mutationRequest(reviseBody(), { contentType: "text/plain" }),
    ),
    415,
    "invalid_request",
    { field: "content-type", reason: "application_json_required" },
  );

  const bounded = routes({}, fakeAuth(), { maxJsonBodyBytes: 32 });
  await assertError(
    await bounded.request(path, mutationRequest(reviseBody())),
    413,
    "invalid_request",
    { field: "body", reason: "body_too_large" },
  );
});

Deno.test("catalog validation errors become stable 400 responses", async () => {
  class CatalogValidationError extends TypeError {
    override readonly name = "CapacityPolicyValidationError";
    readonly field = "configuration.submissionRateDefaults.providerPerMinute";
  }
  let reports = 0;
  const response = await routes(
    {
      revise: () => Promise.reject(new CatalogValidationError("secret detail")),
    },
    fakeAuth(),
    { onUnexpectedError: () => reports += 1 },
  ).request(
    adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID),
    mutationRequest(reviseBody()),
  );
  const text = await response.clone().text();

  await assertError(response, 400, "invalid_request", {
    field: "configuration",
    reason: "invalid_value",
  });
  assertEquals(text.includes("secret detail"), false);
  assertEquals(reports, 0);
});

Deno.test("revision and idempotency conflicts map to stable 409 responses", async () => {
  const path = adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID);
  const revision = await routes({
    revise: () =>
      Promise.resolve({
        kind: "revision_conflict",
        expectedRevision: 0,
        actualRevision: 7,
        replayed: false,
      }),
  }).request(path, mutationRequest(reviseBody()));
  await assertError(revision, 409, "invalid_request", {
    reason: "revision_conflict",
    actualRevision: 7,
  });

  const returned = await routes({
    revise: () =>
      Promise.resolve({ kind: "mutation_key_conflict", replayed: false }),
  }).request(path, mutationRequest(reviseBody()));
  await assertError(returned, 409, "idempotency_conflict", {});

  const thrownError = new Error("must not be returned");
  thrownError.name = "CapacityPolicyIdempotencyConflictError";
  let reports = 0;
  const thrown = await routes(
    { revise: () => Promise.reject(thrownError) },
    fakeAuth(),
    { onUnexpectedError: () => reports += 1 },
  ).request(path, mutationRequest(reviseBody()));
  await assertError(thrown, 409, "idempotency_conflict", {});
  assertEquals(reports, 0);
});

Deno.test("invalid service results and unexpected failures are redacted", async () => {
  const invalidList = await routes({
    list: () =>
      Promise.resolve({
        kind: "ok",
        value: [{ ...POLICY, databaseSecret: "database-secret" }],
      } as never),
  }).request(ADMIN_CAPACITY_POLICIES_PATH);
  const invalidListText = await invalidList.clone().text();
  await assertError(invalidList, 500, "internal_error", {});
  assertEquals(invalidListText.includes("database-secret"), false);

  const invalidRevision = await routes({
    revise: () =>
      Promise.resolve({
        kind: "revision_conflict",
        expectedRevision: 0,
        actualRevision: 2,
        replayed: false,
        rawDatabaseValue: "database-secret",
      } as never),
  }).request(
    adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID),
    mutationRequest(reviseBody()),
  );
  const invalidRevisionText = await invalidRevision.clone().text();
  await assertError(invalidRevision, 500, "internal_error", {});
  assertEquals(invalidRevisionText.includes("database-secret"), false);

  let reported: {
    readonly error: unknown;
    readonly requestId: string;
    readonly routePath: string;
  } | undefined;
  const thrown = await routes(
    {
      get: () => Promise.reject(new Error("postgres password=database-secret")),
    },
    fakeAuth(),
    {
      onUnexpectedError: (error, requestId, routePath) => {
        reported = { error, requestId, routePath };
      },
    },
  ).request(adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID));
  const thrownText = await thrown.clone().text();
  await assertError(thrown, 500, "internal_error", {});
  assertEquals(thrownText.includes("database-secret"), false);
  assertEquals(reported?.requestId, REQUEST_ID);
  assertEquals(reported?.routePath, ADMIN_CAPACITY_POLICY_PATH);
  assertEquals(reported?.error instanceof Error, true);
});

Deno.test("invalid trace context is omitted from catalog audit context", async () => {
  let received: unknown;
  const app = routes({
    list(session, options) {
      received = { session, options };
      return Promise.resolve({ kind: "ok", value: [] });
    },
  });
  const response = await app.request(ADMIN_CAPACITY_POLICIES_PATH, {
    headers: {
      traceparent: "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
    },
  });

  assertEquals(response.status, 200);
  assertEquals(received, {
    session: { sessionId: SESSION_ID },
    options: {
      scopeType: null,
      scopeId: null,
      includeHistory: false,
      effectiveAt: null,
      limit: 100,
      requestId: REQUEST_ID,
      traceId: null,
    },
  });
});

Deno.test("dependency validation fails closed", () => {
  assertThrows(
    () =>
      createAdminCapacityRoutes({
        auth: undefined as unknown as Auth,
        service: service(),
        allowedOrigins: [ORIGIN],
      }),
    TypeError,
    "auth is required",
  );
  assertThrows(
    () =>
      createAdminCapacityRoutes({
        auth: fakeAuth(),
        service: {} as AdminCapacityService,
        allowedOrigins: [ORIGIN],
      }),
    TypeError,
    "admin capacity service",
  );
});
