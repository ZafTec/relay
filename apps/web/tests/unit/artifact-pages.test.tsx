import axe from "axe-core";
import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { RelayIdentity, RelayWorkspace } from "../../src/auth/types";
import { ArtifactDetailPage } from "../../src/features/artifacts/ArtifactDetailPage";
import { ArtifactsPage } from "../../src/features/artifacts/ArtifactsPage";
import {
  type ArtifactDetail,
  type ArtifactSummary,
  type ArtifactVersionResource,
  type ArtifactsAdapter,
  type CreateShareLinkAdapterResult,
  type RevokeShareLinkAdapterResult,
  httpArtifactsAdapter,
  parseCreateShareLinkResponse,
  parseListArtifactsResponse,
} from "../../src/lib/api/artifacts";

const ARTIFACT_ID = "art_11111111111111111111111111111111";
const OTHER_ARTIFACT_ID = "art_99999999999999999999999999999999";
const VERSION_ID = "aver_22222222222222222222222222222222";
const EARLIER_VERSION_ID = "aver_33333333333333333333333333333333";
const RUN_ID = "run_44444444444444444444444444444444";
const SHARE_ID = "share_55555555555555555555555555555555";
const CREATED_SHARE_ID = "share_66666666666666666666666666666666";
const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const PUBLIC_PATH = `/s/${TOKEN}`;

const currentVersion: ArtifactVersionResource = {
  id: VERSION_ID,
  sequence: 2,
  sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
  sizeBytes: 2_621_440,
  mimeType: "image/png",
  width: 2048,
  height: 2048,
  durationMs: null,
  source: "generated",
  sourceRunId: RUN_ID,
  parentVersionId: EARLIER_VERSION_ID,
  metadata: { output: 1 },
  verificationStatus: "cryptographically_verified",
  createdAt: "2030-01-02T03:04:05.000Z",
};

const earlierVersion: ArtifactVersionResource = {
  id: EARLIER_VERSION_ID,
  sequence: 1,
  sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  contentMd5: "BBBBBBBBBBBBBBBBBBBBBB==",
  sizeBytes: 1_048_576,
  mimeType: "image/png",
  width: 1024,
  height: 1024,
  durationMs: null,
  source: "upload",
  sourceRunId: null,
  parentVersionId: null,
  metadata: {},
  verificationStatus: "head_verified",
  createdAt: "2030-01-01T01:02:03.000Z",
};

const artifactSummary: ArtifactSummary = {
  id: ARTIFACT_ID,
  name: "Campaign master",
  mediaKind: "image",
  sourceRunId: RUN_ID,
  currentVersion,
  shared: true,
  createdAt: "2030-01-01T00:00:00.000Z",
};

const artifactDetail: ArtifactDetail = {
  ...artifactSummary,
  versions: [currentVersion, earlierVersion],
  shares: [
    {
      id: SHARE_ID,
      artifactId: ARTIFACT_ID,
      artifactVersionId: VERSION_ID,
      followCurrent: false,
      expiresAt: "2030-02-01T00:00:00.000Z",
      maxResolutions: 12,
      resolutionCount: 3,
      requireAuth: true,
      contentDisposition: "inline",
      status: "active",
      createdAt: "2030-01-03T00:00:00.000Z",
    },
  ],
};

const otherArtifactDetail: ArtifactDetail = {
  ...artifactDetail,
  id: OTHER_ARTIFACT_ID,
  name: "Alternate artifact",
  sourceRunId: null,
  shared: false,
  createdAt: "2030-03-01T00:00:00.000Z",
  shares: [],
};

const identity: RelayIdentity = {
  session: {
    id: "session-artifacts",
    userId: "user-artifacts",
    expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    activeWorkspaceId: "workspace-artifacts",
  },
  user: {
    id: "user-artifacts",
    name: "Morgan Lee",
    email: "morgan@example.test",
    image: null,
  },
};

const workspace: RelayWorkspace = {
  id: "workspace-artifacts",
  name: "Artifacts workspace",
  slug: "artifacts",
};

function createArtifactsAdapter(overrides: Partial<ArtifactsAdapter> = {}): ArtifactsAdapter {
  return {
    list: vi.fn(async () => ({ kind: "ok", items: [artifactSummary], nextCursor: null })),
    get: vi.fn(async () => ({ kind: "found", artifact: artifactDetail })),
    createShareLink: vi.fn(async () => ({
      kind: "conflict",
    } as CreateShareLinkAdapterResult)),
    revokeShareLink: vi.fn(async () => ({
      kind: "not_found",
    } as RevokeShareLinkAdapterResult)),
    ...overrides,
  };
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function SignInProbe() {
  const location = useLocation();
  return <h1>Sign in {location.search}</h1>;
}

function DetailRouteHarness({ adapter }: { adapter: ArtifactsAdapter }) {
  const [artifactId, setArtifactId] = useState(ARTIFACT_ID);
  return (
    <>
      <button type="button" onClick={() => setArtifactId(OTHER_ARTIFACT_ID)}>
        Switch artifact route
      </button>
      <ArtifactDetailPage adapter={adapter} artifactId={artifactId} />
    </>
  );
}

function GalleryUnmountHarness({ adapter }: { adapter: ArtifactsAdapter }) {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setVisible(false)}>Remove gallery</button>
      {visible ? <ArtifactsPage adapter={adapter} /> : <p>Gallery removed</p>}
    </>
  );
}

function renderProtectedPage(
  page: React.ReactElement,
  initialEntry: string,
  path: string,
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider adapter={createTestAuthAdapter({ identity, activeWorkspace: workspace })}>
        <Routes>
          <Route path="/sign-in" element={<SignInProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route path={path} element={page} />
          </Route>
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations).toEqual([]);
}

async function completeSharePolicy(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Version policy"), "pinned");
  await user.selectOptions(screen.getByLabelText("Pinned version"), VERSION_ID);
  await user.selectOptions(screen.getByLabelText("Expiry policy"), "never");
  await user.selectOptions(screen.getByLabelText("Resolution limit"), "unlimited");
  await user.selectOptions(screen.getByLabelText("Access policy"), "public");
  await user.selectOptions(screen.getByLabelText("Delivery behavior"), "inline");
}

describe("artifact response parsing", () => {
  it("strictly rejects unknown response fields and mismatched returned paths", () => {
    expect(() => parseListArtifactsResponse({
      kind: "ok",
      items: [{ ...artifactSummary, provider: "invented" }],
      nextCursor: null,
    })).toThrow(/provider: is not supported/i);

    expect(() => parseCreateShareLinkResponse({
      kind: "created",
      shareLinkId: CREATED_SHARE_ID,
      token: TOKEN,
      publicPath: `/s/${"z".repeat(43)}`,
    })).toThrow(/must identify the returned token/i);
  });

  it("posts the exact nested share payload and reports an uncertain server result without retrying", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: "created",
        shareLinkId: CREATED_SHARE_ID,
        token: TOKEN,
        publicPath: PUBLIC_PATH,
      }), { status: 201, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { code: "unavailable", message: "unavailable" },
      }), { status: 503, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const request = {
      artifactId: ARTIFACT_ID,
      followCurrent: false,
      artifactVersionId: VERSION_ID,
      expiresAt: null,
      maxResolutions: null,
      requireAuth: true,
      contentDisposition: "inline" as const,
    };
    await expect(httpArtifactsAdapter.createShareLink(request)).resolves.toEqual({
      kind: "created",
      shareLinkId: CREATED_SHARE_ID,
      token: TOKEN,
      publicPath: PUBLIC_PATH,
    });

    const firstCall = fetchMock.mock.calls[0];
    expect(firstCall?.[0]).toBe(`${"/api/v1/artifacts/"}${ARTIFACT_ID}/share-links`);
    expect(JSON.parse(String((firstCall?.[1] as RequestInit | undefined)?.body))).toEqual({
      followCurrent: false,
      artifactVersionId: VERSION_ID,
      expiresAt: null,
      maxResolutions: null,
      requireAuth: true,
      contentDisposition: "inline",
    });

    await expect(httpArtifactsAdapter.createShareLink(request)).resolves.toEqual({
      kind: "unknown_outcome",
      message: "Relay could not confirm whether the share link was created. Do not retry this request. Close the panel and inspect the share records.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies transport and response parsing failures as unknown create outcomes", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        kind: "created",
        shareLinkId: CREATED_SHARE_ID,
        token: TOKEN,
        publicPath: `/s/${"z".repeat(43)}`,
      }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const request = {
      artifactId: ARTIFACT_ID,
      followCurrent: false,
      artifactVersionId: VERSION_ID,
      expiresAt: null,
      maxResolutions: null,
      requireAuth: false,
      contentDisposition: "inline" as const,
    };

    await expect(httpArtifactsAdapter.createShareLink(request)).resolves.toMatchObject({
      kind: "unknown_outcome",
    });
    await expect(httpArtifactsAdapter.createShareLink(request)).resolves.toMatchObject({
      kind: "unknown_outcome",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("artifact gallery page", () => {
  it("renders contract data without fabricated previews, providers, URLs, or totals", async () => {
    let resolveList!: (result: Awaited<ReturnType<ArtifactsAdapter["list"]>>) => void;
    const listPromise = new Promise<Awaited<ReturnType<ArtifactsAdapter["list"]>>>((resolve) => {
      resolveList = resolve;
    });
    const adapter = createArtifactsAdapter({ list: vi.fn(() => listPromise) });
    const { container } = renderProtectedPage(
      <ArtifactsPage adapter={adapter} />,
      "/dashboard/artifacts",
      "/dashboard/artifacts",
    );

    expect(await screen.findByText("Loading artifacts")).toBeInTheDocument();
    await act(async () => resolveList({ kind: "ok", items: [artifactSummary], nextCursor: null }));
    expect(await screen.findByRole("link", { name: "Open artifact Campaign master" })).toHaveAttribute(
      "href",
      `/dashboard/artifacts/${ARTIFACT_ID}`,
    );
    expect(await screen.findByText("Workspace workspace-artifacts")).toBeInTheDocument();
    expect(screen.getByText("Preview URL not provided")).toBeInTheDocument();
    expect(screen.getByText("1 artifact loaded")).toBeInTheDocument();
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "/relay/brand/icon-artifact.svg",
    );
    expect(container.querySelector('a[href^="/s/"]')).toBeNull();
    expect(screen.queryByText(/Halide|Aurora|provider/i)).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("distinguishes an empty registry from a filtered no-match result", async () => {
    const user = userEvent.setup();
    const list = vi.fn(async () => ({
      kind: "ok" as const,
      items: [] as readonly ArtifactSummary[],
      nextCursor: null,
    }));
    const adapter = createArtifactsAdapter({ list });
    renderProtectedPage(
      <ArtifactsPage adapter={adapter} />,
      "/dashboard/artifacts",
      "/dashboard/artifacts",
    );

    expect(await screen.findByRole("heading", { name: "No artifacts yet" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search"), "missing artifact");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(await screen.findByRole("heading", { name: "No matching artifacts" })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith(
      { limit: 25, search: "missing artifact" },
      expect.any(AbortSignal),
    );
  });

  it("keeps the newest list result when an older request resolves late", async () => {
    const user = userEvent.setup();
    const first = deferred<Awaited<ReturnType<ArtifactsAdapter["list"]>>>();
    const second = deferred<Awaited<ReturnType<ArtifactsAdapter["list"]>>>();
    const list = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const adapter = createArtifactsAdapter({ list });
    renderProtectedPage(
      <ArtifactsPage adapter={adapter} />,
      "/dashboard/artifacts",
      "/dashboard/artifacts",
    );

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve({ kind: "ok", items: [artifactSummary], nextCursor: null }));
    expect(await screen.findByRole("link", { name: "Open artifact Campaign master" })).toBeInTheDocument();

    await act(async () => first.resolve({ kind: "ok", items: [], nextCursor: null }));
    expect(screen.getByRole("link", { name: "Open artifact Campaign master" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No artifacts yet" })).not.toBeInTheDocument();
  });

  it("expires the owning session when a late list response returns 401", async () => {
    const user = userEvent.setup();
    const result = deferred<Awaited<ReturnType<ArtifactsAdapter["list"]>>>();
    const list = vi.fn(() => result.promise);
    const adapter = createArtifactsAdapter({ list });
    renderProtectedPage(
      <GalleryUnmountHarness adapter={adapter} />,
      "/dashboard/artifacts",
      "/dashboard/artifacts",
    );

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Remove gallery" }));
    expect(screen.getByText("Gallery removed")).toBeInTheDocument();
    await act(async () => result.resolve({ kind: "auth-expired" }));
    expect(await screen.findByRole("heading", { name: /Sign in .*reason=session-expired/i }))
      .toBeInTheDocument();
  });

  it("expires the authenticated session when the list adapter returns 401 state", async () => {
    const adapter = createArtifactsAdapter({
      list: vi.fn(async () => ({ kind: "auth-expired" as const })),
    });
    renderProtectedPage(
      <ArtifactsPage adapter={adapter} />,
      "/dashboard/artifacts",
      "/dashboard/artifacts",
    );

    expect(await screen.findByRole("heading", { name: /Sign in .*reason=session-expired/i })).toBeInTheDocument();
  });
});

describe("artifact detail and sharing", () => {
  it("renders semantic version and share tables without inventing an existing token", async () => {
    const adapter = createArtifactsAdapter();
    const { container } = renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Campaign master" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Immutable versions for Campaign master" })).toBeInTheDocument();
    expect(screen.getByRole("table", {
      name: /Share records for Campaign master.*do not expose the token value shown at creation/i,
    })).toBeInTheDocument();
    expect(screen.getByText(SHARE_ID)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(TOKEN)).not.toBeInTheDocument();
    expect(container.querySelector('a[href^="/s/"]')).toBeNull();
    expect(screen.getByText("Preview URL not provided")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("requires the available public access policy and explains the disabled membership option", async () => {
    const user = userEvent.setup();
    const createShareLink = vi.fn(async () => ({ kind: "conflict" as const }));
    const adapter = createArtifactsAdapter({ createShareLink });
    renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await screen.findByRole("heading", { level: 1, name: "Campaign master" });
    await user.click(screen.getAllByRole("button", { name: "Create share link" })[0]!);
    const accessPolicy = screen.getByLabelText("Access policy");
    expect(within(accessPolicy).getByRole("option", {
      name: "Workspace membership, not available",
    })).toBeDisabled();
    expect(screen.getByText(/recipient continuation flow that is not available yet/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Version policy"), "follow");
    await user.selectOptions(screen.getByLabelText("Expiry policy"), "never");
    await user.selectOptions(screen.getByLabelText("Resolution limit"), "unlimited");
    await user.selectOptions(screen.getByLabelText("Delivery behavior"), "inline");
    await user.click(screen.getByRole("button", { name: "Create link" }));

    expect(screen.getByText("Choose public bearer access to create this share link.")).toBeInTheDocument();
    expect(createShareLink).not.toHaveBeenCalled();
  });

  it("shows the absolute share URL and token once while serializing creation", async () => {
    const user = userEvent.setup();
    const createResult = deferred<CreateShareLinkAdapterResult>();
    const createShareLink = vi.fn(() => createResult.promise);
    const adapter = createArtifactsAdapter({ createShareLink });
    const { container } = renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await screen.findByRole("heading", { level: 1, name: "Campaign master" });
    const createTrigger = screen.getAllByRole("button", { name: "Create share link" })[0]!;
    await user.click(createTrigger);
    expect(screen.getByRole("dialog", { name: "Create share link" })).toBeInTheDocument();
    await completeSharePolicy(user);
    expect(screen.queryByRole("checkbox", { name: /Require sign-in/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create link" }));

    expect(screen.getByRole("dialog", { name: "Create share link" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Creating link" })).toBeDisabled();
    const pendingDialog = screen.getByRole("dialog");
    await waitFor(() => expect(pendingDialog).toHaveFocus());
    const pendingClose = screen.getByRole("button", { name: "Close" });
    expect(pendingClose).toHaveAttribute("aria-disabled", "true");
    await user.tab();
    expect(pendingClose).toHaveFocus();
    pendingDialog.focus();
    await user.tab({ shift: true });
    expect(pendingClose).toHaveFocus();
    for (const trigger of screen.getAllByRole("button", { name: "Create share link" })) {
      expect(trigger).toHaveAttribute("aria-disabled", "true");
    }
    expect(screen.getByRole("button", { name: `Revoke share ${SHARE_ID}` })).toBeDisabled();
    expect(createShareLink).toHaveBeenCalledTimes(1);
    await act(async () => createResult.resolve({
      kind: "created",
      shareLinkId: CREATED_SHARE_ID,
      token: TOKEN,
      publicPath: PUBLIC_PATH,
    }));

    const createdHeading = await screen.findByRole("heading", { name: "Share link created" });
    expect(createdHeading).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Clear and close" })).toHaveFocus();
    createdHeading.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Clear values and refresh" })).toHaveFocus();
    expect(createShareLink).toHaveBeenCalledWith({
      artifactId: ARTIFACT_ID,
      followCurrent: false,
      artifactVersionId: VERSION_ID,
      expiresAt: null,
      maxResolutions: null,
      requireAuth: false,
      contentDisposition: "inline",
    });
    const absoluteShareUrl = new URL(PUBLIC_PATH, window.location.origin).href;
    expect(screen.getByLabelText("Public share URL, shown once")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Public share URL, shown once")).toHaveValue(absoluteShareUrl);
    expect(screen.getByLabelText("Share token, shown once")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Share token, shown once")).toHaveValue(TOKEN);
    expect(screen.queryByText(TOKEN)).not.toBeInTheDocument();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await user.click(screen.getByRole("button", { name: "Copy share URL" }));
    expect(writeText).toHaveBeenCalledWith(absoluteShareUrl);
    if (clipboardDescriptor === undefined) Reflect.deleteProperty(navigator, "clipboard");
    else Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
    await expectNoAxeViolations(container);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(createTrigger).toHaveFocus();
    expect(adapter.get).toHaveBeenCalledTimes(2);
  });

  it("keeps revoke and create actions locked until post-create share reconciliation succeeds", async () => {
    const user = userEvent.setup();
    const refreshResult = deferred<Awaited<ReturnType<ArtifactsAdapter["get"]>>>();
    const get = vi.fn()
      .mockResolvedValueOnce({ kind: "found" as const, artifact: artifactDetail })
      .mockReturnValueOnce(refreshResult.promise);
    const createShareLink = vi.fn(async () => ({
      kind: "created" as const,
      shareLinkId: CREATED_SHARE_ID,
      token: TOKEN,
      publicPath: PUBLIC_PATH,
    }));
    const revokeShareLink = vi.fn(async () => ({ kind: "revoked" as const }));
    const adapter = createArtifactsAdapter({ get, createShareLink, revokeShareLink });
    renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await screen.findByRole("heading", { level: 1, name: "Campaign master" });
    await user.click(screen.getAllByRole("button", { name: "Create share link" })[0]!);
    await completeSharePolicy(user);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByRole("heading", { name: "Share link created" });
    await user.click(screen.getByRole("button", { name: "Clear values and refresh" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    const revokeTrigger = screen.getByRole("button", { name: `Revoke share ${SHARE_ID}` });
    expect(revokeTrigger).toBeDisabled();
    for (const trigger of screen.getAllByRole("button", { name: "Create share link" })) {
      expect(trigger).toHaveAttribute("aria-disabled", "true");
    }
    await user.click(revokeTrigger);
    expect(revokeShareLink).not.toHaveBeenCalled();

    await act(async () => refreshResult.resolve({ kind: "found", artifact: artifactDetail }));
    await waitFor(() => expect(revokeTrigger).toBeEnabled());
    for (const trigger of screen.getAllByRole("button", { name: "Create share link" })) {
      expect(trigger).not.toHaveAttribute("aria-disabled");
    }
    await user.click(revokeTrigger);
    expect(screen.getByRole("button", { name: "Confirm revoke" })).toBeInTheDocument();
  });

  it("does not let a late share-table refresh overwrite a changed artifact route", async () => {
    const user = userEvent.setup();
    const refreshResult = deferred<Awaited<ReturnType<ArtifactsAdapter["get"]>>>();
    let originalArtifactReads = 0;
    const get = vi.fn((requestedArtifactId: string) => {
      if (requestedArtifactId === OTHER_ARTIFACT_ID) {
        return Promise.resolve({ kind: "found" as const, artifact: otherArtifactDetail });
      }
      originalArtifactReads += 1;
      return originalArtifactReads === 1
        ? Promise.resolve({ kind: "found" as const, artifact: artifactDetail })
        : refreshResult.promise;
    });
    const createShareLink = vi.fn(async () => ({
      kind: "created" as const,
      shareLinkId: CREATED_SHARE_ID,
      token: TOKEN,
      publicPath: PUBLIC_PATH,
    }));
    const adapter = createArtifactsAdapter({ get, createShareLink });
    renderProtectedPage(
      <DetailRouteHarness adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await screen.findByRole("heading", { level: 1, name: "Campaign master" });
    await user.click(screen.getAllByRole("button", { name: "Create share link" })[0]!);
    await completeSharePolicy(user);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByRole("heading", { name: "Share link created" });
    await user.click(screen.getByRole("button", { name: "Clear values and refresh" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));

    await user.click(screen.getByRole("button", { name: "Switch artifact route" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Alternate artifact" })).toBeInTheDocument();
    await act(async () => refreshResult.resolve({ kind: "found", artifact: artifactDetail }));
    expect(screen.getByRole("heading", { level: 1, name: "Alternate artifact" })).toBeInTheDocument();
  });

  it("locks an unknown create outcome and refreshes records on close without resubmitting", async () => {
    const user = userEvent.setup();
    const createShareLink = vi.fn(async () => ({
      kind: "unknown_outcome" as const,
      message: "Relay could not confirm whether the share link was created. Do not retry this request. Close the panel and inspect the share records.",
    }));
    const adapter = createArtifactsAdapter({ createShareLink });
    renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await screen.findByRole("heading", { level: 1, name: "Campaign master" });
    const createTrigger = screen.getAllByRole("button", { name: "Create share link" })[0]!;
    await user.click(createTrigger);
    await completeSharePolicy(user);
    await user.click(screen.getByRole("button", { name: "Create link" }));

    expect(await screen.findByRole("heading", { name: "Creation outcome unknown" })).toBeInTheDocument();
    const unknownStatus = screen.getByRole("alert");
    expect(unknownStatus).toHaveTextContent("Do not retry this request");
    expect(unknownStatus).toHaveFocus();
    expect(screen.getByRole("button", { name: "Do not retry" })).toBeDisabled();
    expect(screen.getByLabelText("Version policy")).toBeDisabled();
    expect(createShareLink).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close and inspect shares" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(createTrigger).toHaveFocus();
    expect(createShareLink).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(adapter.get).toHaveBeenCalledTimes(2));
  });

  it("keeps creation locked after a failed inspection and unlocks only after authoritative retry", async () => {
    const user = userEvent.setup();
    const get = vi.fn()
      .mockResolvedValueOnce({ kind: "found" as const, artifact: artifactDetail })
      .mockResolvedValueOnce({
        kind: "degraded" as const,
        message: "Relay could not read the share records.",
      })
      .mockResolvedValueOnce({ kind: "found" as const, artifact: artifactDetail });
    const createShareLink = vi.fn(async () => ({
      kind: "unknown_outcome" as const,
      message: "Relay could not confirm whether the share link was created. Do not retry this request. Close the panel and inspect the share records.",
    }));
    const adapter = createArtifactsAdapter({ get, createShareLink });
    renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await screen.findByRole("heading", { level: 1, name: "Campaign master" });
    await user.click(screen.getAllByRole("button", { name: "Create share link" })[0]!);
    await completeSharePolicy(user);
    await user.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByRole("heading", { name: "Creation outcome unknown" });
    await user.click(screen.getByRole("button", { name: "Close and inspect shares" }));

    expect(await screen.findByText(/Do not retry creation/i)).toBeInTheDocument();
    const retryInspection = screen.getByRole("button", { name: "Inspect share records again" });
    expect(retryInspection).toBeEnabled();
    expect(screen.getByRole("button", { name: `Revoke share ${SHARE_ID}` })).toBeDisabled();
    for (const trigger of screen.getAllByRole("button", { name: "Create share link" })) {
      expect(trigger).toHaveAttribute("aria-disabled", "true");
    }

    await user.click(retryInspection);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByText(/Do not retry creation/i)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: `Revoke share ${SHARE_ID}` })).toBeEnabled();
    for (const trigger of screen.getAllByRole("button", { name: "Create share link" })) {
      expect(trigger).not.toHaveAttribute("aria-disabled");
    }
  });

  it("restores revoke focus on cancel and focuses pending and success status", async () => {
    const user = userEvent.setup();
    let resolveRevoke!: (result: RevokeShareLinkAdapterResult) => void;
    const revokePromise = new Promise<RevokeShareLinkAdapterResult>((resolve) => {
      resolveRevoke = resolve;
    });
    const revokeShareLink = vi.fn(() => revokePromise);
    const adapter = createArtifactsAdapter({ revokeShareLink });
    renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await screen.findByRole("heading", { level: 1, name: "Campaign master" });
    const revokeTrigger = screen.getByRole("button", { name: `Revoke share ${SHARE_ID}` });
    await user.click(revokeTrigger);
    const confirmButton = screen.getByRole("button", { name: "Confirm revoke" });
    expect(confirmButton).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Keep share" }));
    await waitFor(() => expect(revokeTrigger).toHaveFocus());
    expect(revokeShareLink).not.toHaveBeenCalled();

    await user.click(revokeTrigger);
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    const pendingCopy = screen.getByText("Revoking share link. Relay will send this request once.");
    const pendingStatus = pendingCopy.closest<HTMLElement>("[role='status']");
    expect(pendingStatus).not.toBeNull();
    expect(pendingStatus).toHaveFocus();
    for (const trigger of screen.getAllByRole("button", { name: "Create share link" })) {
      expect(trigger).toHaveAttribute("aria-disabled", "true");
    }
    expect(revokeShareLink).toHaveBeenCalledTimes(1);
    expect(revokeShareLink).toHaveBeenCalledWith(ARTIFACT_ID, SHARE_ID);

    await act(async () => resolveRevoke({ kind: "revoked" }));
    const successCopy = await screen.findByText("Share link revoked. Future Relay resolutions are blocked.");
    const successStatus = successCopy.closest<HTMLElement>("[role='status']");
    expect(successStatus).not.toBeNull();
    expect(successStatus).toHaveFocus();
    expect(screen.getByText("Revoked")).toBeInTheDocument();
    expect(revokeShareLink).toHaveBeenCalledTimes(1);
    const revokedRow = screen.getByRole("rowheader", { name: SHARE_ID });
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(revokedRow).toHaveFocus());
  });

  it("keeps the newest artifact when a previous route request resolves late", async () => {
    const user = userEvent.setup();
    const first = deferred<Awaited<ReturnType<ArtifactsAdapter["get"]>>>();
    const second = deferred<Awaited<ReturnType<ArtifactsAdapter["get"]>>>();
    const get = vi.fn((requestedArtifactId: string) => requestedArtifactId === ARTIFACT_ID
      ? first.promise
      : second.promise);
    const adapter = createArtifactsAdapter({ get });
    renderProtectedPage(
      <DetailRouteHarness adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Switch artifact route" }));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve({ kind: "found", artifact: otherArtifactDetail }));
    expect(await screen.findByRole("heading", { level: 1, name: "Alternate artifact" })).toBeInTheDocument();

    await act(async () => first.resolve({ kind: "found", artifact: artifactDetail }));
    expect(screen.getByRole("heading", { level: 1, name: "Alternate artifact" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1, name: "Campaign master" })).not.toBeInTheDocument();
  });

  it("ignores a revoke completion after the artifact route changes", async () => {
    const user = userEvent.setup();
    const revokeResult = deferred<RevokeShareLinkAdapterResult>();
    const revokeShareLink = vi.fn(() => revokeResult.promise);
    const get = vi.fn(async (requestedArtifactId: string) => requestedArtifactId === ARTIFACT_ID
      ? { kind: "found" as const, artifact: artifactDetail }
      : { kind: "found" as const, artifact: otherArtifactDetail });
    const adapter = createArtifactsAdapter({ get, revokeShareLink });
    renderProtectedPage(
      <DetailRouteHarness adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await screen.findByRole("heading", { level: 1, name: "Campaign master" });
    await user.click(screen.getByRole("button", { name: `Revoke share ${SHARE_ID}` }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await user.click(screen.getByRole("button", { name: "Switch artifact route" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Alternate artifact" })).toBeInTheDocument();

    await act(async () => revokeResult.resolve({ kind: "revoked" }));
    expect(screen.getByRole("heading", { level: 1, name: "Alternate artifact" })).toBeInTheDocument();
    expect(screen.queryByText("Share link revoked. Future Relay resolutions are blocked.")).not.toBeInTheDocument();
  });

  it("focuses a revoke error and returns focus when it is dismissed", async () => {
    const user = userEvent.setup();
    const revokeShareLink = vi.fn(async () => ({
      kind: "degraded" as const,
      message: "Relay could not reach the share service. The operation was not repeated.",
    }));
    const adapter = createArtifactsAdapter({ revokeShareLink });
    renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    await screen.findByRole("heading", { level: 1, name: "Campaign master" });
    const revokeTrigger = screen.getByRole("button", { name: `Revoke share ${SHARE_ID}` });
    await user.click(revokeTrigger);
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));

    const errorCopy = await screen.findByText("Relay could not reach the share service. The operation was not repeated.");
    const errorStatus = errorCopy.closest<HTMLElement>("[role='alert']");
    expect(errorStatus).not.toBeNull();
    expect(errorStatus).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(revokeTrigger).toHaveFocus());
  });

  it("renders invalid route identifiers as not found without calling the adapter", async () => {
    const adapter = createArtifactsAdapter();
    renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      "/dashboard/artifacts/not-an-artifact",
      "/dashboard/artifacts/:artifactId",
    );

    expect(await screen.findByRole("heading", { name: "Artifact not found" })).toBeInTheDocument();
    expect(adapter.get).not.toHaveBeenCalled();
  });

  it("surfaces degraded detail responses with an explicit manual retry", async () => {
    const adapter = createArtifactsAdapter({
      get: vi.fn(async () => ({
        kind: "degraded" as const,
        message: "Relay returned an unreadable artifact record. No artifact details were shown.",
      })),
    });
    renderProtectedPage(
      <ArtifactDetailPage adapter={adapter} />,
      `/dashboard/artifacts/${ARTIFACT_ID}`,
      "/dashboard/artifacts/:artifactId",
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("Artifact unavailable");
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(adapter.get).toHaveBeenCalledTimes(1);
  });
});
