import axe from "axe-core";
import { act, render, screen, within } from "@testing-library/react";
import {
  createMemoryRouter,
  MemoryRouter,
  Route,
  RouterProvider,
  Routes,
} from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangelogEntryPage } from "../../src/features/changelog/ChangelogEntryPage";
import { ChangelogPage } from "../../src/features/changelog/ChangelogPage";
import {
  type ChangelogAdapter,
  type ChangelogEntryLoadResult,
  type ChangelogLoadResult,
  type ChangelogRelease,
  parseChangelogRelease,
} from "../../src/lib/api/changelog";

const releaseFixture: ChangelogRelease = {
  version: "1.2.3-test",
  slug: "fixture-release",
  title: "Fixture release title",
  summary: "Fixture summary supplied only by the test adapter.",
  gitTag: "v1.2.3-test",
  commitSha: "a".repeat(40),
  releasedAt: "2026-08-24T12:00:00.000Z",
  items: [
    {
      category: "added",
      area: "Test surface",
      title: "Fixture release item",
      description: "Fixture detail supplied only by the test adapter.",
      sortOrder: 0,
    },
    {
      category: "security",
      area: null,
      title: "Fixture security item",
      description: "A second test-only item proves category grouping.",
      sortOrder: 1,
    },
  ],
  contentSha256: "b".repeat(64),
  revision: 1,
  publishedAt: "2026-08-24T12:05:00.000Z",
};

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function adapterReturning(
  result: ChangelogLoadResult,
  entryResult: ChangelogEntryLoadResult = { kind: "not-found" },
): ChangelogAdapter {
  return {
    load: () => Promise.resolve(result),
    loadEntry: () => Promise.resolve(entryResult),
  };
}

function renderPage(adapter?: ChangelogAdapter) {
  return render(
    <MemoryRouter>
      <ChangelogPage changelogAdapter={adapter} />
    </MemoryRouter>,
  );
}

function renderEntry(
  adapter?: ChangelogAdapter,
  initialEntry = "/changelog/fixture-release",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="/changelog/:slug"
          element={<ChangelogEntryPage changelogAdapter={adapter} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public changelog page", () => {
  it("renders an honest empty state when the public API has no releases", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ entries: [], nextCursor: null }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const { container } = renderPage();

    expect(await screen.findByRole("heading", { name: "No releases published yet" }))
      .toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByText(/No public release notes are available yet/i)).toBeVisible();
    expect(screen.queryByRole("link", { name: /RSS/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("renders published releases and links to their public detail routes", async () => {
    const adapter = adapterReturning({
      kind: "populated",
      releases: [releaseFixture],
    });

    renderPage(adapter);

    const article = await screen.findByRole("article", { name: "1.2.3-test" });
    expect(within(article).getByRole("link", { name: "1.2.3-test" }))
      .toHaveAttribute("href", "/changelog/fixture-release");
    expect(within(article).getByText("Fixture release title")).toBeVisible();
    expect(within(article).getByRole("heading", { name: "Fixture release item" })).toBeVisible();
    expect(within(article).getByText("Fixture detail supplied only by the test adapter."))
      .toBeVisible();
    expect(within(article).getByText("v1.2.3-test")).toBeVisible();
    expect(screen.getByRole("button", { name: "Added" })).toHaveAttribute("aria-pressed", "false");
  });

  it("renders a degraded state when the default endpoint is absent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { code: "not_found", message: "not found" } }),
      { status: 404, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    renderPage();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Changelog unavailable");
    expect(alert).toHaveTextContent(
      "Published release notes are not available from this deployment yet.",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/changelog",
      expect.objectContaining({ credentials: "include" }),
    );
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });
});

describe("public changelog entry page", () => {
  it("rejects timestamps that JavaScript would otherwise normalize", () => {
    expect(() =>
      parseChangelogRelease({
        ...releaseFixture,
        publishedAt: "2026-02-31T00:00:00.000Z",
      })
    ).toThrow(/publishedAt/);
    expect(() =>
      parseChangelogRelease({
        ...releaseFixture,
        releasedAt: "2026-01-01T24:00:00.000Z",
      })
    ).toThrow(/releasedAt/);
  });

  it("renders one published release with grouped categories and source metadata", async () => {
    const adapter = adapterReturning(
      { kind: "empty" },
      { kind: "found", release: releaseFixture },
    );

    const { container } = renderEntry(adapter);

    expect(await screen.findByRole("heading", { level: 1, name: "1.2.3-test" }))
      .toBeVisible();
    expect(screen.getByText("Fixture release title")).toBeVisible();
    expect(screen.getByText("Fixture summary supplied only by the test adapter."))
      .toBeVisible();
    expect(screen.getAllByRole("link", { name: "All releases" })).toHaveLength(2);
    for (const link of screen.getAllByRole("link", { name: "All releases" })) {
      expect(link).toHaveAttribute("href", "/changelog");
    }
    expect(screen.getByRole("heading", { level: 2, name: "Added" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Security" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Fixture security item" })).toBeVisible();
    expect(screen.getByText("v1.2.3-test")).toBeVisible();
    expect(screen.getAllByText("2026-08-24")).toHaveLength(2);
    expect(screen.queryByText(/RSS/i)).not.toBeInTheDocument();
    const results = await axe.run(container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(results.violations).toEqual([]);
  });

  it("loads the exact public entry endpoint through the strict HTTP adapter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify(releaseFixture),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    renderEntry();

    expect(await screen.findByRole("heading", { level: 1, name: "1.2.3-test" }))
      .toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/changelog/fixture-release",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("does not disclose whether malformed or unpublished slugs exist", async () => {
    const loadEntry = vi.fn<ChangelogAdapter["loadEntry"]>();
    const adapter: ChangelogAdapter = {
      load: () => Promise.resolve({ kind: "empty" }),
      loadEntry,
    };

    renderEntry(adapter, "/changelog/Not_Valid");

    expect(await screen.findByRole("heading", { level: 1, name: "Release not found" }))
      .toBeVisible();
    expect(screen.getByText(/does not exist or is no longer public/i)).toBeVisible();
    expect(loadEntry).not.toHaveBeenCalled();
  });

  it("shows loading instead of stale content when the route slug changes", async () => {
    const first = deferred<ChangelogEntryLoadResult>();
    const second = deferred<ChangelogEntryLoadResult>();
    const loadEntry = vi.fn((slug: string) =>
      slug === releaseFixture.slug ? first.promise : second.promise
    );
    const adapter: ChangelogAdapter = {
      load: () => Promise.resolve({ kind: "empty" }),
      loadEntry,
    };
    const router = createMemoryRouter([
      {
        path: "/changelog/:slug",
        element: <ChangelogEntryPage changelogAdapter={adapter} />,
      },
    ], { initialEntries: [`/changelog/${releaseFixture.slug}`] });
    render(<RouterProvider router={router} />);

    await act(async () => {
      first.resolve({ kind: "found", release: releaseFixture });
    });
    expect(await screen.findByRole("heading", { level: 1, name: "1.2.3-test" }))
      .toHaveFocus();

    await act(async () => {
      await router.navigate("/changelog/second-release");
    });
    expect(screen.queryByText("Fixture release title")).not.toBeInTheDocument();
    expect(screen.getByText("Loading published release")).toBeInTheDocument();

    await act(async () => {
      second.resolve({
        kind: "found",
        release: {
          ...releaseFixture,
          version: "2.0.0-test",
          slug: "second-release",
          title: "Second fixture release",
        },
      });
    });
    expect(await screen.findByRole("heading", { level: 1, name: "2.0.0-test" }))
      .toHaveFocus();
    expect(window.scrollTo).toHaveBeenLastCalledWith({
      top: 0,
      left: 0,
      behavior: "auto",
    });
  });

  it("maps missing releases separately from malformed service responses", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: { code: "not_found", message: "not found" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ...releaseFixture, unexpected: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const first = renderEntry();
    expect(await screen.findByRole("heading", { level: 1, name: "Release not found" }))
      .toBeVisible();
    first.unmount();

    renderEntry();
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Release details unavailable");
    expect(alert).toHaveTextContent("unreadable release response");
    expect(screen.queryByRole("heading", { level: 1, name: "1.2.3-test" }))
      .not.toBeInTheDocument();
  });
});
