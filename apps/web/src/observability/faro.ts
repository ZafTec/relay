import {
  ErrorsInstrumentation,
  initializeFaro,
  TransportItemType,
  WebVitalsInstrumentation,
} from "@grafana/faro-web-sdk";
import type {
  BeforeSendHook,
  EventEvent,
  ExceptionEvent,
  MeasurementEvent,
  Meta,
} from "@grafana/faro-web-sdk";

const version = import.meta.env.VITE_APP_VERSION ?? "development";
const staticRoutes = new Set([
  "/",
  "/sign-in",
  "/docs",
  "/status",
  "/changelog",
  "/dashboard",
  "/dashboard/tools",
  "/dashboard/runs",
  "/dashboard/artifacts",
  "/dashboard/usage",
  "/dashboard/settings",
  "/admin",
  "/admin/changelog",
  "/admin/changelog/new",
  "/admin/capacity",
  "/admin/allowances",
  "/profile",
  "/oauth/consent",
  "/oauth/workspace",
]);
const dynamicRoutes: [RegExp, string][] = [
  [/^\/dashboard\/tools\/[^/]+$/, "/dashboard/tools/:toolKey"],
  [/^\/dashboard\/runs\/[^/]+$/, "/dashboard/runs/:runId"],
  [/^\/dashboard\/artifacts\/[^/]+$/, "/dashboard/artifacts/:artifactId"],
  [
    /^\/admin\/changelog\/[^/]+\/preview$/,
    "/admin/changelog/:releaseId/preview",
  ],
  [/^\/admin\/changelog\/[^/]+$/, "/admin/changelog/:releaseId"],
  [/^\/changelog\/[^/]+$/, "/changelog/:slug"],
];

export function telemetryPageUrl(raw: string): string {
  const origin = globalThis.location.origin;
  try {
    const url = new URL(raw, origin);
    if (url.origin === origin) {
      const path = url.pathname.replace(/\/$/, "") || "/";
      if (staticRoutes.has(path)) return origin + path;
      for (const [pattern, route] of dynamicRoutes) {
        if (pattern.test(path)) return origin + route;
      }
    }
  } catch { /* Unknown URLs get the same bounded route. */ }
  return origin + "/__unknown__";
}

// Rebuild each payload from an allowlist. SDK defaults may contain URLs, DOM
// selectors, user data, exception messages, and request/console contents.
export const sanitizeBrowserTelemetry: BeforeSendHook = (item) => {
  const origin = globalThis.location.origin;
  const meta: Meta = {
    app: {
      name: "relay-web",
      namespace: "relay",
      environment: "production",
      version,
    },
    page: {
      url: telemetryPageUrl(item.meta.page?.url ?? globalThis.location.href),
    },
  };
  const timestamp = new Date().toISOString();

  if (item.type === TransportItemType.EXCEPTION) {
    const error = item.payload as ExceptionEvent;
    const type =
      /^(Error|TypeError|RangeError|ReferenceError|SyntaxError|URIError|EvalError)$/
          .test(error.type)
        ? error.type
        : "Error";
    // Only bundled asset locations survive. Function names and source text can
    // contain application data; line/column numbers suffice to locate a build.
    const frames = (error.stacktrace?.frames ?? []).slice(0, 20).flatMap(
      (frame) => {
        try {
          const url = new URL(frame.filename, origin);
          if (
            url.origin !== origin ||
            !/^\/assets\/[A-Za-z0-9_-]+\.js$/.test(url.pathname)
          ) return [];
          return [{
            filename: origin + url.pathname,
            function: "",
            ...(Number.isSafeInteger(frame.lineno) && frame.lineno! > 0
              ? { lineno: frame.lineno }
              : {}),
            ...(Number.isSafeInteger(frame.colno) && frame.colno! > 0
              ? { colno: frame.colno }
              : {}),
          }];
        } catch {
          return [];
        }
      },
    );
    return {
      type: item.type,
      meta,
      payload: {
        timestamp,
        type,
        value: "Unhandled browser error",
        stacktrace: { frames },
      },
    };
  }
  if (item.type === TransportItemType.MEASUREMENT) {
    const measurement = item.payload as MeasurementEvent;
    if (measurement.type !== "web-vitals") return null;
    const values = Object.fromEntries(
      Object.entries(measurement.values).filter(([key, value]) =>
        /^(cls|fcp|inp|lcp|ttfb)$/.test(key) && Number.isFinite(value) &&
        value >= 0
      ),
    );
    if (Object.keys(values).length === 0) return null;
    return {
      type: item.type,
      meta,
      payload: { type: "web-vitals", timestamp, values },
    };
  }
  if (
    item.type === TransportItemType.EVENT &&
    (item.payload as EventEvent).name === "page_load"
  ) {
    return {
      type: item.type,
      meta,
      payload: { name: "page_load", domain: "relay", timestamp },
    };
  }
  return null;
};

let started = false;

export function startBrowserTelemetry(): void {
  if (
    started || !import.meta.env.PROD ||
    globalThis.location.origin !== import.meta.env.VITE_APP_ORIGIN ||
    !import.meta.env.VITE_FARO_COLLECTOR_URL
  ) {
    return;
  }
  try {
    const collector = new URL(import.meta.env.VITE_FARO_COLLECTOR_URL);
    if (
      collector.protocol !== "https:" || collector.username ||
      collector.password
    ) return;
    started = true;
    const faro = initializeFaro({
      url: collector.href,
      app: { name: "relay-web", version, environment: "production" },
      instrumentations: [
        new ErrorsInstrumentation(),
        new WebVitalsInstrumentation(),
      ],
      sessionTracking: { enabled: false },
      trackGeolocation: false,
      preventGlobalExposure: true,
      beforeSend: sanitizeBrowserTelemetry,
    });
    faro?.api.pushEvent("page_load");
  } catch { /* Telemetry must not prevent the application from starting. */ }
}
