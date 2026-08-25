import assert from "node:assert/strict";
import { assertIdempotencyKey } from "../src/index.ts";
import {
  assertPublishableDraft,
  isValidSemver,
  normalizeChangelogDraft,
  normalizeLegalDocument,
  positiveIntegerString,
  positiveRevision,
} from "../src/validation.ts";

Deno.test("changelog normalization is bounded and deterministically shaped", () => {
  const normalized = normalizeChangelogDraft({
    version: "0.4.0",
    slug: "release-0-4-0",
    title: "Durable publication",
    gitTag: "v0.4.0",
    commitSha: "a".repeat(40),
    releasedAt: "2026-08-23T12:00:00Z",
    items: [{
      category: "improved",
      title: "Changelog history is preserved",
      description: "Published edits append revisions.",
      sortOrder: 0,
    }],
  });

  assert.deepEqual(normalized, {
    version: "0.4.0",
    slug: "release-0-4-0",
    title: "Durable publication",
    summary: null,
    gitTag: "v0.4.0",
    commitSha: "a".repeat(40),
    releasedAt: "2026-08-23T12:00:00.000Z",
    items: [{
      category: "improved",
      area: null,
      title: "Changelog history is preserved",
      description: "Published edits append revisions.",
      sortOrder: 0,
    }],
  });
  assert.doesNotThrow(() => assertPublishableDraft(normalized));
});

Deno.test("publishability follows SemVer and complete release evidence", () => {
  for (
    const version of [
      "0.4.0",
      "1.2.3-rc.1+build.5",
      "1.0.0-0.3.7",
      "1.0.0-x.7.z.92",
      "1.0.0+build.001",
    ]
  ) assert.equal(isValidSemver(version), true, version);

  for (
    const version of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.0.0-01",
      "1.0.0-alpha..1",
      "1.0.0-",
      "1.0.0+",
      "v1.2.3",
    ]
  ) assert.equal(isValidSemver(version), false, version);

  const incomplete = normalizeChangelogDraft({
    version: "draft",
    slug: "draft-release",
    title: "Draft",
    items: [],
  });
  assert.throws(
    () => assertPublishableDraft(incomplete),
    /invalid_version, missing_git_tag, missing_commit_sha, missing_released_at, missing_items/,
  );
});

Deno.test("changelog validation rejects duplicate ordering and partial SHAs", () => {
  assert.throws(
    () =>
      normalizeChangelogDraft({
        version: "0.4.0",
        slug: "release-0-4-0",
        title: "Release",
        commitSha: "abc123",
        items: [],
      }),
    /full lowercase Git SHA/,
  );
  assert.throws(
    () =>
      normalizeChangelogDraft({
        version: "0.4.0",
        slug: "release-0-4-0",
        title: "Release",
        items: [
          {
            category: "added",
            title: "One",
            description: "One",
            sortOrder: 1,
          },
          {
            category: "fixed",
            title: "Two",
            description: "Two",
            sortOrder: 1,
          },
        ],
      }),
    /sortOrder values must be unique/,
  );
});

Deno.test("the package exports idempotency-key validation", () => {
  assert.doesNotThrow(() => assertIdempotencyKey("release-request-0001"));
  assert.throws(() => assertIdempotencyKey("short"), /16-128/);
});

Deno.test("PostgreSQL integer boundaries are enforced before queries", () => {
  assert.equal(
    positiveIntegerString("9223372036854775807", "releaseId"),
    "9223372036854775807",
  );
  assert.throws(
    () => positiveIntegerString("9223372036854775808", "releaseId"),
    /PostgreSQL bigint/,
  );
  assert.equal(positiveRevision(2_147_483_647), 2_147_483_647);
  assert.throws(() => positiveRevision(2_147_483_648), /2147483647/);
  assert.throws(
    () =>
      normalizeChangelogDraft({
        version: "0.4.0",
        slug: "release-0-4-0",
        title: "Release",
        items: [{
          category: "added",
          title: "Overflow",
          description: "The order is outside PostgreSQL integer range.",
          sortOrder: 2_147_483_648,
        }],
      }),
    /2147483647/,
  );
});

Deno.test("legal normalization stores operator metadata, not policy text", () => {
  const normalized = normalizeLegalDocument({
    documentType: "product_terms",
    version: "2026-08-23",
    effectiveAt: "2026-08-23T00:00:00Z",
    canonicalUrl: "https://legal.example.invalid/relay/terms",
    contentSha256: "b".repeat(64),
    requiresAcceptance: true,
    acceptanceScope: "workspace",
  });

  assert.deepEqual(normalized, {
    documentType: "product_terms",
    version: "2026-08-23",
    effectiveAt: "2026-08-23T00:00:00.000Z",
    canonicalUrl: "https://legal.example.invalid/relay/terms",
    contentSha256: "b".repeat(64),
    requiresAcceptance: true,
    acceptanceScope: "workspace",
  });
  assert.equal("content" in normalized, false);

  assert.equal(
    normalizeLegalDocument({
      ...normalized,
      canonicalUrl:
        "https://legal.example.invalid/policy/user@example.com?notify=legal@example.com",
    }).canonicalUrl,
    "https://legal.example.invalid/policy/user@example.com?notify=legal@example.com",
  );

  for (
    const canonicalUrl of [
      "http://legal.example.invalid/relay/terms",
      "https://user@legal.example.invalid/relay/terms",
      "https://user:secret@legal.example.invalid/relay/terms",
      "https://legal.example.invalid/relay/terms#acceptance",
      "https://bad_host.example.invalid/relay/terms",
      " https://legal.example.invalid/relay/terms",
      "https://legal.example.invalid\\relay\\terms",
    ]
  ) {
    assert.throws(
      () => normalizeLegalDocument({ ...normalized, canonicalUrl }),
      /safe absolute HTTPS URL/,
      canonicalUrl,
    );
  }

  assert.throws(
    () =>
      normalizeLegalDocument({
        ...normalized,
        canonicalUrl: `https://legal.example.invalid/${"a".repeat(2_100)}`,
      }),
    /at most 2048 characters/,
  );
});
