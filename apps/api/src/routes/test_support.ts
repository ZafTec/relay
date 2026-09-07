import type { ApplicationServices } from "@relay/application";
import type {
  ArtifactDetail,
  ArtifactSummary,
  ArtifactVersionResource,
  RunDetail,
  ToolDetail,
  UsageSummary,
  WorkspaceEventEnvelope,
} from "@relay/contracts";
import type { SessionIdentityResolver } from "./v1.ts";

const publicId = (prefix: string, character: string) =>
  `${prefix}_${character.repeat(32)}`;

export const WORKSPACE_ID = "workspace_test";
export const USER_ID = "user_test";
export const TOOL_KEY = "image.generate";
export const TOOL_ID = publicId("tool", "1");
export const TOOL_VERSION_ID = publicId("tver", "2");
export const RUN_ID = publicId("run", "3");
export const ARTIFACT_ID = publicId("art", "4");
export const ARTIFACT_VERSION_ID = publicId("aver", "5");
export const UPLOAD_ID = publicId("upl", "6");
export const SHARE_LINK_ID = publicId("share", "7");
export const SHARE_TOKEN = "a".repeat(43);
export const NOW = "2026-08-24T10:00:00.000Z";

export const TOOL: ToolDetail = {
  id: TOOL_ID,
  key: TOOL_KEY,
  name: "Image Generate",
  category: "image",
  summary: "Generate an image.",
  lifecycle: "published",
  activeVersionId: TOOL_VERSION_ID,
  version: 1,
  executionMode: "async",
  maxDurationSeconds: 300,
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
};

export const RUN: RunDetail = {
  id: RUN_ID,
  tool: {
    key: TOOL_KEY,
    name: "Image Generate",
    versionId: TOOL_VERSION_ID,
    version: 1,
  },
  status: "queued",
  resultCompleteness: null,
  acceptedAt: NOW,
  startedAt: null,
  terminalAt: null,
  input: { prompt: "mountain" },
  outputSet: null,
  reservation: {
    id: publicId("reservation", "8"),
    metric: "images.generated",
    unit: "image",
    amount: "1",
    status: "active",
    expiresAt: "2026-08-24T10:05:00.000Z",
  },
};

export const COMPLETED_RUN: RunDetail = {
  ...RUN,
  status: "succeeded",
  resultCompleteness: "complete",
  startedAt: "2026-08-24T10:00:01.000Z",
  terminalAt: "2026-08-24T10:00:02.000Z",
  reservation: RUN.reservation === null
    ? null
    : { ...RUN.reservation, status: "committed" },
};

export const ARTIFACT_VERSION: ArtifactVersionResource = {
  id: ARTIFACT_VERSION_ID,
  sequence: 1,
  sha256: "a".repeat(64),
  contentMd5: `${"A".repeat(22)}==`,
  sizeBytes: 4,
  mimeType: "image/png",
  width: 1,
  height: 1,
  durationMs: null,
  source: "upload",
  sourceRunId: null,
  parentVersionId: null,
  metadata: {},
  verificationStatus: "head_verified",
  createdAt: NOW,
};

export const ARTIFACT_SUMMARY: ArtifactSummary = {
  id: ARTIFACT_ID,
  name: "Image",
  mediaKind: "image",
  sourceRunId: null,
  currentVersion: ARTIFACT_VERSION,
  shared: false,
  createdAt: NOW,
};

export const ARTIFACT: ArtifactDetail = {
  ...ARTIFACT_SUMMARY,
  versions: [ARTIFACT_VERSION],
  shares: [],
};

export const USAGE: UsageSummary = {
  generatedAt: NOW,
  items: [],
  truncated: false,
};

export function workspaceEvent(
  id: string,
  type: "run.created" | "run.progress_changed" = "run.created",
): WorkspaceEventEnvelope {
  return {
    id,
    workspaceId: WORKSPACE_ID,
    occurredAt: NOW,
    event: { type, runId: RUN_ID },
  };
}

export const AUTHENTICATED_IDENTITY: SessionIdentityResolver = () =>
  Promise.resolve({
    kind: "authenticated",
    identity: {
      workspaceId: WORKSPACE_ID,
      actorUserId: USER_ID,
      membershipRole: "member",
    },
  });

export interface ServiceOverrides {
  readonly tools?: Partial<ApplicationServices["tools"]>;
  readonly runs?: Partial<ApplicationServices["runs"]>;
  readonly artifacts?: Partial<ApplicationServices["artifacts"]>;
  readonly usage?: Partial<ApplicationServices["usage"]>;
  readonly events?: Partial<ApplicationServices["events"]>;
}

export function createStubServices(
  overrides: ServiceOverrides = {},
): ApplicationServices {
  const defaults: ApplicationServices = {
    tools: {
      list: () => Promise.resolve({ kind: "ok", items: [], nextCursor: null }),
      get: () => Promise.resolve({ kind: "found", tool: TOOL }),
    },
    runs: {
      create: () =>
        Promise.resolve({
          kind: "accepted",
          run: RUN,
          replayed: false,
          queueReason: "awaiting_dispatch",
        }),
      list: () => Promise.resolve({ kind: "ok", items: [], nextCursor: null }),
      get: () => Promise.resolve({ kind: "found", run: RUN }),
      cancel: () => Promise.resolve({ kind: "cancelled", run: RUN }),
    },
    artifacts: {
      list: () => Promise.resolve({ kind: "ok", items: [], nextCursor: null }),
      get: () => Promise.resolve({ kind: "found", artifact: ARTIFACT }),
      createDownload: () => Promise.resolve({ kind: "not_found" }),
      createUpload: () => Promise.resolve({ kind: "not_found" }),
      completeUpload: () => Promise.resolve({ kind: "not_found" }),
      createShareLink: () => Promise.resolve({ kind: "not_found" }),
      revokeShareLink: () => Promise.resolve({ kind: "not_found" }),
      resolveShareLink: () => Promise.resolve({ kind: "unavailable" }),
    },
    usage: {
      getStorageSummary: () => Promise.resolve({ kind: "unavailable" }),
      getSummary: () => Promise.resolve({ kind: "ok", usage: USAGE }),
    },
    events: {
      list: () => Promise.resolve({ kind: "ok", items: [], nextCursor: null }),
    },
  };

  return {
    tools: { ...defaults.tools, ...overrides.tools },
    runs: { ...defaults.runs, ...overrides.runs },
    artifacts: { ...defaults.artifacts, ...overrides.artifacts },
    usage: { ...defaults.usage, ...overrides.usage },
    events: { ...defaults.events, ...overrides.events },
  };
}

export function jsonRequest(
  body: unknown,
  headers: HeadersInit = {},
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}
