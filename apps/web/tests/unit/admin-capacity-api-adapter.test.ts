import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminCapacityListPath,
  adminCapacityPolicyPath,
  httpAdminCapacityAdapter,
  InvalidAdminCapacityResponseError,
  parseAdminCapacityListResponse,
  parseAdminCapacityPolicyResponse,
  parseReviseAdminCapacityResponse,
} from "../../src/lib/api/admin-capacity";

const SCOPE_TYPE = "tool";
const SCOPE_ID = "tool_0123456789abcdef0123456789abcdef";
const NOW = "2026-08-26T10:00:00.000Z";
const LATER = "2026-08-27T10:00:00.000Z";
const IDEMPOTENCY_KEY = "capacity:revise:00000000-0000-4000-8000-000000000000";
const CONFIGURATION = {
  customLimits: {
    enabled: true,
    labels: ["interactive", null],
  },
  submissionRateDefaults: { providerPerMinute: 12 },
};
const CANONICAL_CONFIGURATION =
  '{"customLimits":{"enabled":true,"labels":["interactive",null]},"submissionRateDefaults":{"providerPerMinute":12}}';

const POLICY = {
  policyId: "42",
  scopeType: SCOPE_TYPE,
  scopeId: SCOPE_ID,
  revision: 1,
  configuration: CONFIGURATION,
  canonicalJson: CANONICAL_CONFIGURATION,
  immutableHash: "a".repeat(64),
  effectiveAt: NOW,
  expiresAt: null,
};

const POLICY_2 = {
  ...POLICY,
  policyId: "43",
  revision: 2,
  effectiveAt: LATER,
  immutableHash: "b".repeat(64),
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, code: string, details: unknown = {}): Response {
  return jsonResponse({
    error: {
      code,
      message: `HTTP ${status}`,
      retryable: status >= 500,
      requestId: "req_admin-capacity-web-1",
      details,
    },
  }, status);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin capacity response parsing", () => {
  it("preserves generic configuration JSON and complete history", () => {
    const parsed = parseAdminCapacityListResponse({ policies: [POLICY, POLICY_2] });
    expect(parsed.policies).toHaveLength(2);
    expect(parsed.policies[0]?.configuration).toEqual(CONFIGURATION);
    expect(parsed.policies[1]?.revision).toBe(2);
    expect(parseAdminCapacityPolicyResponse(POLICY)).toEqual(POLICY);
    expect(parseReviseAdminCapacityResponse({
      kind: "revised",
      value: POLICY_2,
      replayed: true,
    }, SCOPE_TYPE, SCOPE_ID, 1)).toMatchObject({
      kind: "revised",
      replayed: true,
      value: { revision: 2 },
    });
  });

  it("rejects unknown fields, noncanonical configuration, and revision mismatches", () => {
    expect(() => parseAdminCapacityPolicyResponse({ ...POLICY, databaseSecret: true }))
      .toThrow(/databaseSecret: is not supported/i);
    expect(() => parseAdminCapacityPolicyResponse({
      ...POLICY,
      canonicalJson: '{"submissionRateDefaults":{"providerPerMinute":12},"customLimits":{"enabled":true,"labels":["interactive",null]}}',
    })).toThrow(/does not match configuration/i);
    expect(() => parseReviseAdminCapacityResponse({
      kind: "revised",
      value: POLICY,
      replayed: false,
    }, SCOPE_TYPE, SCOPE_ID, 1)).toThrow(/requested revision/i);
    expect(() => parseAdminCapacityListResponse({ policies: [POLICY], cursor: "secret" }))
      .toThrow(InvalidAdminCapacityResponseError);
  });
});

describe("admin capacity requests", () => {
  it("builds strict history and point-in-time paths", () => {
    expect(adminCapacityListPath()).toBe("/api/v1/admin/capacity-policies");
    expect(adminCapacityListPath({
      scopeType: SCOPE_TYPE,
      scopeId: SCOPE_ID,
      includeHistory: true,
      limit: 2,
    })).toBe(
      `/api/v1/admin/capacity-policies?scopeType=${SCOPE_TYPE}&scopeId=${SCOPE_ID}&includeHistory=true&limit=2`,
    );
    expect(adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID, { revision: 1 }))
      .toBe(`/api/v1/admin/capacity-policies/${SCOPE_TYPE}/${SCOPE_ID}?revision=1`);
    expect(() => adminCapacityListPath({ scopeId: SCOPE_ID }))
      .toThrow(/requires scopeType/i);
    expect(() => adminCapacityListPath({ includeHistory: true, effectiveAt: NOW }))
      .toThrow(/incompatible/i);
    expect(() => adminCapacityPolicyPath(SCOPE_TYPE, SCOPE_ID, {
      revision: 1,
      effectiveAt: NOW,
    })).toThrow(/incompatible/i);
  });

  it("uses exact endpoints, optimistic revision, generic JSON, and a stable key", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ policies: [POLICY, POLICY_2] }))
      .mockResolvedValueOnce(jsonResponse(POLICY))
      .mockResolvedValueOnce(jsonResponse({
        kind: "revised",
        value: POLICY_2,
        replayed: false,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpAdminCapacityAdapter.list({
      scopeType: SCOPE_TYPE,
      scopeId: SCOPE_ID,
      includeHistory: true,
      limit: 2,
    })).resolves.toMatchObject({ kind: "ok", policies: [POLICY, POLICY_2] });
    await expect(httpAdminCapacityAdapter.get(SCOPE_TYPE, SCOPE_ID, { revision: 1 }))
      .resolves.toEqual({ kind: "found", policy: POLICY });
    await expect(httpAdminCapacityAdapter.revise(SCOPE_TYPE, SCOPE_ID, {
      expectedRevision: 1,
      configuration: CONFIGURATION,
      effectiveAt: LATER,
      expiresAt: null,
    }, IDEMPOTENCY_KEY)).resolves.toMatchObject({
      kind: "revised",
      replayed: false,
      value: { revision: 2 },
    });

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      `/api/v1/admin/capacity-policies?scopeType=${SCOPE_TYPE}&scopeId=${SCOPE_ID}&includeHistory=true&limit=2`,
      `/api/v1/admin/capacity-policies/${SCOPE_TYPE}/${SCOPE_ID}?revision=1`,
      `/api/v1/admin/capacity-policies/${SCOPE_TYPE}/${SCOPE_ID}`,
    ]);
    const mutation = fetchMock.mock.calls[2]?.[1];
    expect(mutation).toMatchObject({ method: "POST", cache: "no-store" });
    expect(new Headers(mutation?.headers).get("idempotency-key")).toBe(IDEMPOTENCY_KEY);
    expect(JSON.parse(String(mutation?.body))).toEqual({
      expectedRevision: 1,
      configuration: CONFIGURATION,
      effectiveAt: LATER,
      expiresAt: null,
    });
  });

  it("rejects invalid mutation input before fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpAdminCapacityAdapter.revise(SCOPE_TYPE, SCOPE_ID, {
      expectedRevision: 1,
      configuration: CONFIGURATION,
      effectiveAt: NOW,
      expiresAt: NOW,
    }, "short")).resolves.toMatchObject({ kind: "degraded" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("admin capacity failure mapping", () => {
  it("distinguishes reauthentication, denial, not-found, revision, and idempotency conflicts", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(401, "reauthentication_required"))
      .mockResolvedValueOnce(errorResponse(403, "authorization_denied"))
      .mockResolvedValueOnce(errorResponse(404, "not_found"))
      .mockResolvedValueOnce(errorResponse(409, "invalid_request", {
        reason: "revision_conflict",
        actualRevision: 7,
      }))
      .mockResolvedValueOnce(errorResponse(409, "idempotency_conflict"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpAdminCapacityAdapter.list()).resolves.toEqual({
      kind: "reauthentication-required",
    });
    await expect(httpAdminCapacityAdapter.get(SCOPE_TYPE, SCOPE_ID)).resolves.toEqual({
      kind: "denied",
    });
    await expect(httpAdminCapacityAdapter.get(SCOPE_TYPE, SCOPE_ID)).resolves.toEqual({
      kind: "not-found",
    });
    const revise = () => httpAdminCapacityAdapter.revise(SCOPE_TYPE, SCOPE_ID, {
      expectedRevision: 1,
      configuration: CONFIGURATION,
      effectiveAt: LATER,
    }, IDEMPOTENCY_KEY);
    await expect(revise()).resolves.toEqual({ kind: "revision-conflict", actualRevision: 7 });
    await expect(revise()).resolves.toEqual({ kind: "idempotency-conflict" });
  });

  it("treats server, network, abort, and malformed success outcomes as exact-request unknown", async () => {
    const abort = new DOMException("navigation", "AbortError");
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(500, "internal_error"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(abort)
      .mockResolvedValueOnce(jsonResponse({
        kind: "revised",
        value: { ...POLICY_2, internal: true },
        replayed: false,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const revise = () => httpAdminCapacityAdapter.revise(SCOPE_TYPE, SCOPE_ID, {
      expectedRevision: 1,
      configuration: CONFIGURATION,
      effectiveAt: LATER,
    }, IDEMPOTENCY_KEY);

    for (let index = 0; index < 4; index += 1) {
      await expect(revise()).resolves.toMatchObject({
        kind: "unknown-outcome",
        retryable: true,
        retryMode: "exact-request",
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
