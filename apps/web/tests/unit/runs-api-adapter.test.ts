import { afterEach, describe, expect, it, vi } from "vitest";
import {
  httpRunsAdapter,
  InvalidRunResponseError,
  parseCreateRunRequest,
  parseCreateRunResponse,
} from "../../src/lib/api/runs";

const RUN_ID = "run_0123456789abcdef0123456789abcdef";
const TOOL_VERSION_ID = "tver_0123456789abcdef0123456789abcdef";
const IDEMPOTENCY_KEY = "run:create:00000000-0000-4000-8000-000000000000";
const NOW = "2026-08-26T10:00:00.000Z";

const RUN = {
  id: RUN_ID,
  tool: {
    key: "image.generate",
    name: "Image generator",
    versionId: TOOL_VERSION_ID,
    version: 3,
  },
  status: "queued" as const,
  resultCompleteness: null,
  acceptedAt: NOW,
  startedAt: null,
  terminalAt: null,
  input: { prompt: "mountain" },
  outputSet: null,
  reservation: null,
};

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function errorResponse(
  status: number,
  code: string,
  details: unknown = {},
  options: { readonly retryable?: boolean; readonly retryAfterSeconds?: number } = {},
): Response {
  return jsonResponse({
    error: {
      code,
      message: `HTTP ${status}`,
      retryable: options.retryable ?? false,
      ...(options.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: options.retryAfterSeconds }),
      requestId: "req_runs-adapter-1",
      details,
    },
  }, status, options.retryAfterSeconds === undefined
    ? {}
    : { "retry-after": String(options.retryAfterSeconds) });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("run creation adapter", () => {
  it("strictly validates requests and accepted replay metadata", () => {
    expect(parseCreateRunRequest({
      toolKey: "image.generate",
      input: { prompt: "mountain" },
      requestedModelVersion: null,
    })).toEqual({
      toolKey: "image.generate",
      input: { prompt: "mountain" },
      requestedModelVersion: null,
    });
    expect(parseCreateRunResponse({
      kind: "accepted",
      run: RUN,
      replayed: true,
      queueReason: "awaiting_dispatch",
    })).toEqual({
      kind: "accepted",
      run: RUN,
      replayed: true,
      queueReason: "awaiting_dispatch",
    });

    expect(() => parseCreateRunResponse({
      kind: "accepted",
      run: RUN,
      replayed: false,
      queueReason: null,
    })).toThrow(/exactly while the run is queued/i);
    expect(() => parseCreateRunResponse({
      kind: "accepted",
      run: RUN,
      replayed: false,
      queueReason: "awaiting_dispatch",
      providerJobId: "secret",
    })).toThrow(InvalidRunResponseError);
    expect(() => parseCreateRunResponse({ kind: "not_entitled", reason: "secret" }))
      .toThrow(/reason: is not supported/i);
  });

  it("sends the exact request with a caller-owned key and verifies HTTP Location", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      kind: "accepted",
      run: RUN,
      replayed: false,
      queueReason: "awaiting_dispatch",
    }, 202, { location: `/api/v1/runs/${RUN_ID}` }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpRunsAdapter.create({
      toolKey: "image.generate",
      input: { prompt: "mountain" },
    }, IDEMPOTENCY_KEY)).resolves.toMatchObject({
      kind: "accepted",
      replayed: false,
      queueReason: "awaiting_dispatch",
    });

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe("/api/v1/runs");
    expect(call?.[1]).toMatchObject({ method: "POST", cache: "no-store" });
    expect(new Headers(call?.[1]?.headers).get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      toolKey: "image.generate",
      input: { prompt: "mountain" },
    });
  });

  it("rejects invalid keys before fetch and treats malformed success as retryable unknown", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        kind: "accepted",
        run: RUN,
        replayed: false,
        queueReason: "awaiting_dispatch",
      }, 202, { location: "/api/v1/runs/run_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpRunsAdapter.create({ toolKey: "image.generate", input: {} }, " bad "))
      .resolves.toMatchObject({ kind: "degraded", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(httpRunsAdapter.create({
      toolKey: "image.generate",
      input: {},
    }, IDEMPOTENCY_KEY)).resolves.toEqual({
      kind: "unknown-outcome",
      message: expect.stringMatching(/Retry request.*saved inputs/i),
      retryable: true,
      retryMode: "exact-request",
      retryAfterSeconds: null,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("distinguishes authentication, lookup, entitlement, allowance, capacity, and degradation", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const invoke = () => httpRunsAdapter.create({ toolKey: "image.generate", input: {} }, IDEMPOTENCY_KEY);

    fetchMock.mockResolvedValueOnce(errorResponse(401, "authentication_required"));
    await expect(invoke()).resolves.toEqual({ kind: "auth-expired" });

    fetchMock.mockResolvedValueOnce(errorResponse(404, "not_found"));
    await expect(invoke()).resolves.toEqual({ kind: "not_found" });

    fetchMock.mockResolvedValueOnce(errorResponse(403, "not_entitled"));
    await expect(invoke()).resolves.toEqual({ kind: "not-entitled" });

    fetchMock.mockResolvedValueOnce(errorResponse(409, "tool_unavailable", {
      toolKey: "image.generate",
      reason: "unavailable",
    }));
    await expect(invoke()).resolves.toEqual({ kind: "tool-unavailable" });

    fetchMock.mockResolvedValueOnce(errorResponse(409, "idempotency_conflict"));
    await expect(invoke()).resolves.toEqual({ kind: "idempotency-conflict" });

    fetchMock.mockResolvedValueOnce(errorResponse(429, "allowance_exceeded", {
      metric: "images.generated",
      unit: "image",
      limitAmount: "10",
      consumedAmount: "7",
      reservedAmount: "2",
      requestedAmount: "2",
    }));
    await expect(invoke()).resolves.toEqual({
      kind: "allowance-exceeded",
      metric: "images.generated",
      unit: "image",
      limitAmount: "10",
      consumedAmount: "7",
      reservedAmount: "2",
      requestedAmount: "2",
    });

    fetchMock.mockResolvedValueOnce(errorResponse(
      429,
      "tool_queue_full",
      { scope: "workspace_tool" },
      { retryable: true, retryAfterSeconds: 9 },
    ));
    await expect(invoke()).resolves.toEqual({
      kind: "queue-full",
      scope: "workspace_tool",
      retryable: true,
      retryAfterSeconds: 9,
    });

    fetchMock.mockResolvedValueOnce(errorResponse(
      503,
      "dependency_unavailable",
      { dependency: "metering" },
      { retryable: true },
    ));
    await expect(invoke()).resolves.toMatchObject({
      kind: "degraded",
      retryable: true,
    });
  });

  it("classifies a generic server or network failure as an exact-request unknown outcome", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(500, "internal_error"))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const invoke = () => httpRunsAdapter.create({ toolKey: "image.generate", input: {} }, IDEMPOTENCY_KEY);

    await expect(invoke()).resolves.toMatchObject({
      kind: "unknown-outcome",
      retryable: true,
      retryMode: "exact-request",
    });
    await expect(invoke()).resolves.toMatchObject({
      kind: "unknown-outcome",
      retryable: true,
      retryMode: "exact-request",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
