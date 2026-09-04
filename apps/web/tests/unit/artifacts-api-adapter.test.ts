import { afterEach, describe, expect, it, vi } from "vitest";
import {
  httpArtifactsAdapter,
  InvalidArtifactResponseError,
  parseCompleteArtifactUploadResponse,
  parseCreateArtifactUploadResponse,
  parseCreateShareLinkResponse,
  parseRevokeShareLinkResponse,
  putArtifactUpload,
  type UploadAuthorizationResource,
} from "../../src/lib/api/artifacts";

const ARTIFACT_ID = "art_0123456789abcdef0123456789abcdef";
const VERSION_ID = "aver_0123456789abcdef0123456789abcdef";
const UPLOAD_ID = "upl_0123456789abcdef0123456789abcdef";
const SHARE_ID = "share_0123456789abcdef0123456789abcdef";
const TOKEN = "a".repeat(43);
const CREATE_KEY = "artifact:create:00000000-0000-4000-8000-000000000000";
const COMPLETE_KEY = "artifact:complete:00000000-0000-4000-8000-000000000000";
const SHARE_KEY = "artifact:share:00000000-0000-4000-8000-000000000000";
const REVOKE_KEY = "artifact:revoke:00000000-0000-4000-8000-000000000000";
const SHA256 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const CONTENT_MD5 = "XUFAKrxLKna5cZ2REBfFkg==";

const AUTHORIZATION: UploadAuthorizationResource = {
  method: "PUT",
  url: "https://objects.example.test/signed-upload?signature=secret",
  expiresAt: "2099-08-26T10:05:00.000Z",
  requiredHeaders: {
    "content-length": "5",
    "content-type": "text/plain",
    "content-md5": CONTENT_MD5,
    "x-amz-checksum-sha256": "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=",
    "x-amz-meta-relay-upload-id": UPLOAD_ID,
    "x-amz-meta-relay-sha256": SHA256,
    "if-none-match": "*",
  },
};

const UPLOAD = {
  id: UPLOAD_ID,
  artifactId: ARTIFACT_ID,
  artifactVersionId: VERSION_ID,
  sequence: 1,
  status: "pending" as const,
  authorization: AUTHORIZATION,
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

function errorResponse(status: number, code: string, details: unknown = {}): Response {
  return jsonResponse({
    error: {
      code,
      message: `HTTP ${status}`,
      retryable: status >= 500,
      requestId: "req_artifacts-adapter-1",
      details,
    },
  }, status);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact upload adapter", () => {
  it("strictly parses upload lifecycle states and replay metadata", () => {
    expect(parseCreateArtifactUploadResponse({
      kind: "created",
      upload: UPLOAD,
      replayed: true,
    })).toEqual({ kind: "created", upload: UPLOAD, replayed: true });
    expect(parseCreateArtifactUploadResponse({
      kind: "created",
      upload: { ...UPLOAD, status: "completed", authorization: null },
      replayed: true,
    })).toMatchObject({
      kind: "created",
      upload: { status: "completed", authorization: null },
      replayed: true,
    });
    expect(parseCompleteArtifactUploadResponse({
      kind: "completed",
      artifactId: ARTIFACT_ID,
      artifactVersionId: VERSION_ID,
      becameCurrent: true,
      replayed: false,
    })).toMatchObject({ kind: "completed", becameCurrent: true, replayed: false });
    expect(parseCompleteArtifactUploadResponse({ kind: "pending", replayed: false }))
      .toEqual({ kind: "pending", replayed: false });
    expect(() => parseCompleteArtifactUploadResponse({ kind: "pending", replayed: true }))
      .toThrow(/must be false/i);
    expect(() => parseCreateArtifactUploadResponse({
      kind: "created",
      upload: { ...UPLOAD, authorization: null },
      replayed: false,
    })).toThrow(InvalidArtifactResponseError);
  });

  it("performs metadata create, credential-free signed PUT, and completion", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        kind: "created",
        upload: UPLOAD,
        replayed: false,
      }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        kind: "completed",
        artifactId: ARTIFACT_ID,
        artifactVersionId: VERSION_ID,
        becameCurrent: true,
        replayed: false,
      }, 200));
    vi.stubGlobal("fetch", fetchMock);
    const file = new Blob(["hello"], { type: "text/plain" });

    const created = await httpArtifactsAdapter.createUpload({
      target: { kind: "new_artifact", name: " greeting.txt ", mediaKind: "text" },
      sizeBytes: file.size,
      mimeType: "text/plain",
      sha256: SHA256,
      contentMd5: CONTENT_MD5,
      metadata: { labels: ["example", null] },
    }, CREATE_KEY);
    expect(created).toMatchObject({ kind: "created", replayed: false });
    if (created.kind !== "created" || created.upload.authorization === null) {
      throw new Error("Expected a pending upload authorization");
    }

    await expect(httpArtifactsAdapter.putUpload(created.upload.authorization, file))
      .resolves.toEqual({ kind: "uploaded", status: 200 });
    await expect(httpArtifactsAdapter.completeUpload(UPLOAD_ID, COMPLETE_KEY))
      .resolves.toMatchObject({ kind: "completed", becameCurrent: true, replayed: false });

    const createCall = fetchMock.mock.calls[0];
    expect(createCall?.[0]).toBe("/api/v1/artifacts/uploads");
    expect(new Headers(createCall?.[1]?.headers).get("idempotency-key")).toBe(CREATE_KEY);
    expect(JSON.parse(String(createCall?.[1]?.body))).toMatchObject({
      target: { kind: "new_artifact", name: "greeting.txt", mediaKind: "text" },
      sizeBytes: 5,
      sha256: SHA256,
      contentMd5: CONTENT_MD5,
    });

    const putCall = fetchMock.mock.calls[1];
    expect(putCall?.[0]).toBe(AUTHORIZATION.url);
    expect(putCall?.[1]).toMatchObject({
      method: "PUT",
      body: file,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    const putHeaders = new Headers(putCall?.[1]?.headers);
    expect(putHeaders.has("content-length")).toBe(false);
    for (const [name, value] of Object.entries(AUTHORIZATION.requiredHeaders)) {
      if (name !== "content-length") expect(putHeaders.get(name)).toBe(value);
    }

    const completeCall = fetchMock.mock.calls[2];
    expect(completeCall?.[0]).toBe(`/api/v1/artifacts/uploads/${UPLOAD_ID}/complete`);
    expect(new Headers(completeCall?.[1]?.headers).get("idempotency-key"))
      .toBe(COMPLETE_KEY);
    expect(completeCall?.[1]?.body).toBeUndefined();
  });

  it("rejects a mismatched signed length before sending file bytes", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(putArtifactUpload({
      ...AUTHORIZATION,
      requiredHeaders: { ...AUTHORIZATION.requiredHeaders, "content-length": "6" },
    }, new Blob(["hello"]))).resolves.toMatchObject({ kind: "degraded" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps deterministic upload failures and keeps ambiguous outcomes retryable", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(403, "upload_quota_exceeded"))
      .mockResolvedValueOnce(errorResponse(409, "idempotency_conflict"))
      .mockResolvedValueOnce(errorResponse(422, "upload_verification_failed", {
        reason: "checksum_mismatch",
      }))
      .mockRejectedValueOnce(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      target: { kind: "new_version" as const, artifactId: ARTIFACT_ID },
      sizeBytes: 5,
      mimeType: "text/plain",
      sha256: SHA256,
      contentMd5: CONTENT_MD5,
    };

    await expect(httpArtifactsAdapter.createUpload(request, CREATE_KEY))
      .resolves.toEqual({ kind: "quota-exceeded" });
    await expect(httpArtifactsAdapter.createUpload(request, CREATE_KEY))
      .resolves.toMatchObject({ kind: "idempotency-conflict" });
    await expect(httpArtifactsAdapter.completeUpload(UPLOAD_ID, COMPLETE_KEY))
      .resolves.toEqual({ kind: "verification-failed", reason: "checksum_mismatch" });
    await expect(httpArtifactsAdapter.completeUpload(UPLOAD_ID, COMPLETE_KEY))
      .resolves.toMatchObject({
        kind: "unknown_outcome",
        retryable: true,
        retryMode: "exact-request",
      });
  });
});

describe("artifact share mutation adapter", () => {
  const request = {
    artifactId: ARTIFACT_ID,
    followCurrent: true,
    expiresAt: null,
    maxResolutions: null,
    requireAuth: false,
    contentDisposition: "inline" as const,
  };

  it("requires strict replay fields and sends caller-owned stable keys", async () => {
    expect(parseCreateShareLinkResponse({
      kind: "created",
      shareLinkId: SHARE_ID,
      token: TOKEN,
      publicPath: `/s/${TOKEN}`,
      replayed: true,
    })).toMatchObject({ kind: "created", replayed: true });
    expect(parseRevokeShareLinkResponse({ kind: "revoked", replayed: true }))
      .toEqual({ kind: "revoked", replayed: true });
    expect(() => parseCreateShareLinkResponse({
      kind: "created",
      shareLinkId: SHARE_ID,
      token: TOKEN,
      publicPath: `/s/${TOKEN}`,
    })).toThrow(/replayed: is required/i);

    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        kind: "created",
        shareLinkId: SHARE_ID,
        token: TOKEN,
        publicPath: `/s/${TOKEN}`,
        replayed: false,
      }, 201, { location: `/s/${TOKEN}` }))
      .mockResolvedValueOnce(jsonResponse({ kind: "revoked", replayed: true }, 200));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpArtifactsAdapter.createShareLink(request, SHARE_KEY))
      .resolves.toMatchObject({ kind: "created", replayed: false });
    await expect(httpArtifactsAdapter.revokeShareLink(ARTIFACT_ID, SHARE_ID, REVOKE_KEY))
      .resolves.toEqual({ kind: "revoked", replayed: true });

    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("idempotency-key"))
      .toBe(SHARE_KEY);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("idempotency-key"))
      .toBe(REVOKE_KEY);
  });

  it("distinguishes policy and idempotency conflicts", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(errorResponse(409, "invalid_request", {
        reason: "share_policy_conflict",
      }))
      .mockResolvedValueOnce(errorResponse(409, "idempotency_conflict"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpArtifactsAdapter.createShareLink(request, SHARE_KEY))
      .resolves.toEqual({ kind: "conflict" });
    await expect(httpArtifactsAdapter.revokeShareLink(ARTIFACT_ID, SHARE_ID, REVOKE_KEY))
      .resolves.toMatchObject({ kind: "idempotency-conflict" });
  });

  it("reports network ambiguity as exact-request retryable", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpArtifactsAdapter.createShareLink(request, SHARE_KEY))
      .resolves.toMatchObject({
        kind: "unknown_outcome",
        retryable: true,
        retryMode: "exact-request",
      });
    await expect(httpArtifactsAdapter.revokeShareLink(ARTIFACT_ID, SHARE_ID, REVOKE_KEY))
      .resolves.toMatchObject({
        kind: "unknown_outcome",
        retryable: true,
        retryMode: "exact-request",
      });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
