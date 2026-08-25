import {
  decodePublicChangelogCursor,
  encodePublicChangelogCursor,
} from "./cursor.ts";
import {
  mapPublishedChangelogRow,
  type PublicChangelogRow,
} from "./mapping.ts";
import type {
  PublishedChangelogPage,
  PublishedChangelogRelease,
  Queryable,
} from "./types.ts";
import { pageLimit } from "./validation.ts";

export interface ListPublishedChangelogOptions {
  readonly limit?: number;
  readonly cursor?: string | null;
}

/**
 * Keyset order is `(released_at DESC, release_id DESC)`. The opaque cursor
 * carries both values so equal release timestamps never produce unstable pages.
 */
export async function listPublishedChangelog(
  db: Queryable,
  options: ListPublishedChangelogOptions = {},
): Promise<PublishedChangelogPage> {
  const limit = pageLimit(options.limit);
  const cursor = options.cursor === undefined || options.cursor === null
    ? null
    : decodePublicChangelogCursor(options.cursor);
  const { rows } = await db.query<PublicChangelogRow>(
    `select release_id, revision, snapshot, published_at
       from relay.list_public_changelog($1, $2::timestamptz, $3::bigint)`,
    [limit + 1, cursor?.releasedAt ?? null, cursor?.releaseId ?? null],
  );
  const hasNext = rows.length > limit;
  const visibleRows = rows.slice(0, limit);
  const entries = visibleRows.map(mapPublishedChangelogRow);
  const last = visibleRows.at(-1);
  return {
    entries,
    nextCursor: hasNext && last !== undefined
      ? encodePublicChangelogCursor({
        releasedAt: mapPublishedChangelogRow(last).releasedAt!,
        releaseId: last.release_id,
      })
      : null,
  };
}

/** Returns `null` for drafts, archived releases, and unknown slugs alike. */
export async function getPublishedChangelogBySlug(
  db: Queryable,
  slug: string,
): Promise<PublishedChangelogRelease | null> {
  if (slug.length === 0 || slug.length > 128) {
    throw new TypeError("slug must contain 1-128 characters");
  }
  const { rows } = await db.query<PublicChangelogRow>(
    `select release_id, revision, snapshot, published_at
       from relay.get_public_changelog($1)`,
    [slug],
  );
  return rows[0] === undefined ? null : mapPublishedChangelogRow(rows[0]);
}
