import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeFaro, TransportItemType } from "@grafana/faro-web-sdk";
import type { TransportItem } from "@grafana/faro-web-sdk";
import {
  sanitizeBrowserTelemetry,
  telemetryPageUrl,
} from "../../src/observability/faro";

vi.mock("@grafana/faro-web-sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("@grafana/faro-web-sdk")>(),
  initializeFaro: vi.fn(),
}));

const meta = {
  page: {
    url:
      "https://relay.zaftech.co/dashboard/runs/private-run?token=secret#private",
  },
  user: { email: "private@example.com" },
  session: { id: "private-session" },
  app: { name: "unexpected", version: "private-version" },
  browser: { userAgent: "private-agent" },
};

describe("browser telemetry privacy", () => {
  it("keeps only known route templates, never query strings or identifiers", () => {
    expect(telemetryPageUrl(meta.page.url)).toBe(
      "https://relay.zaftech.co/dashboard/runs/:runId",
    );
    expect(telemetryPageUrl("/sign-in?returnTo=secret")).toBe(
      "https://relay.zaftech.co/sign-in",
    );
    for (
      const url of [
        "/s/bearer-secret",
        "/unexpected-secret",
        "https://outside.example/docs",
        "http://[",
      ]
    ) {
      expect(telemetryPageUrl(url)).toBe(
        "https://relay.zaftech.co/__unknown__",
      );
    }
  });

  it("strips private metadata, error text, contexts, and external stack frames", () => {
    const result = sanitizeBrowserTelemetry({
      type: TransportItemType.EXCEPTION,
      meta,
      payload: {
        timestamp: "2026-09-06T00:00:00Z",
        type: "TypeError",
        value: "private prompt",
        fingerprint: "private-fingerprint",
        context: { request: "private-body" },
        stacktrace: {
          frames: [
            {
              filename:
                "https://relay.zaftech.co/assets/index-abc123.js?secret=private",
              function: "private-function",
              lineno: 42,
            },
            {
              filename: "https://external.example/private.js",
              function: "private",
            },
            {
              filename: "https://relay.zaftech.co/s/private",
              function: "private",
            },
          ],
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
    expect(result?.payload).toMatchObject({
      type: "TypeError",
      value: "Unhandled browser error",
      stacktrace: {
        frames: [{
          filename: "https://relay.zaftech.co/assets/index-abc123.js",
          function: "",
          lineno: 42,
        }],
      },
    });
    expect(result?.meta.user).toBeUndefined();
  });

  it("only retains finite web vital measurements without DOM selectors or resource URLs", () => {
    const result = sanitizeBrowserTelemetry({
      type: TransportItemType.MEASUREMENT,
      meta,
      payload: {
        timestamp: "2026-09-06T00:00:00Z",
        type: "web-vitals",
        values: { lcp: 1200, cls: 0.01, inp: NaN, ttfb: -1, secret: 123 },
        context: { resource_url: "private-url", element: "private-selector" },
      },
    });
    expect(result?.payload).toMatchObject({ values: { lcp: 1200, cls: 0.01 } });
    expect(JSON.stringify(result)).not.toMatch(/private|secret|context/);
  });

  it("drops console logs, requests, traces and unapproved custom events", () => {
    for (
      const type of [
        TransportItemType.LOG,
        TransportItemType.TRACE,
        TransportItemType.EVENT,
      ]
    ) {
      expect(
        sanitizeBrowserTelemetry(
          { type, meta, payload: { name: "private-event" } } as TransportItem,
        ),
      ).toBeNull();
    }
    const result = sanitizeBrowserTelemetry({
      type: TransportItemType.EVENT,
      meta,
      payload: {
        name: "page_load",
        timestamp: "2026-09-06T00:00:00Z",
        attributes: { data: "private" },
      },
    });
    expect(result?.payload).toMatchObject({
      name: "page_load",
      domain: "relay",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});

describe("telemetry startup", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("never sends preview or local traffic to production", async () => {
    vi.stubEnv("PROD", true);
    const { startBrowserTelemetry } = await import(
      "../../src/observability/faro"
    );
    startBrowserTelemetry();
    expect(initializeFaro).not.toHaveBeenCalled();
  });

  it("uses the existing collector without persistent sessions and starts once", async () => {
    vi.stubEnv("PROD", true);
    vi.stubGlobal("location", new URL("https://relay.zaftech.co/"));
    const { startBrowserTelemetry } = await import(
      "../../src/observability/faro"
    );
    startBrowserTelemetry();
    startBrowserTelemetry();
    expect(initializeFaro).toHaveBeenCalledTimes(1);
    expect(initializeFaro).toHaveBeenCalledWith(expect.objectContaining({
      url: "https://zaftech.co/collect",
      sessionTracking: { enabled: false },
      trackGeolocation: false,
    }));
  });

  it("allows the app to start when the SDK fails", async () => {
    vi.stubEnv("PROD", true);
    vi.stubGlobal("location", new URL("https://relay.zaftech.co/"));
    vi.mocked(initializeFaro).mockImplementationOnce(() => {
      throw new Error("collector unavailable");
    });
    const { startBrowserTelemetry } = await import(
      "../../src/observability/faro"
    );
    expect(() => startBrowserTelemetry()).not.toThrow();
  });
});
