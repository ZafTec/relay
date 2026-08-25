import { assertEquals } from "@std/assert";
import type {
  PublishedChangelogPage,
  PublishedChangelogRelease,
} from "@relay/changelog";
import {
  changelogEntryPath,
  errorEnvelopeSchema,
  HTTP_PATHS,
} from "@relay/contracts";
import {
  createPublicChangelogRoutes,
  type PublicChangelogReader,
} from "./changelog.ts";

const REQUEST_ID = "req_public-changelog-0001";
const RELEASE: PublishedChangelogRelease = {
  version: "0.4.0",
  slug: "release-0-4-0",
  title: "Relay 0.4.0",
  summary: "A reviewed release.",
  gitTag: "v0.4.0",
  commitSha: "a".repeat(40),
  releasedAt: "2026-08-24T10:00:00.000Z",
  items: [{
    category: "added",
    area: "API",
    title: "Public changelog",
    description: "Published revisions are available over HTTP.",
    sortOrder: 0,
  }],
  contentSha256: "b".repeat(64),
  revision: 1,
  publishedAt: "2026-08-24T10:05:00.000Z",
};

function reader(
  overrides: Partial<PublicChangelogReader> = {},
): PublicChangelogReader {
  return {
    list: () => Promise.resolve({ entries: [], nextCursor: null }),
    getBySlug: () => Promise.resolve(null),
    ...overrides,
  };
}

function errorCode(value: unknown): string {
  return errorEnvelopeSchema.parse(value).error.code;
}

Deno.test("public changelog list validates pagination and preserves the service page", async () => {
  let received: unknown;
  const page: PublishedChangelogPage = {
    entries: [RELEASE],
    nextCursor: "next-cursor",
  };
  const routes = createPublicChangelogRoutes({
    reader: reader({
      list(options) {
        received = options;
        return Promise.resolve(page);
      },
    }),
    createRequestId: () => REQUEST_ID,
  });

  const response = await routes.request(
    `${HTTP_PATHS.changelog}?limit=25&cursor=opaque`,
  );

  assertEquals(response.status, 200);
  assertEquals(await response.json(), page);
  assertEquals(received, { limit: 25, cursor: "opaque" });
  assertEquals(response.headers.get("x-request-id"), REQUEST_ID);
  assertEquals(
    response.headers.get("cache-control"),
    "public, max-age=60, stale-while-revalidate=300",
  );
  assertEquals(response.headers.get("x-content-type-options"), "nosniff");
});

Deno.test("public changelog list rejects unknown, duplicate, and invalid query values", async () => {
  const routes = createPublicChangelogRoutes({
    reader: reader(),
    createRequestId: () => REQUEST_ID,
  });

  for (
    const query of [
      "?offset=1",
      "?limit=1&limit=2",
      "?limit=0",
      "?limit=101",
      "?cursor=",
    ]
  ) {
    const response = await routes.request(`${HTTP_PATHS.changelog}${query}`);
    assertEquals(response.status, 400);
    assertEquals(errorCode(await response.json()), "invalid_request");
    assertEquals(response.headers.get("x-request-id"), REQUEST_ID);
    assertEquals(response.headers.get("cache-control"), "no-store");
  }
});

Deno.test("public changelog entry returns only published service output", async () => {
  let receivedSlug: string | undefined;
  const routes = createPublicChangelogRoutes({
    reader: reader({
      getBySlug(slug) {
        receivedSlug = slug;
        return Promise.resolve(slug === RELEASE.slug ? RELEASE : null);
      },
    }),
    createRequestId: () => REQUEST_ID,
  });

  const response = await routes.request(changelogEntryPath(RELEASE.slug));
  assertEquals(response.status, 200);
  assertEquals(await response.json(), RELEASE);
  assertEquals(receivedSlug, RELEASE.slug);

  const missing = await routes.request(changelogEntryPath("missing-release"));
  assertEquals(missing.status, 404);
  assertEquals(errorCode(await missing.json()), "not_found");
  assertEquals(missing.headers.get("cache-control"), "no-store");

  const malformed = await routes.request(`${HTTP_PATHS.changelog}/Not_Valid`);
  assertEquals(malformed.status, 404);
  assertEquals(errorCode(await malformed.json()), "not_found");
});

Deno.test("public changelog errors never expose database details", async () => {
  const routes = createPublicChangelogRoutes({
    reader: reader({
      list: () => Promise.reject(new Error("postgres secret detail")),
    }),
    createRequestId: () => REQUEST_ID,
  });

  const response = await routes.request(HTTP_PATHS.changelog);
  const body = await response.json();
  assertEquals(response.status, 500);
  assertEquals(errorCode(body), "internal_error");
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(JSON.stringify(body).includes("postgres secret detail"), false);
});
