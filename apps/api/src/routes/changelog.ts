import { type Context, Hono } from "@hono/hono";
import type {
  PublishedChangelogPage,
  PublishedChangelogRelease,
} from "@relay/changelog";
import { HTTP_PATHS } from "@relay/contracts";
import { errorResponse, invalidRequest, notFound } from "../http/errors.ts";
import { assertNoQuery } from "../http/request.ts";

interface ChangelogEnvironment {
  Variables: {
    requestId: string;
  };
}

export interface PublicChangelogReader {
  list(options: {
    readonly limit?: number;
    readonly cursor?: string | null;
  }): Promise<PublishedChangelogPage>;
  getBySlug(slug: string): Promise<PublishedChangelogRelease | null>;
}

export interface PublicChangelogRouteDependencies {
  readonly reader: PublicChangelogReader;
  readonly createRequestId?: () => string;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const MAX_CURSOR_LENGTH = 2_048;

function requestId(
  context: Context<ChangelogEnvironment>,
  create: (() => string) | undefined,
): string {
  const inherited = context.get("requestId");
  if (typeof inherited === "string" && REQUEST_ID_PATTERN.test(inherited)) {
    return inherited;
  }

  try {
    const candidate = create?.() ?? `req_${crypto.randomUUID()}`;
    if (REQUEST_ID_PATTERN.test(candidate)) return candidate;
  } catch {
    // Correlation is best effort and must not reject a public read.
  }
  return `req_${crypto.randomUUID()}`;
}

function prepareResponse(
  context: Context<ChangelogEnvironment>,
  create: (() => string) | undefined,
): string {
  const id = requestId(context, create);
  context.set("requestId", id);
  context.header("x-request-id", id);
  context.header("x-content-type-options", "nosniff");
  return id;
}

function parseListOptions(request: Request): {
  readonly limit?: number;
  readonly cursor?: string;
} {
  const parameters = new URL(request.url).searchParams;
  for (const key of parameters.keys()) {
    if (key !== "limit" && key !== "cursor") {
      throw invalidRequest({ field: key, reason: "unknown_query_parameter" });
    }
  }

  const limitValues = parameters.getAll("limit");
  const cursorValues = parameters.getAll("cursor");
  if (limitValues.length > 1) {
    throw invalidRequest({
      field: "limit",
      reason: "duplicate_query_parameter",
    });
  }
  if (cursorValues.length > 1) {
    throw invalidRequest({
      field: "cursor",
      reason: "duplicate_query_parameter",
    });
  }

  let limit: number | undefined;
  const rawLimit = limitValues[0];
  if (rawLimit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(rawLimit)) {
      throw invalidRequest({ field: "limit", reason: "invalid_integer" });
    }
    limit = Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit > 100) {
      throw invalidRequest({ field: "limit", reason: "out_of_range" });
    }
  }

  const cursor = cursorValues[0];
  if (
    cursor !== undefined &&
    (cursor.length === 0 || cursor.length > MAX_CURSOR_LENGTH)
  ) {
    throw invalidRequest({ field: "cursor", reason: "invalid_cursor" });
  }

  return {
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export function createPublicChangelogRoutes(
  dependencies: PublicChangelogRouteDependencies,
): Hono<ChangelogEnvironment> {
  if (
    dependencies?.reader === undefined ||
    typeof dependencies.reader.list !== "function" ||
    typeof dependencies.reader.getBySlug !== "function"
  ) {
    throw new TypeError("a public changelog reader is required");
  }

  const routes = new Hono<ChangelogEnvironment>();

  routes.onError((error, context) => {
    const id = prepareResponse(context, dependencies.createRequestId);
    context.header("cache-control", "no-store");
    return errorResponse(context, error, id);
  });

  routes.get(HTTP_PATHS.changelog, async (context) => {
    prepareResponse(context, dependencies.createRequestId);
    const options = parseListOptions(context.req.raw);
    try {
      const page = await dependencies.reader.list(options);
      context.header(
        "cache-control",
        "public, max-age=60, stale-while-revalidate=300",
      );
      return context.json(page);
    } catch (error) {
      if (error instanceof TypeError) {
        throw invalidRequest({ field: "cursor", reason: "invalid_cursor" });
      }
      throw error;
    }
  });

  routes.get(HTTP_PATHS.changelogEntry, async (context) => {
    prepareResponse(context, dependencies.createRequestId);
    assertNoQuery(context.req.raw);
    const slug = context.req.param("slug");
    if (!SLUG_PATTERN.test(slug)) throw notFound();
    const release = await dependencies.reader.getBySlug(slug);
    if (release === null) throw notFound();
    context.header(
      "cache-control",
      "public, max-age=60, stale-while-revalidate=300",
    );
    return context.json(release);
  });

  return routes;
}
