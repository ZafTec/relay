import type { TelemetryAttributes } from "./attributes.ts";
import { normalizeError } from "./errors.ts";
import {
  httpStatusClass,
  normalizeHttpMethod,
  sanitizeRouteTemplate,
} from "./redaction.ts";
import type { RelayTelemetry, SafeHistogram } from "./telemetry.ts";

export interface HonoCompatibleRequest {
  readonly method: string;
  /** Hono exposes the matched route template here after routing. */
  readonly routePath?: string;
}

export interface HonoCompatibleContext {
  readonly req: HonoCompatibleRequest;
  readonly res?: { readonly status: number };
  readonly error?: unknown;
}

export type HonoCompatibleNext = () => Promise<void>;
export type HonoCompatibleMiddleware<C extends HonoCompatibleContext> = (
  context: C,
  next: HonoCompatibleNext,
) => Promise<void>;

export interface HonoRouteEnrichmentOptions<C extends HonoCompatibleContext> {
  readonly routeTemplate?: (context: C) => string | undefined;
  readonly clock?: () => number;
}

function noOpHistogram(): SafeHistogram {
  return { record() {} };
}

/**
 * Structurally compatible with Hono middleware without importing Hono or app
 * code. It enriches Deno's automatic server span rather than creating a second
 * HTTP server span.
 */
export function createHonoRouteEnrichment<
  C extends HonoCompatibleContext = HonoCompatibleContext,
>(
  telemetry: Pick<RelayTelemetry, "enrichActiveSpan" | "histogram">,
  options: HonoRouteEnrichmentOptions<C> = {},
): HonoCompatibleMiddleware<C> {
  let duration: SafeHistogram;
  try {
    duration = telemetry.histogram("relay.http.server.request.duration");
  } catch {
    duration = noOpHistogram();
  }
  const clock = options.clock ?? (() => performance.now());

  return async (honoContext, next) => {
    let startedAt: number | null = null;
    try {
      const current = clock();
      if (Number.isFinite(current)) startedAt = current;
    } catch {
      startedAt = null;
    }
    let didThrow = false;
    let thrown: unknown;

    try {
      await next();
    } catch (error) {
      didThrow = true;
      thrown = error;
      throw error;
    } finally {
      try {
        const route = sanitizeRouteTemplate(
          options.routeTemplate?.(honoContext) ?? honoContext.req.routePath,
        );
        const method = normalizeHttpMethod(honoContext.req.method);
        const contextError = didThrow ? thrown : honoContext.error;
        const status = didThrow ? 500 : honoContext.res?.status ?? 200;
        const statusClass = httpStatusClass(status);
        const hasException = didThrow || contextError !== undefined;
        const failed = hasException || statusClass === "5xx";
        const normalizedError = failed ? normalizeError(contextError) : null;
        const attributes: TelemetryAttributes = {
          "http.route": route,
          "http.request.method": method,
          "http.response.status_class": statusClass,
          ...(normalizedError === null
            ? {}
            : { "error.type": normalizedError.type }),
        };

        telemetry.enrichActiveSpan({
          name: `${method === "_OTHER" ? "HTTP" : method} ${route}`,
          attributes,
          markError: failed,
          errorType: normalizedError?.type,
          ...(hasException ? { error: contextError } : {}),
        });

        if (startedAt !== null) {
          try {
            const finishedAt = clock();
            if (Number.isFinite(finishedAt)) {
              duration.record(
                Math.max(0, finishedAt - startedAt) / 1_000,
                attributes,
              );
            }
          } catch {
            // A failed clock drops only the duration measurement.
          }
        }
      } catch {
        // Route instrumentation must never replace the response or thrown error.
      }
    }
  };
}
