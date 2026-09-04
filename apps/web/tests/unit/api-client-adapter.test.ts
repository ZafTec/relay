import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  fetchJson,
  fetchJsonResponse,
} from "../../src/lib/api/client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("API client response metadata", () => {
  it("preserves error retry, request, and location metadata", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({
        error: {
          code: "tool_queue_full",
          message: "Temporarily full.",
          retryable: true,
          retryAfterSeconds: 7,
          requestId: "req_client-adapter-1",
          details: { scope: "workspace_tool" },
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "7",
          location: "/api/v1/runs/run_0123456789abcdef0123456789abcdef",
          "x-request-id": "req_header-fallback",
        },
      },
    )));

    await expect(fetchJson("/api/v1/runs")).rejects.toMatchObject({
      name: "ApiError",
      status: 429,
      code: "tool_queue_full",
      retryable: true,
      retryAfter: "7",
      retryAfterSeconds: 7,
      requestId: "req_client-adapter-1",
      location: "/api/v1/runs/run_0123456789abcdef0123456789abcdef",
      details: { scope: "workspace_tool" },
    });
  });

  it("retains success metadata without changing fetchJson's body contract", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 202,
        headers: {
          "content-type": "application/json",
          location: "/api/v1/runs/run_0123456789abcdef0123456789abcdef",
          "x-request-id": "req_client-adapter-2",
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJsonResponse<{ readonly ok: boolean }>("/api/v1/runs"))
      .resolves.toEqual({
        data: { ok: true },
        status: 202,
        requestId: "req_client-adapter-2",
        retryable: null,
        retryAfter: null,
        retryAfterSeconds: null,
        location: "/api/v1/runs/run_0123456789abcdef0123456789abcdef",
      });
    await expect(fetchJson<{ readonly ok: boolean }>("/api/v1"))
      .resolves.toEqual({ ok: true });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBe("include");
  });

  it("falls back to a numeric Retry-After header and remains constructor-compatible", async () => {
    const legacy = new ApiError("Legacy", 400, "invalid_request", null, "req_legacy");
    expect(legacy).toMatchObject({
      retryable: null,
      retryAfter: null,
      retryAfterSeconds: null,
      location: null,
    });

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "internal_error", message: "Busy" } }),
      {
        status: 503,
        headers: { "content-type": "application/json", "retry-after": "12" },
      },
    )));

    try {
      await fetchJson("/api/v1");
      throw new Error("Expected fetchJson to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).retryAfterSeconds).toBe(12);
    }
  });
});
