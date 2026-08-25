import { assertEquals, assertThrows } from "@std/assert";
import {
  adminChangelogDraftInputSchema,
  adminChangelogListResponseSchema,
  adminChangelogReleasePath,
  adminChangelogReleaseSchema,
  adminChangelogRevisionSchema,
  adminChangelogSummarySchema,
  CHANGELOG_CATEGORIES,
  CHANGELOG_CONFLICT_REASONS,
  CHANGELOG_PUBLISHABILITY_REASONS,
  CHANGELOG_RELEASE_STATUSES,
  createAdminChangelogResultSchema,
  errorEnvelopeSchema,
  HTTP_PATHS,
  isAdminChangelogReleaseId,
  listAdminChangelogRequestSchema,
  publishAdminChangelogRequestSchema,
  publishAdminChangelogResultSchema,
  reviseAdminChangelogRequestSchema,
  reviseAdminChangelogResultSchema,
  unpublishAdminChangelogRequestSchema,
  unpublishAdminChangelogResultSchema,
} from "./index.ts";

const TIMESTAMP = "2026-08-25T12:34:56.789Z";
const RELEASE_ID = "42";
const SHA_40 = "a".repeat(40);
const SHA_256 = "b".repeat(64);

const normalizedDraft = {
  version: "1.2.3",
  slug: "release-1-2-3",
  title: "Contract hardening",
  summary: null,
  gitTag: null,
  commitSha: null,
  releasedAt: null,
  items: [{
    category: "improved" as const,
    area: null,
    title: "Strict admin contracts",
    description: "The transport validates every changelog boundary.",
    sortOrder: 0,
  }],
};

const publishableDraft = {
  ...normalizedDraft,
  summary: "A bounded release summary.",
  gitTag: "v1.2.3",
  commitSha: SHA_40,
  releasedAt: TIMESTAMP,
};

const snapshot = {
  ...publishableDraft,
  contentSha256: SHA_256,
};

const draftSummary = {
  releaseId: RELEASE_ID,
  version: normalizedDraft.version,
  slug: normalizedDraft.slug,
  status: "draft" as const,
  latestRevision: 1,
  publishedRevision: null,
  hasUnpublishedChanges: true,
  updatedAt: TIMESTAMP,
};

Deno.test("admin changelog vocabulary and routes are canonical", () => {
  assertEquals(CHANGELOG_CATEGORIES, [
    "added",
    "improved",
    "fixed",
    "security",
    "breaking",
  ]);
  assertEquals(CHANGELOG_RELEASE_STATUSES, [
    "draft",
    "published",
    "archived",
  ]);
  assertEquals(CHANGELOG_PUBLISHABILITY_REASONS, [
    "invalid_version",
    "missing_git_tag",
    "missing_commit_sha",
    "missing_released_at",
    "missing_items",
  ]);
  assertEquals(CHANGELOG_CONFLICT_REASONS, [
    "version",
    "slug",
    "version_and_slug",
  ]);
  assertEquals(HTTP_PATHS.adminChangelog, "/api/v1/admin/changelog");
  assertEquals(
    HTTP_PATHS.adminChangelogRelease,
    "/api/v1/admin/changelog/:releaseId",
  );
  assertEquals(
    HTTP_PATHS.adminChangelogPublish,
    "/api/v1/admin/changelog/:releaseId/publish",
  );
  assertEquals(
    HTTP_PATHS.adminChangelogUnpublish,
    "/api/v1/admin/changelog/:releaseId/unpublish",
  );
  assertEquals(
    adminChangelogReleasePath("release/id"),
    "/api/v1/admin/changelog/release%2Fid",
  );
});

Deno.test("admin changelog drafts normalize omitted nullable fields", () => {
  assertEquals(
    adminChangelogDraftInputSchema.parse({
      version: normalizedDraft.version,
      slug: normalizedDraft.slug,
      title: normalizedDraft.title,
      items: [{
        category: "improved",
        title: normalizedDraft.items[0].title,
        description: normalizedDraft.items[0].description,
        sortOrder: 0,
      }],
    }),
    normalizedDraft,
  );
  assertEquals(
    adminChangelogDraftInputSchema.parse(publishableDraft),
    publishableDraft,
  );
});

Deno.test("admin changelog drafts reject unknown fields at every level", () => {
  assertThrows(() =>
    adminChangelogDraftInputSchema.parse({
      ...normalizedDraft,
      internalOnly: true,
    })
  );
  assertThrows(() =>
    adminChangelogDraftInputSchema.parse({
      ...normalizedDraft,
      items: [{ ...normalizedDraft.items[0], href: "https://example.test" }],
    })
  );
});

Deno.test("admin changelog drafts enforce exact SHAs and timestamps", () => {
  for (const commitSha of ["abc123", "A".repeat(40), "a".repeat(41)]) {
    assertThrows(() =>
      adminChangelogDraftInputSchema.parse({
        ...normalizedDraft,
        commitSha,
      })
    );
  }
  for (
    const releasedAt of [
      "2026-08-25T12:34:56Z",
      "2026-08-25T12:34:56.789+00:00",
      "2026-02-30T12:34:56.789Z",
    ]
  ) {
    assertThrows(() =>
      adminChangelogDraftInputSchema.parse({
        ...normalizedDraft,
        releasedAt,
      })
    );
  }
});

Deno.test("admin changelog drafts enforce collection and integer bounds", () => {
  assertThrows(() =>
    adminChangelogDraftInputSchema.parse({
      ...normalizedDraft,
      items: [
        normalizedDraft.items[0],
        { ...normalizedDraft.items[0], sortOrder: 0 },
      ],
    })
  );
  assertThrows(() =>
    adminChangelogDraftInputSchema.parse({
      ...normalizedDraft,
      items: [{
        ...normalizedDraft.items[0],
        sortOrder: 2_147_483_648,
      }],
    })
  );
  assertThrows(() =>
    adminChangelogDraftInputSchema.parse({
      ...normalizedDraft,
      items: Array.from({ length: 201 }, (_, sortOrder) => ({
        ...normalizedDraft.items[0],
        sortOrder,
      })),
    })
  );
});

Deno.test("admin changelog release IDs and list requests use PostgreSQL bounds", () => {
  assertEquals(isAdminChangelogReleaseId("1"), true);
  assertEquals(isAdminChangelogReleaseId("9223372036854775807"), true);
  for (
    const value of [
      "",
      "0",
      "01",
      "-1",
      "1.0",
      "9223372036854775808",
    ]
  ) {
    assertEquals(isAdminChangelogReleaseId(value), false, value);
  }

  assertEquals(listAdminChangelogRequestSchema.parse({}), {
    limit: 20,
    beforeReleaseId: null,
  });
  assertEquals(
    listAdminChangelogRequestSchema.parse({
      limit: 100,
      beforeReleaseId: "9223372036854775807",
    }),
    { limit: 100, beforeReleaseId: "9223372036854775807" },
  );
  for (
    const input of [
      { limit: 0 },
      { limit: 101 },
      { beforeReleaseId: "9223372036854775808" },
      { offset: 1 },
    ]
  ) assertThrows(() => listAdminChangelogRequestSchema.parse(input));
});

Deno.test("admin changelog output schemas preserve service shapes", () => {
  assertEquals(adminChangelogSummarySchema.parse(draftSummary), draftSummary);

  const storedRevision = {
    ...snapshot,
    revision: 1,
    changedBy: "admin-user-1",
    changedAt: TIMESTAMP,
  };
  assertEquals(
    adminChangelogRevisionSchema.parse(storedRevision),
    storedRevision,
  );

  const release = {
    releaseId: RELEASE_ID,
    status: "published" as const,
    latestRevision: 2,
    publishedRevision: 1,
    hasUnpublishedChanges: true,
    firstPublishedAt: TIMESTAMP,
    lastPublishedAt: TIMESTAMP,
    latest: { ...snapshot, title: "Updated draft" },
    published: snapshot,
  };
  assertEquals(adminChangelogReleaseSchema.parse(release), release);
  assertEquals(
    adminChangelogListResponseSchema.parse({ releases: [draftSummary] }),
    { releases: [draftSummary] },
  );

  assertThrows(() =>
    adminChangelogRevisionSchema.parse({
      ...storedRevision,
      summary: undefined,
    })
  );
  assertThrows(() =>
    adminChangelogReleaseSchema.parse({
      ...release,
      publishedRevision: null,
    })
  );
  assertThrows(() =>
    adminChangelogListResponseSchema.parse({
      releases: [draftSummary],
      nextCursor: null,
    })
  );
});

Deno.test("admin changelog mutation request schemas are strict and bounded", () => {
  assertEquals(
    reviseAdminChangelogRequestSchema.parse({
      expectedRevision: 1,
      version: normalizedDraft.version,
      slug: normalizedDraft.slug,
      title: normalizedDraft.title,
      items: normalizedDraft.items,
    }),
    { expectedRevision: 1, ...normalizedDraft },
  );
  assertEquals(
    publishAdminChangelogRequestSchema.parse({ expectedRevision: 1 }),
    { expectedRevision: 1 },
  );
  assertEquals(
    unpublishAdminChangelogRequestSchema.parse({
      expectedPublishedRevision: 1,
    }),
    { expectedPublishedRevision: 1 },
  );
  assertThrows(() =>
    reviseAdminChangelogRequestSchema.parse({
      expectedRevision: 2_147_483_648,
      ...normalizedDraft,
    })
  );
  assertThrows(() =>
    publishAdminChangelogRequestSchema.parse({
      expectedRevision: 1,
      releaseId: RELEASE_ID,
    })
  );
  assertThrows(() =>
    unpublishAdminChangelogRequestSchema.parse({
      expectedPublishedRevision: 2_147_483_648,
    })
  );
});

Deno.test("create admin changelog results match service outcomes exactly", () => {
  for (
    const result of [
      {
        kind: "created",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 1,
      },
      { kind: "conflict", replayed: true, reason: "version_and_slug" },
      { kind: "denied", replayed: false },
      { kind: "reauthentication_required", replayed: false },
    ] as const
  ) assertEquals(createAdminChangelogResultSchema.parse(result), result);

  for (
    const result of [
      { kind: "created", replayed: false, releaseId: RELEASE_ID },
      {
        kind: "conflict",
        replayed: false,
        reason: "slug",
        releaseId: RELEASE_ID,
      },
      { kind: "denied", replayed: true },
    ]
  ) assertThrows(() => createAdminChangelogResultSchema.parse(result));
});

Deno.test("revise admin changelog results reject impossible field sets", () => {
  for (
    const result of [
      {
        kind: "revised",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 2,
      },
      {
        kind: "unchanged",
        replayed: true,
        releaseId: RELEASE_ID,
        revision: 2,
      },
      { kind: "not_found", replayed: false },
      {
        kind: "revision_conflict",
        replayed: false,
        releaseId: RELEASE_ID,
        actualRevision: 3,
      },
      {
        kind: "identity_locked",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 2,
      },
      {
        kind: "conflict",
        replayed: false,
        releaseId: RELEASE_ID,
        reason: "slug",
      },
      { kind: "denied", replayed: false },
      { kind: "reauthentication_required", replayed: false },
    ] as const
  ) assertEquals(reviseAdminChangelogResultSchema.parse(result), result);

  for (
    const result of [
      { kind: "not_found", replayed: false, releaseId: RELEASE_ID },
      {
        kind: "revision_conflict",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 3,
      },
      {
        kind: "identity_locked",
        replayed: false,
        releaseId: RELEASE_ID,
        actualRevision: 2,
      },
      {
        kind: "conflict",
        replayed: false,
        releaseId: RELEASE_ID,
        reason: "title",
      },
    ]
  ) assertThrows(() => reviseAdminChangelogResultSchema.parse(result));
});

Deno.test("publish admin changelog results reject impossible field sets", () => {
  for (
    const result of [
      {
        kind: "published",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 1,
        supersededRevision: null,
      },
      {
        kind: "superseded",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 2,
        supersededRevision: 1,
      },
      {
        kind: "unchanged",
        replayed: true,
        releaseId: RELEASE_ID,
        revision: 2,
        supersededRevision: null,
      },
      { kind: "not_found", replayed: false },
      {
        kind: "revision_conflict",
        replayed: false,
        releaseId: RELEASE_ID,
        actualRevision: 2,
      },
      {
        kind: "not_publishable",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 1,
        reasons: ["missing_git_tag", "missing_items"],
      },
      { kind: "denied", replayed: false },
      { kind: "reauthentication_required", replayed: false },
    ] as const
  ) assertEquals(publishAdminChangelogResultSchema.parse(result), result);

  for (
    const result of [
      {
        kind: "published",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 1,
        supersededRevision: 1,
      },
      {
        kind: "superseded",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 2,
        supersededRevision: null,
      },
      {
        kind: "superseded",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 2,
        supersededRevision: 2,
      },
      {
        kind: "not_publishable",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 1,
        reasons: [],
      },
      {
        kind: "not_publishable",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 1,
        reasons: ["missing_title"],
      },
    ]
  ) assertThrows(() => publishAdminChangelogResultSchema.parse(result));
});

Deno.test("unpublish results preserve null for never-published drafts", () => {
  for (
    const result of [
      {
        kind: "unpublished",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 2,
      },
      {
        kind: "unchanged",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: null,
      },
      {
        kind: "unchanged",
        replayed: true,
        releaseId: RELEASE_ID,
        revision: 2,
      },
      { kind: "not_found", replayed: false },
      {
        kind: "revision_conflict",
        replayed: false,
        releaseId: RELEASE_ID,
        actualRevision: 2,
      },
      { kind: "denied", replayed: false },
      { kind: "reauthentication_required", replayed: false },
    ] as const
  ) assertEquals(unpublishAdminChangelogResultSchema.parse(result), result);

  for (
    const result of [
      {
        kind: "unpublished",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: null,
      },
      {
        kind: "unchanged",
        replayed: false,
        releaseId: RELEASE_ID,
      },
      {
        kind: "revision_conflict",
        replayed: false,
        releaseId: RELEASE_ID,
        actualRevision: 2_147_483_648,
      },
    ]
  ) assertThrows(() => unpublishAdminChangelogResultSchema.parse(result));
});

Deno.test("admin changelog error details are code-specific and sanitized", () => {
  const baseError = {
    message: "The request is invalid.",
    retryable: false,
    requestId: "req_12345678",
  };
  assertEquals(
    errorEnvelopeSchema.parse({
      error: {
        ...baseError,
        code: "invalid_request",
        details: {
          actualRevision: 2,
          reasons: ["missing_git_tag", "missing_items"],
        },
      },
    }).error.details,
    {
      actualRevision: 2,
      reasons: ["missing_git_tag", "missing_items"],
    },
  );
  assertEquals(
    errorEnvelopeSchema.parse({
      error: {
        ...baseError,
        code: "not_found",
        details: { resource: "changelog_release" },
      },
    }).error.details,
    { resource: "changelog_release" },
  );
  for (const code of ["authorization_denied", "reauthentication_required"]) {
    assertEquals(
      errorEnvelopeSchema.parse({
        error: { ...baseError, code, details: {} },
      }).error.code,
      code,
    );
  }

  assertThrows(() =>
    errorEnvelopeSchema.parse({
      error: {
        ...baseError,
        code: "authorization_denied",
        details: { actualRevision: 2 },
      },
    })
  );
  assertThrows(() =>
    errorEnvelopeSchema.parse({
      error: {
        ...baseError,
        code: "invalid_request",
        details: { actualRevision: 2_147_483_648 },
      },
    })
  );
  assertThrows(() =>
    errorEnvelopeSchema.parse({
      error: {
        ...baseError,
        code: "invalid_request",
        details: { reasons: ["https://signed.example/secret"] },
      },
    })
  );
});
