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
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider, useAuth } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { AuthAdapter, RelayIdentity, RelayWorkspace } from "../../src/auth/types";
import {
  AdminAccessLink,
  AdminChangelogEditorPage,
  AdminChangelogListPage,
  AdminChangelogPreviewPage,
  AdminChangelogRouteBoundary,
  AdminLayout,
} from "../../src/features/admin-changelog";
import type {
  AdminChangelogAdapter,
  AdminChangelogDraftInput,
  AdminChangelogReleaseDetail,
  AdminChangelogReleaseSnapshot,
  AdminChangelogSummary,
} from "../../src/lib/api/admin-changelog";

const RELEASE_ID = "42";
const NOW = "2026-08-25T10:00:00.000Z";
const LATER = "2026-08-25T11:00:00.000Z";
const SHA = "a".repeat(40);

const identity: RelayIdentity = {
  session: {
    id: "session-admin-one",
    userId: "user-admin",
    expiresAt: new Date("2031-01-01T00:00:00.000Z"),
    activeWorkspaceId: "workspace-admin",
  },
  user: {
    id: "user-admin",
    name: "Morgan Lee",
    email: "morgan@example.test",
    image: null,
  },
};

const secondIdentity: RelayIdentity = {
  ...identity,
  session: { ...identity.session, id: "session-admin-two" },
};

const workspace: RelayWorkspace = {
  id: "workspace-admin",
  name: "Admin test workspace",
  slug: "admin-test",
};

const draftInput: AdminChangelogDraftInput = {
  version: "1.2.3",
  slug: "release-1-2-3",
  title: "Relay 1.2.3",
  summary: "A stored release snapshot.",
  gitTag: "v1.2.3",
  commitSha: SHA,
  releasedAt: NOW,
  items: [{
    category: "added",
    area: "Control plane",
    title: "Admin changelog editor",
    description: "Superadmins can store and publish release notes.",
    sortOrder: 0,
  }],
};

const snapshot: AdminChangelogReleaseSnapshot = {
  ...draftInput,
  contentSha256: "b".repeat(64),
};

const publishedSnapshot: AdminChangelogReleaseSnapshot = {
  ...snapshot,
  title: "Relay 1.2.3 published",
  contentSha256: "c".repeat(64),
};

const summary: AdminChangelogSummary = {
  releaseId: RELEASE_ID,
  version: draftInput.version,
  slug: draftInput.slug,
  status: "draft",
  latestRevision: 1,
  publishedRevision: null,
  hasUnpublishedChanges: true,
  updatedAt: NOW,
};

const draftDetail: AdminChangelogReleaseDetail = {
  releaseId: RELEASE_ID,
  status: "draft",
  latestRevision: 1,
  publishedRevision: null,
  hasUnpublishedChanges: true,
  firstPublishedAt: null,
  lastPublishedAt: null,
  latest: snapshot,
  published: null,
};

const publishedDetail: AdminChangelogReleaseDetail = {
  releaseId: RELEASE_ID,
  status: "published",
  latestRevision: 1,
  publishedRevision: 1,
  hasUnpublishedChanges: false,
  firstPublishedAt: NOW,
  lastPublishedAt: NOW,
  latest: snapshot,
  published: snapshot,
};

const archivedDetail: AdminChangelogReleaseDetail = {
  ...publishedDetail,
  status: "archived",
};

const differingDetail: AdminChangelogReleaseDetail = {
  ...publishedDetail,
  latestRevision: 2,
  publishedRevision: 1,
  hasUnpublishedChanges: true,
  latest: publishedSnapshot,
};

const missingPublishFieldsDetail: AdminChangelogReleaseDetail = {
  ...draftDetail,
  latest: {
    ...snapshot,
    gitTag: null,
    commitSha: null,
    releasedAt: null,
    items: [],
    contentSha256: "d".repeat(64),
  },
};

const securityDetail: AdminChangelogReleaseDetail = {
  ...draftDetail,
  latest: {
    ...snapshot,
    items: [{ ...snapshot.items[0]!, category: "security" }],
    contentSha256: "f".repeat(64),
  },
};

function createAdminAdapter(
  overrides: Partial<AdminChangelogAdapter> = {},
): AdminChangelogAdapter {
  return {
    list: vi.fn(async () => ({ kind: "ok", releases: [summary] })),
    get: vi.fn(async () => ({ kind: "found", release: draftDetail })),
    create: vi.fn(async () => ({
      kind: "created",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
    })),
    revise: vi.fn(async () => ({
      kind: "revised",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 2,
    })),
    publish: vi.fn(async () => ({
      kind: "published",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
      supersededRevision: null,
    })),
    unpublish: vi.fn(async () => ({
      kind: "unpublished",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
    })),
    ...overrides,
  };
}

function deferred<Result>() {
  let resolve!: (value: Result) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Result>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function SignInProbe() {
  const location = useLocation();
  return <h1>Sign in {location.search}</h1>;
}

function AdminRoutes({ adapter }: { readonly adapter: AdminChangelogAdapter }) {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignInProbe />} />
      <Route path="/dashboard" element={<h1>Workspace</h1>} />
      <Route element={<ProtectedRoute />}>
        <Route element={<AdminChangelogRouteBoundary adapter={adapter} />}>
          <Route element={<AdminLayout />}>
            <Route path="/admin/changelog" element={<AdminChangelogListPage />} />
            <Route path="/admin/changelog/new" element={<AdminChangelogEditorPage createNew />} />
            <Route path="/admin/changelog/:releaseId" element={<AdminChangelogEditorPage />} />
            <Route path="/admin/changelog/:releaseId/preview" element={<AdminChangelogPreviewPage />} />
          </Route>
        </Route>
      </Route>
    </Routes>
  );
}

function renderAdmin(
  entry: string,
  adapter: AdminChangelogAdapter,
  authAdapter: AuthAdapter = createTestAuthAdapter({ identity, activeWorkspace: workspace }),
) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <AuthProvider adapter={authAdapter}>
        <AdminRoutes adapter={adapter} />
      </AuthProvider>
    </MemoryRouter>,
  );
}

function renderBoundaryOnly(
  adapter: AdminChangelogAdapter,
  authAdapter: AuthAdapter = createTestAuthAdapter({ identity, activeWorkspace: workspace }),
) {
  return render(
    <MemoryRouter initialEntries={["/admin"]}>
      <AuthProvider adapter={authAdapter}>
        <Routes>
          <Route path="/sign-in" element={<SignInProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<AdminChangelogRouteBoundary adapter={adapter} />}>
              <Route path="/admin" element={<h1>Allowed admin content</h1>} />
            </Route>
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

async function fillMinimalDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: /^Version/ }), "1.2.3");
  await user.type(screen.getByRole("textbox", { name: /^Slug/ }), "release-1-2-3");
  await user.type(screen.getByRole("textbox", { name: /^Title/ }), "Relay 1.2.3");
}

function summaries(count: number): readonly AdminChangelogSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    releaseId: String(100 - index),
    version: `1.0.${100 - index}`,
    slug: `release-1-0-${100 - index}`,
    status: "draft" as const,
    latestRevision: 1,
    publishedRevision: null,
    hasUnpublishedChanges: true,
    updatedAt: NOW,
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin changelog access boundary", () => {
  it("shows a loading boundary and then provides the confirmed adapter to descendants", async () => {
    const probe = deferred<Awaited<ReturnType<AdminChangelogAdapter["list"]>>>();
    const list = vi.fn(() => probe.promise);
    const adapter = createAdminAdapter({ list });
    renderBoundaryOnly(adapter);

    expect(await screen.findByRole("heading", { name: "Checking admin access" })).toBeInTheDocument();
    expect(screen.queryByText("Allowed admin content")).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledWith({ limit: 1 }, expect.any(AbortSignal));

    await act(async () => probe.resolve({ kind: "ok", releases: [] }));
    expect(await screen.findByRole("heading", { name: "Allowed admin content" })).toBeInTheDocument();
  });

  it.each([
    ["denied", "Admin access unavailable"],
    ["reauthentication-required", "Reauthentication required"],
  ] as const)("renders the %s access state without admin content", async (kind, heading) => {
    const adapter = createAdminAdapter({ list: vi.fn(async () => ({ kind })) });
    renderBoundaryOnly(adapter);

    expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    expect(screen.queryByText("Allowed admin content")).not.toBeInTheDocument();
  });

  it("restarts authentication from a stale admin session", async () => {
    const signOut = vi.fn(async () => undefined);
    const authAdapter: AuthAdapter = {
      ...createTestAuthAdapter({ identity, activeWorkspace: workspace }),
      signOut,
    };
    const adapter = createAdminAdapter({
      list: vi.fn(async () => ({ kind: "reauthentication-required" as const })),
    });
    const user = userEvent.setup();
    renderBoundaryOnly(adapter, authAdapter);

    expect(await screen.findByRole("heading", { name: "Reauthentication required" }))
      .toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out and continue" }));

    expect(signOut).toHaveBeenCalledOnce();
    expect(await screen.findByRole("heading", {
      name: /Sign in .*returnTo=%2Fadmin&reason=session-expired/i,
    })).toBeInTheDocument();
  });

  it("renders degraded access with an explicit retry and never retries automatically", async () => {
    const list = vi.fn()
      .mockResolvedValueOnce({ kind: "degraded" as const, message: "Admin API unavailable." })
      .mockResolvedValueOnce({ kind: "ok" as const, releases: [] });
    const adapter = createAdminAdapter({ list });
    const user = userEvent.setup();
    renderBoundaryOnly(adapter);

    expect(await screen.findByRole("heading", { name: "Admin access check unavailable" })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Allowed admin content" })).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("expires the current owning session on an access probe 401", async () => {
    const adapter = createAdminAdapter({ list: vi.fn(async () => ({ kind: "auth-expired" as const })) });
    renderBoundaryOnly(adapter);

    expect(await screen.findByRole("heading", { name: /Sign in .*reason=session-expired/i })).toBeInTheDocument();
  });

  it("does not let a late 401 from an old Better Auth session expire the replacement session", async () => {
    const oldProbe = deferred<Awaited<ReturnType<AdminChangelogAdapter["list"]>>>();
    const list = vi.fn()
      .mockReturnValueOnce(oldProbe.promise)
      .mockResolvedValueOnce({ kind: "ok" as const, releases: [] });
    const adapter = createAdminAdapter({ list });
    let currentIdentity = identity;
    const baseAuth = createTestAuthAdapter({ identity, activeWorkspace: workspace });
    const authAdapter: AuthAdapter = {
      ...baseAuth,
      getSession: vi.fn(async () => currentIdentity),
    };

    function SessionSwitch() {
      const { refreshSession } = useAuth();
      return (
        <button
          type="button"
          onClick={() => {
            currentIdentity = secondIdentity;
            void refreshSession();
          }}
        >
          Replace session
        </button>
      );
    }

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <AuthProvider adapter={authAdapter}>
          <SessionSwitch />
          <Routes>
            <Route path="/sign-in" element={<SignInProbe />} />
            <Route element={<ProtectedRoute />}>
              <Route element={<AdminChangelogRouteBoundary adapter={adapter} />}>
                <Route path="/admin" element={<h1>Replacement session content</h1>} />
              </Route>
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Replace session" }));
    expect(await screen.findByRole("heading", { name: "Replacement session content" })).toBeInTheDocument();
    await act(async () => oldProbe.resolve({ kind: "auth-expired" }));
    expect(screen.getByRole("heading", { name: "Replacement session content" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Sign in/i })).not.toBeInTheDocument();
  });

  it("renders the quiet product link only after access is confirmed", async () => {
    const probe = deferred<Awaited<ReturnType<AdminChangelogAdapter["list"]>>>();
    const adapter = createAdminAdapter({ list: vi.fn(() => probe.promise) });
    render(
      <MemoryRouter>
        <AuthProvider adapter={createTestAuthAdapter({ identity, activeWorkspace: workspace })}>
          <AdminAccessLink adapter={adapter} />
        </AuthProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(adapter.list).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("link", { name: "Admin changelog" })).not.toBeInTheDocument();
    await act(async () => probe.resolve({ kind: "ok", releases: [] }));
    expect(await screen.findByRole("link", { name: "Admin changelog" })).toHaveAttribute("href", "/admin/changelog");
  });
});

describe("admin changelog release list", () => {
  it("renders a semantic summary ledger and safely tolerates an empty final keyset page", async () => {
    const firstPage = deferred<Awaited<ReturnType<AdminChangelogAdapter["list"]>>>();
    const nextPage = deferred<Awaited<ReturnType<AdminChangelogAdapter["list"]>>>();
    const first = summaries(20);
    const list = vi.fn((request?: { readonly limit?: number; readonly beforeReleaseId?: string | null }) => {
      if (request?.limit === 1) return Promise.resolve({ kind: "ok" as const, releases: [] });
      if (request?.beforeReleaseId !== undefined) return nextPage.promise;
      return firstPage.promise;
    });
    const adapter = createAdminAdapter({ list });
    const user = userEvent.setup();
    const { container } = renderAdmin("/admin/changelog", adapter);

    expect(await screen.findByText("Loading changelog releases")).toBeInTheDocument();
    await act(async () => firstPage.resolve({ kind: "ok", releases: first }));
    const table = await screen.findByRole("table", { name: "Admin changelog releases, newest first" });
    expect(within(table).getAllByRole("row")).toHaveLength(21);
    expect(within(table).getByRole("columnheader", { name: "Published revision" })).toBeInTheDocument();
    expect(screen.getByText("1.0.100")).toBeInTheDocument();
    expect(screen.queryByText(/item|tag|commit/i)).not.toBeInTheDocument();
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(screen.getByRole("button", { name: "Loading releases..." })).toBeDisabled();
    expect(list).toHaveBeenLastCalledWith(
      { limit: 20, beforeReleaseId: "81" },
      expect.any(AbortSignal),
    );
    await act(async () => nextPage.resolve({ kind: "ok", releases: [] }));
    expect(screen.getByText("1.0.100")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("keeps existing rows across a pagination error and retries only on request", async () => {
    const first = summaries(20);
    const nextPage = deferred<Awaited<ReturnType<AdminChangelogAdapter["list"]>>>();
    let paginationAttempt = 0;
    const list = vi.fn((request?: { readonly limit?: number; readonly beforeReleaseId?: string | null }) => {
      if (request?.limit === 1) return Promise.resolve({ kind: "ok" as const, releases: [] });
      if (request?.beforeReleaseId === undefined) return Promise.resolve({ kind: "ok" as const, releases: first });
      paginationAttempt += 1;
      return paginationAttempt === 1
        ? nextPage.promise
        : Promise.resolve({ kind: "ok" as const, releases: [] });
    });
    const adapter = createAdminAdapter({ list });
    const user = userEvent.setup();
    renderAdmin("/admin/changelog", adapter);

    await screen.findByText("1.0.100");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => nextPage.resolve({ kind: "degraded", message: "Next page unavailable." }));
    expect(await screen.findByText("Next page unavailable.")).toBeInTheDocument();
    expect(screen.getByText("1.0.100")).toBeInTheDocument();
    expect(paginationAttempt).toBe(1);

    await user.click(screen.getByRole("button", { name: "Try next page again" }));
    await waitFor(() => expect(paginationAttempt).toBe(2));
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
  });

  it("distinguishes empty, degraded, and access-loss states", async () => {
    const emptyAdapter = createAdminAdapter({ list: vi.fn(async () => ({ kind: "ok" as const, releases: [] })) });
    const firstRender = renderAdmin("/admin/changelog", emptyAdapter);
    expect(await screen.findByRole("heading", { name: "No changelog releases yet" })).toBeInTheDocument();
    firstRender.unmount();

    const degradedAdapter = createAdminAdapter({
      list: vi.fn(async (request) => request?.limit === 1
        ? { kind: "ok" as const, releases: [] }
        : { kind: "degraded" as const, message: "Release ledger unavailable." }),
    });
    const secondRender = renderAdmin("/admin/changelog", degradedAdapter);
    expect(await screen.findByText("Release ledger unavailable.")).toBeInTheDocument();
    secondRender.unmount();

    const deniedAdapter = createAdminAdapter({
      list: vi.fn(async (request) => request?.limit === 1
        ? { kind: "ok" as const, releases: [] }
        : { kind: "denied" as const }),
    });
    renderAdmin("/admin/changelog", deniedAdapter);
    expect(await screen.findByRole("heading", { name: "Admin access unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("admin changelog editor", () => {
  it("validates the strict full snapshot before create and derives item order", async () => {
    const create = vi.fn<AdminChangelogAdapter["create"]>(async () => ({
      kind: "created",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
    }));
    const adapter = createAdminAdapter({ create });
    const user = userEvent.setup();
    renderAdmin("/admin/changelog/new", adapter);
    await screen.findByRole("heading", { name: "New changelog draft" });

    await user.click(screen.getByRole("button", { name: "Add item" }));
    await user.type(screen.getByRole("textbox", { name: /^Version/ }), "1.2");
    await user.type(screen.getByRole("textbox", { name: /^Slug/ }), "Invalid slug");
    await user.type(screen.getByRole("textbox", { name: /^Title/ }), "   ");
    await user.type(screen.getByRole("textbox", { name: /^Commit SHA/ }), "A".repeat(40));
    await user.type(screen.getByRole("textbox", { name: /^Release timestamp/ }), "2026-08-25T10:00:00Z");
    await user.click(screen.getByRole("button", { name: "Create draft" }));

    expect(screen.getByText("Use lowercase letters, numbers, and internal hyphens only.")).toBeInTheDocument();
    expect(screen.getByText("Title is required.")).toBeInTheDocument();
    expect(screen.getByText("Enter a full 40 or 64 character lowercase Git SHA.")).toBeInTheDocument();
    expect(screen.getByText(/exact UTC timestamp/i)).toBeInTheDocument();
    expect(screen.getByText("Item title is required.")).toBeInTheDocument();
    expect(screen.getByText("Item description is required.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  }, 10_000);

  it("renders published identity as locked values and keeps a populated editor axe-clean", async () => {
    const adapter = createAdminAdapter({ get: vi.fn(async () => ({ kind: "found", release: publishedDetail })) });
    const { container } = renderAdmin(`/admin/changelog/${RELEASE_ID}`, adapter);

    expect(await screen.findByRole("heading", { name: "Edit 1.2.3" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^Version/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^Slug/ })).not.toBeInTheDocument();
    expect(screen.getByText(/locked because this release has been published before/i)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Title/ })).toHaveValue("Relay 1.2.3");
    expect(screen.getByText("Sort order 0")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });

  it("keeps a create uniqueness conflict editable", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000010")
      .mockReturnValueOnce("00000000-0000-4000-8000-000000000011");
    const create = vi.fn<AdminChangelogAdapter["create"]>()
      .mockResolvedValueOnce({ kind: "version-conflict" })
      .mockResolvedValueOnce({
        kind: "created",
        replayed: false,
        releaseId: RELEASE_ID,
        revision: 1,
      });
    const adapter = createAdminAdapter({ create });
    const user = userEvent.setup();
    renderAdmin("/admin/changelog/new", adapter);
    await screen.findByRole("heading", { name: "New changelog draft" });
    await fillMinimalDraft(user);

    await user.click(screen.getByRole("button", { name: "Create draft" }));
    const version = screen.getByRole("textbox", { name: /^Version/ });
    expect(await screen.findByText("Another release already uses this version."))
      .toBeInTheDocument();
    expect(version).toBeEnabled();
    await waitFor(() => expect(version).toHaveFocus());

    await user.clear(version);
    await user.type(version, "1.2.4");
    await user.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByRole("heading", { name: "Edit 1.2.3" }))
      .toBeInTheDocument();
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]?.[1]).not.toBe(create.mock.calls[1]?.[1]);
  });

  it("retries an unknown create with the exact payload and idempotency key", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    const create = vi.fn<AdminChangelogAdapter["create"]>()
      .mockResolvedValueOnce({ kind: "unknown-outcome", message: "Creation result could not be confirmed." })
      .mockResolvedValueOnce({
        kind: "created",
        replayed: true,
        releaseId: RELEASE_ID,
        revision: 1,
      });
    const adapter = createAdminAdapter({ create });
    const user = userEvent.setup();
    renderAdmin("/admin/changelog/new", adapter);
    await screen.findByRole("heading", { name: "New changelog draft" });
    await fillMinimalDraft(user);
    await user.click(screen.getByRole("button", { name: "Create draft" }));

    expect(await screen.findByRole("heading", { name: "Editing is frozen" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Title/ })).toBeDisabled();
    expect(create).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Retry exact request" }));
    expect(await screen.findByRole("heading", { name: "Edit 1.2.3" })).toBeInTheDocument();

    expect(create).toHaveBeenCalledTimes(2);
    const firstCall = create.mock.calls[0];
    const secondCall = create.mock.calls[1];
    expect(secondCall?.[0]).toBe(firstCall?.[0]);
    expect(secondCall?.[1]).toBe(firstCall?.[1]);
    expect(firstCall?.[1]).toBe("admin-changelog:create:00000000-0000-4000-8000-000000000001");
    expect(firstCall?.[0]).toMatchObject({
      version: "1.2.3",
      slug: "release-1-2-3",
      title: "Relay 1.2.3",
      summary: null,
      gitTag: null,
      commitSha: null,
      releasedAt: null,
      items: [],
    });
  });

  it("preserves local edits on revision conflict until authoritative reload is requested", async () => {
    const authoritative = {
      ...draftDetail,
      latestRevision: 2,
      latest: { ...snapshot, title: "Authoritative title", contentSha256: "e".repeat(64) },
    };
    const get = vi.fn<AdminChangelogAdapter["get"]>()
      .mockResolvedValueOnce({ kind: "found", release: draftDetail })
      .mockResolvedValueOnce({ kind: "found", release: authoritative });
    const revise = vi.fn<AdminChangelogAdapter["revise"]>(async () => ({
      kind: "revision-conflict",
      actualRevision: 2,
    }));
    const adapter = createAdminAdapter({ get, revise });
    const user = userEvent.setup();
    renderAdmin(`/admin/changelog/${RELEASE_ID}`, adapter);

    const title = await screen.findByRole("textbox", { name: /^Title/ });
    await user.clear(title);
    await user.type(title, "My local title");
    await user.click(screen.getByRole("button", { name: "Save revision" }));

    expect(await screen.findByRole("heading", { name: "Release changed" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Title/ })).toHaveValue("My local title");
    expect(screen.getByRole("textbox", { name: /^Title/ })).toBeDisabled();
    expect(get).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Reload authoritative release" }));
    expect(await screen.findByRole("textbox", { name: /^Title/ })).toHaveValue("Authoritative title");
    expect(get).toHaveBeenCalledTimes(2);
  });
});

describe("publish and unpublish controls", () => {
  it("shows only real publish blockers and returns focus when Escape closes the dialog", async () => {
    const adapter = createAdminAdapter({
      get: vi.fn(async () => ({ kind: "found", release: missingPublishFieldsDetail })),
    });
    const user = userEvent.setup();
    const { container } = renderAdmin(`/admin/changelog/${RELEASE_ID}`, adapter);
    const trigger = await screen.findByRole("button", { name: "Publish" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Publish 1.2.3 to the public changelog?" });
    expect(within(dialog).getByText("Git tag is present")).toBeInTheDocument();
    expect(within(dialog).getByText("Commit SHA is full and lowercase")).toBeInTheDocument();
    expect(within(dialog).getByText("Release timestamp is present")).toBeInTheDocument();
    expect(within(dialog).getByText("At least one release item is present")).toBeInTheDocument();
    expect(within(dialog).queryByText(/security|sign-off|audit|provider/i)).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Publish 1.2.3" })).toBeDisabled();
    await expectNoAxeViolations(container);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("requires an explicit non-persisted acknowledgement for security disclosure", async () => {
    const adapter = createAdminAdapter({
      get: vi.fn(async () => ({ kind: "found", release: securityDetail })),
    });
    const user = userEvent.setup();
    renderAdmin(`/admin/changelog/${RELEASE_ID}`, adapter);

    await screen.findByRole("heading", { name: "Edit 1.2.3" });
    await user.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Publish 1.2.3" });
    const acknowledgement = within(dialog).getByRole("checkbox", {
      name: /Confirm public disclosure/i,
    });
    expect(confirm).toBeDisabled();
    expect(dialog).toHaveTextContent("not stored as a separate approval record");

    await user.click(acknowledgement);
    expect(confirm).toBeEnabled();
  });

  it("traps focus, blocks dismissal while pending, and refetches after known publication", async () => {
    const publishResult = deferred<Awaited<ReturnType<AdminChangelogAdapter["publish"]>>>();
    const get = vi.fn<AdminChangelogAdapter["get"]>()
      .mockResolvedValueOnce({ kind: "found", release: draftDetail })
      .mockResolvedValueOnce({ kind: "found", release: publishedDetail });
    const publish = vi.fn<AdminChangelogAdapter["publish"]>(() => publishResult.promise);
    const adapter = createAdminAdapter({ get, publish });
    const user = userEvent.setup();
    const { container } = renderAdmin(`/admin/changelog/${RELEASE_ID}`, adapter);
    const trigger = await screen.findByRole("button", { name: "Publish" });
    await user.click(trigger);

    const dialog = await screen.findByRole("dialog");
    const dialogHeading = within(dialog).getByRole("heading", {
      name: "Publish 1.2.3 to the public changelog?",
    });
    await waitFor(() => expect(dialogHeading).toHaveFocus());
    await user.tab();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    dialog.focus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole("button", { name: "Publish 1.2.3" })).toHaveFocus();
    await expectNoAxeViolations(container);

    await user.click(within(dialog).getByRole("button", { name: "Publish 1.2.3" }));
    expect(within(dialog).getByRole("button", { name: "Publishing..." })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => publishResult.resolve({
      kind: "published",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
      supersededRevision: null,
    }));

    const successNotice = (await screen.findByText("Revision 1 published."))
      .closest(".admin-action-notice");
    expect(get).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(successNotice).toHaveFocus();
  });

  it("unpublishes only a published release and reloads its archived state", async () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000002");
    const get = vi.fn<AdminChangelogAdapter["get"]>()
      .mockResolvedValueOnce({ kind: "found", release: publishedDetail })
      .mockResolvedValueOnce({ kind: "found", release: archivedDetail });
    const unpublish = vi.fn<AdminChangelogAdapter["unpublish"]>(async () => ({
      kind: "unpublished",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
    }));
    const adapter = createAdminAdapter({ get, unpublish });
    const user = userEvent.setup();
    renderAdmin(`/admin/changelog/${RELEASE_ID}`, adapter);

    await screen.findByRole("heading", { name: "Edit 1.2.3" });
    await user.click(screen.getByRole("button", { name: "Unpublish" }));
    const dialog = screen.getByRole("dialog", { name: "Unpublish 1.2.3?" });
    expect(dialog).toHaveTextContent("Stored release history remains archived in admin.");
    expect(dialog).not.toHaveTextContent(/delete/i);
    await user.click(within(dialog).getByRole("button", { name: "Unpublish 1.2.3" }));

    expect(await screen.findByText("Revision 1 unpublished. Stored release history remains archived.")).toBeInTheDocument();
    expect(unpublish).toHaveBeenCalledWith(
      RELEASE_ID,
      { expectedPublishedRevision: 1 },
      "admin-changelog:unpublish:00000000-0000-4000-8000-000000000002",
      expect.any(AbortSignal),
    );
    expect(screen.getByText("Archived")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unpublish" })).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Revision 1 unpublished. Stored release history remains archived.",
      ).closest(".admin-action-notice"),
    ).toHaveFocus();
  });
});

describe("stored revision preview", () => {
  it("focuses a stable success notice when publication removes its trigger", async () => {
    const get = vi.fn<AdminChangelogAdapter["get"]>()
      .mockResolvedValueOnce({ kind: "found", release: draftDetail })
      .mockResolvedValueOnce({ kind: "found", release: publishedDetail });
    const publish = vi.fn<AdminChangelogAdapter["publish"]>(async () => ({
      kind: "published",
      replayed: false,
      releaseId: RELEASE_ID,
      revision: 1,
      supersededRevision: null,
    }));
    const adapter = createAdminAdapter({ get, publish });
    const user = userEvent.setup();
    renderAdmin(`/admin/changelog/${RELEASE_ID}/preview`, adapter);

    await screen.findByRole("heading", { level: 1, name: "1.2.3" });
    await user.click(screen.getByRole("button", { name: "Publish" }));
    await user.click(screen.getByRole("button", { name: "Publish 1.2.3" }));

    const notice = (await screen.findByText("Revision 1 published."))
      .closest(".admin-action-notice");
    expect(notice).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
  });

  it.each([
    [draftDetail, "Not published"],
    [differingDetail, "Published revision differs"],
  ] as const)("labels preview state as %s without implying the preview is public", async (release, expectedLabel) => {
    const adapter = createAdminAdapter({ get: vi.fn(async () => ({ kind: "found", release })) });
    const { container } = renderAdmin(`/admin/changelog/${RELEASE_ID}/preview`, adapter);

    expect(await screen.findByText(expectedLabel)).toBeInTheDocument();
    expect(screen.getByText(/This preview is not a public page/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: release.latest.version })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: release.latest.title })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to editor" })).toHaveAttribute("href", `/admin/changelog/${RELEASE_ID}`);
    expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    await expectNoAxeViolations(container);
  });
});
