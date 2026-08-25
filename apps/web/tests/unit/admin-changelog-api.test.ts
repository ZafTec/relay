import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminChangelogListPath,
  adminChangelogReleasePath,
  createAdminChangelogIdempotencyKey,
  type AdminChangelogDraftInput,
  httpAdminChangelogAdapter,
  InvalidAdminChangelogResponseError,
  parseAdminChangelogListResponse,
  parseAdminChangelogReleaseResponse,
  parseCreateAdminChangelogResponse,
  parsePublishAdminChangelogResponse,
  parseReviseAdminChangelogResponse,
  parseUnpublishAdminChangelogResponse,
} from "../../src/lib/api/admin-changelog";
import { ApiError, fetchJson } from "../../src/lib/api/client";

const RELEASE_ID = "42";
const NOW = "2026-08-25T10:00:00.000Z";
const LATER = "2026-08-25T11:00:00.000Z";
const IDEMPOTENCY_KEY = "admin-changelog:test:00000000-0000-4000-8000-000000000000";

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

const SNAPSHOT = {
  ...DRAFT,
  contentSha256: "b".repeat(64),
};

const DRAFT_SUMMARY = {
  releaseId: RELEASE_ID,
  version: DRAFT.version,
  slug: DRAFT.slug,
  status: "draft" as const,
  latestRevision: 1,
  publishedRevision: null,
  hasUnpublishedChanges: true,
  updatedAt: NOW,
};

const DRAFT_RELEASE = {
  releaseId: RELEASE_ID,
  status: "draft" as const,
  latestRevision: 1,
  publishedRevision: null,
  hasUnpublishedChanges: true,
  firstPublishedAt: null,
  lastPublishedAt: null,
  latest: SNAPSHOT,
  published: null,
};

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  details: unknown = {},
  requestId = "req_admin-changelog-test",
): Response {
  return jsonResponse({
    error: {
      code,
      message: `HTTP ${status}`,
      retryable: false,
      requestId,
      details,
    },
  }, status, { "x-request-id": requestId });
}

function mutationHeaders(call: unknown[]): Headers {
  return new Headers((call[1] as RequestInit | undefined)?.headers);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin changelog response parsing", () => {
  it("parses exact list and release payloads", () => {
    expect(parseAdminChangelogListResponse({ releases: [DRAFT_SUMMARY] })).toEqual({
      releases: [DRAFT_SUMMARY],
    });
    expect(parseAdminChangelogReleaseResponse(DRAFT_RELEASE)).toEqual(DRAFT_RELEASE);

    const sha64Release = {
      ...DRAFT_RELEASE,
      latest: { ...SNAPSHOT, commitSha: "c".repeat(64) },
    };
    expect(parseAdminChangelogReleaseResponse(sha64Release).latest.commitSha)
      .toBe("c".repeat(64));
  });

  it("enforces exact objects, PostgreSQL bounds, statuses, and timestamps", () => {
    expect(() => parseAdminChangelogListResponse({
      releases: [{ ...DRAFT_SUMMARY, internal: true }],
    })).toThrow(/internal: is not supported/i);
    expect(() => parseAdminChangelogListResponse({
      releases: [{ ...DRAFT_SUMMARY, releaseId: "9223372036854775808" }],
    })).toThrow(/PostgreSQL bigint/i);
    expect(() => parseAdminChangelogListResponse({
      releases: [{ ...DRAFT_SUMMARY, latestRevision: 2_147_483_648 }],
    })).toThrow(/between 1 and 2147483647/i);
    expect(() => parseAdminChangelogListResponse({
      releases: [{ ...DRAFT_SUMMARY, status: "reviewing" }],
    })).toThrow(/must be one of/i);
    expect(() => parseAdminChangelogListResponse({
      releases: [{ ...DRAFT_SUMMARY, updatedAt: "2026-02-30T10:00:00.000Z" }],
    })).toThrow(/exact UTC timestamp/i);
    expect(() => parseAdminChangelogListResponse({
      releases: [{ ...DRAFT_SUMMARY, updatedAt: "2026-08-25T10:00:00Z" }],
    })).toThrow(/invalid format|too short/i);
    expect(() => parseAdminChangelogListResponse({
      releases: Array.from({ length: 101 }, () => DRAFT_SUMMARY),
    })).toThrow(/too many/i);
  });

  it("enforces full lowercase SHAs and bounded unique items", () => {
    for (const commitSha of ["abc123", "A".repeat(40), "a".repeat(41)]) {
      expect(() => parseAdminChangelogReleaseResponse({
        ...DRAFT_RELEASE,
        latest: { ...SNAPSHOT, commitSha },
      })).toThrow(/full lowercase Git SHA/i);
    }
    expect(() => parseAdminChangelogReleaseResponse({
      ...DRAFT_RELEASE,
      latest: { ...SNAPSHOT, contentSha256: "B".repeat(64) },
    })).toThrow(/invalid format/i);
    expect(() => parseAdminChangelogReleaseResponse({
      ...DRAFT_RELEASE,
      latest: {
        ...SNAPSHOT,
        items: [
          DRAFT.items[0],
          { ...DRAFT.items[0], title: "Duplicate order", sortOrder: 0 },
        ],
      },
    })).toThrow(/sortOrder values must be unique/i);

    const twoHundredItems = Array.from({ length: 200 }, (_, sortOrder) => ({
      ...DRAFT.items[0],
      sortOrder,
    }));
    expect(parseAdminChangelogReleaseResponse({
      ...DRAFT_RELEASE,
      latest: { ...SNAPSHOT, items: twoHundredItems },
    }).latest.items).toHaveLength(200);
    expect(() => parseAdminChangelogReleaseResponse({
      ...DRAFT_RELEASE,
      latest: {
        ...SNAPSHOT,
        items: [...twoHundredItems, { ...DRAFT.items[0], sortOrder: 200 }],
      },
    })).toThrow(/too many/i);
  });

  it("enforces publication-state consistency", () => {
    expect(() => parseAdminChangelogListResponse({
      releases: [{ ...DRAFT_SUMMARY, hasUnpublishedChanges: false }],
    })).toThrow(/does not match the release revisions/i);
    expect(() => parseAdminChangelogReleaseResponse({
      ...DRAFT_RELEASE,
      status: "published",
    })).toThrow(/does not match the release status/i);
    expect(() => parseAdminChangelogReleaseResponse({
      ...DRAFT_RELEASE,
      status: "published",
      publishedRevision: 1,
      hasUnpublishedChanges: false,
      firstPublishedAt: NOW,
      lastPublishedAt: LATER,
      published: null,
    })).toThrow(/does not match publishedRevision/i);
    expect(() => parseAdminChangelogReleaseResponse({
      ...DRAFT_RELEASE,
      status: "published",
      publishedRevision: 1,
      hasUnpublishedChanges: false,
      firstPublishedAt: LATER,
      lastPublishedAt: NOW,
      published: SNAPSHOT,
    })).toThrow(/must not precede firstPublishedAt/i);
  });

  it("strictly parses every mutation success shape", () => {
    expect(parseCreateAdminChangelogResponse({
      kind: "created",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
    })).toEqual({
      kind: "created",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
    });
    expect(parseReviseAdminChangelogResponse({
      kind: "unchanged",
      replayed: true,
      releaseId: RELEASE_ID,
      revision: 2,
    }, RELEASE_ID)).toMatchObject({ kind: "unchanged", revision: 2 });
    expect(parsePublishAdminChangelogResponse({
      kind: "superseded",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 3,
      supersededRevision: 2,
    }, RELEASE_ID)).toMatchObject({ kind: "superseded", supersededRevision: 2 });
    expect(parseUnpublishAdminChangelogResponse({
      kind: "unchanged",
      replayed: true,
      releaseId: RELEASE_ID,
      revision: null,
    }, RELEASE_ID)).toMatchObject({ kind: "unchanged", revision: null });

    expect(() => parseCreateAdminChangelogResponse({
      kind: "created",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
      actorUserId: "must-not-leak",
    })).toThrow(/actorUserId: is not supported/i);
    expect(() => parseReviseAdminChangelogResponse({
      kind: "revised",
      replayed: false,
      releaseId: "43",
      revision: 2,
    }, RELEASE_ID)).toThrow(/requested release/i);
    expect(() => parsePublishAdminChangelogResponse({
      kind: "superseded",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 2,
      supersededRevision: 2,
    }, RELEASE_ID)).toThrow(/does not match the publication result/i);
    expect(() => parseUnpublishAdminChangelogResponse({
      kind: "unpublished",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: null,
    }, RELEASE_ID)).toThrow(/safe integer/i);
  });
});

describe("admin changelog requests", () => {
  it("builds only the supported list and release paths", () => {
    expect(adminChangelogListPath()).toBe("/api/v1/admin/changelog");
    expect(adminChangelogListPath({ limit: 25, beforeReleaseId: "41" }))
      .toBe("/api/v1/admin/changelog?limit=25&beforeReleaseId=41");
    expect(adminChangelogListPath({ beforeReleaseId: null }))
      .toBe("/api/v1/admin/changelog");
    expect(adminChangelogReleasePath("9223372036854775807"))
      .toBe("/api/v1/admin/changelog/9223372036854775807");
    expect(() => adminChangelogListPath({ cursor: "opaque" } as never))
      .toThrow(/cursor: is not supported/i);
    expect(() => adminChangelogReleasePath("42/publish"))
      .toThrow(/PostgreSQL bigint/i);
  });

  it("uses crypto.randomUUID in a governance-safe idempotency key", () => {
    const uuid = "00000000-0000-4000-8000-000000000000";
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValue(uuid);

    const key = createAdminChangelogIdempotencyKey("publish");

    expect(key).toBe(`admin-changelog:publish:${uuid}`);
    expect(key).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
    expect(key.length).toBeGreaterThanOrEqual(16);
    expect(key.length).toBeLessThanOrEqual(128);
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("uses exact paths, methods, headers, and sanitized JSON bodies", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ releases: [DRAFT_SUMMARY] }))
      .mockResolvedValueOnce(jsonResponse(DRAFT_RELEASE))
      .mockResolvedValueOnce(jsonResponse({
        kind: "created",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 1,
      }, 201))
      .mockResolvedValueOnce(jsonResponse({
        kind: "revised",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 2,
      }))
      .mockResolvedValueOnce(jsonResponse({
        kind: "published",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 2,
        supersededRevision: null,
      }))
      .mockResolvedValueOnce(jsonResponse({
        kind: "unpublished",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 2,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpAdminChangelogAdapter.list({
      limit: 25,
      beforeReleaseId: "41",
    })).resolves.toMatchObject({ kind: "ok" });
    await expect(httpAdminChangelogAdapter.get(RELEASE_ID))
      .resolves.toMatchObject({ kind: "found" });
    await expect(httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY))
      .resolves.toMatchObject({ kind: "created" });
    await expect(httpAdminChangelogAdapter.revise(
      RELEASE_ID,
      { expectedRevision: 1, ...DRAFT },
      IDEMPOTENCY_KEY,
    )).resolves.toMatchObject({ kind: "revised" });
    await expect(httpAdminChangelogAdapter.publish(
      RELEASE_ID,
      { expectedRevision: 2 },
      IDEMPOTENCY_KEY,
    )).resolves.toMatchObject({ kind: "published" });
    await expect(httpAdminChangelogAdapter.unpublish(
      RELEASE_ID,
      { expectedPublishedRevision: 2 },
      IDEMPOTENCY_KEY,
    )).resolves.toMatchObject({ kind: "unpublished" });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/admin/changelog?limit=25&beforeReleaseId=41",
      "/api/v1/admin/changelog/42",
      "/api/v1/admin/changelog",
      "/api/v1/admin/changelog/42",
      "/api/v1/admin/changelog/42/publish",
      "/api/v1/admin/changelog/42/unpublish",
    ]);
    expect((fetchMock.mock.calls[2]?.[1] as RequestInit).method).toBe("POST");
    expect((fetchMock.mock.calls[3]?.[1] as RequestInit).method).toBe("PATCH");
    expect((fetchMock.mock.calls[4]?.[1] as RequestInit).method).toBe("POST");
    expect((fetchMock.mock.calls[5]?.[1] as RequestInit).method).toBe("POST");

    for (const index of [2, 3, 4, 5]) {
      const call = fetchMock.mock.calls[index];
      expect(call).toBeDefined();
      const headers = mutationHeaders(call as unknown[]);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
      expect(headers.get("accept")).toBe("application/json");
      expect((call?.[1] as RequestInit).credentials).toBe("include");
    }

    expect(JSON.parse(String((fetchMock.mock.calls[2]?.[1] as RequestInit).body)))
      .toEqual(DRAFT);
    expect(JSON.parse(String((fetchMock.mock.calls[3]?.[1] as RequestInit).body)))
      .toEqual({ expectedRevision: 1, ...DRAFT });
    expect(JSON.parse(String((fetchMock.mock.calls[4]?.[1] as RequestInit).body)))
      .toEqual({ expectedRevision: 2 });
    expect(JSON.parse(String((fetchMock.mock.calls[5]?.[1] as RequestInit).body)))
      .toEqual({ expectedPublishedRevision: 2 });
    for (const index of [2, 3, 4, 5]) {
      const body = String((fetchMock.mock.calls[index]?.[1] as RequestInit).body);
      expect(body).not.toMatch(/actor|session|workspace/i);
    }
  });

  it("rejects invalid explicit idempotency keys before fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpAdminChangelogAdapter.create(DRAFT, "too-short"))
      .resolves.toMatchObject({ kind: "degraded" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("admin changelog error mapping", () => {
  it("preserves plain error details and request IDs in ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(errorResponse(
      409,
      "invalid_request",
      { reason: "revision_conflict", actualRevision: 7 },
      "req_admin-changelog-details",
    )));

    try {
      await fetchJson("/api/v1/admin/changelog/42");
      throw new Error("Expected fetchJson to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({
        status: 409,
        code: "invalid_request",
        details: { reason: "revision_conflict", actualRevision: 7 },
        requestId: "req_admin-changelog-details",
      });
    }
  });

  it("maps every explicit HTTP failure without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const cases: readonly {
      readonly response: Response;
      readonly invoke: () => Promise<unknown>;
      readonly expected: unknown;
    }[] = [
      {
        response: errorResponse(401, "authentication_required"),
        invoke: () => httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY),
        expected: { kind: "auth-expired" },
      },
      {
        response: errorResponse(401, "reauthentication_required"),
        invoke: () => httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY),
        expected: { kind: "reauthentication-required" },
      },
      {
        response: errorResponse(403, "authorization_denied"),
        invoke: () => httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY),
        expected: { kind: "denied" },
      },
      {
        response: errorResponse(404, "not_found", { resource: "changelog_release" }),
        invoke: () => httpAdminChangelogAdapter.publish(
          RELEASE_ID,
          { expectedRevision: 1 },
          IDEMPOTENCY_KEY,
        ),
        expected: { kind: "not-found" },
      },
      {
        response: errorResponse(409, "idempotency_conflict"),
        invoke: () => httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY),
        expected: { kind: "idempotency-conflict" },
      },
      {
        response: errorResponse(409, "invalid_request", {
          reason: "identity_locked",
          actualRevision: 4,
        }),
        invoke: () => httpAdminChangelogAdapter.revise(
          RELEASE_ID,
          { expectedRevision: 3, ...DRAFT },
          IDEMPOTENCY_KEY,
        ),
        expected: { kind: "identity-conflict", actualRevision: 4 },
      },
      {
        response: errorResponse(409, "invalid_request", {
          reason: "revision_conflict",
          actualRevision: 5,
        }),
        invoke: () => httpAdminChangelogAdapter.publish(
          RELEASE_ID,
          { expectedRevision: 4 },
          IDEMPOTENCY_KEY,
        ),
        expected: { kind: "revision-conflict", actualRevision: 5 },
      },
      {
        response: errorResponse(409, "invalid_request", { reason: "version" }),
        invoke: () => httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY),
        expected: { kind: "version-conflict" },
      },
      {
        response: errorResponse(409, "invalid_request", { reason: "slug" }),
        invoke: () => httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY),
        expected: { kind: "slug-conflict" },
      },
      {
        response: errorResponse(409, "invalid_request", {
          reason: "version_and_slug",
        }),
        invoke: () => httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY),
        expected: { kind: "version-and-slug-conflict" },
      },
      {
        response: errorResponse(422, "invalid_request", {
          reason: "not_publishable",
          reasons: ["missing_git_tag", "missing_items"],
        }),
        invoke: () => httpAdminChangelogAdapter.publish(
          RELEASE_ID,
          { expectedRevision: 1 },
          IDEMPOTENCY_KEY,
        ),
        expected: {
          kind: "not-publishable",
          reasons: ["missing_git_tag", "missing_items"],
        },
      },
      {
        response: errorResponse(503, "internal_error"),
        invoke: () => httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY),
        expected: { kind: "unknown-outcome", message: expect.any(String) },
      },
    ];

    for (const testCase of cases) {
      fetchMock.mockResolvedValueOnce(testCase.response);
      await expect(testCase.invoke()).resolves.toEqual(testCase.expected);
    }
    expect(fetchMock).toHaveBeenCalledTimes(cases.length);
  });

  it("degrades malformed conflict and publishability details", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(409, "invalid_request", {
        reason: "revision_conflict",
        actualRevision: 2_147_483_648,
      }))
      .mockResolvedValueOnce(errorResponse(422, "invalid_request", {
        reason: "not_publishable",
        reasons: ["missing_items", "missing_items"],
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpAdminChangelogAdapter.publish(
      RELEASE_ID,
      { expectedRevision: 1 },
      IDEMPOTENCY_KEY,
    )).resolves.toMatchObject({ kind: "degraded" });
    await expect(httpAdminChangelogAdapter.publish(
      RELEASE_ID,
      { expectedRevision: 1 },
      IDEMPOTENCY_KEY,
    )).resolves.toMatchObject({ kind: "degraded" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("maps read failures to explicit states and degrades other failures", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(401, "authentication_required"))
      .mockResolvedValueOnce(errorResponse(401, "reauthentication_required"))
      .mockResolvedValueOnce(errorResponse(403, "authorization_denied"))
      .mockResolvedValueOnce(errorResponse(404, "not_found"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(jsonResponse({ releases: [{ ...DRAFT_SUMMARY, extra: true }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpAdminChangelogAdapter.list()).resolves.toEqual({
      kind: "auth-expired",
    });
    await expect(httpAdminChangelogAdapter.get(RELEASE_ID)).resolves.toEqual({
      kind: "reauthentication-required",
    });
    await expect(httpAdminChangelogAdapter.list()).resolves.toEqual({
      kind: "denied",
    });
    await expect(httpAdminChangelogAdapter.get(RELEASE_ID)).resolves.toEqual({
      kind: "not-found",
    });
    await expect(httpAdminChangelogAdapter.list()).resolves.toMatchObject({
      kind: "degraded",
    });
    await expect(httpAdminChangelogAdapter.list()).resolves.toMatchObject({
      kind: "degraded",
    });
  });
});

describe("admin changelog abort and uncertain outcomes", () => {
  it("rethrows read AbortError but reports mutation abort as unknown", async () => {
    const readAbort = new DOMException("Navigation changed", "AbortError");
    const mutationAbort = new DOMException("Navigation changed", "AbortError");
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(readAbort)
      .mockRejectedValueOnce(mutationAbort);
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpAdminChangelogAdapter.list()).rejects.toBe(readAbort);
    await expect(httpAdminChangelogAdapter.publish(
      RELEASE_ID,
      { expectedRevision: 1 },
      IDEMPOTENCY_KEY,
    )).resolves.toMatchObject({ kind: "unknown-outcome" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports network and malformed success failures as unknown without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(jsonResponse({
        kind: "created",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 1,
        unexpected: true,
      }, 201))
      .mockResolvedValueOnce(new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY))
      .resolves.toMatchObject({ kind: "unknown-outcome" });
    await expect(httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY))
      .resolves.toMatchObject({ kind: "unknown-outcome" });
    await expect(httpAdminChangelogAdapter.create(DRAFT, IDEMPOTENCY_KEY))
      .resolves.toMatchObject({ kind: "unknown-outcome" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps malformed successful reads deterministic and degraded", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      releases: [{ ...DRAFT_SUMMARY, status: "unknown" }],
    })));

    await expect(httpAdminChangelogAdapter.list()).resolves.toMatchObject({
      kind: "degraded",
    });
  });
});
