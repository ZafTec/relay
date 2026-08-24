import axe from "axe-core";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangelogPage } from "../../src/features/changelog/ChangelogPage";
import type {
  ChangelogAdapter,
  ChangelogLoadResult,
} from "../../src/lib/api/changelog";

function adapterReturning(result: ChangelogLoadResult): ChangelogAdapter {
  return {
    load: () => Promise.resolve(result),
  };
}

function renderPage(adapter?: ChangelogAdapter) {
  return render(
    <MemoryRouter>
      <ChangelogPage changelogAdapter={adapter} />
    </MemoryRouter>,
  );
}

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

  it("renders published releases supplied by an injected adapter", async () => {
    const adapter = adapterReturning({
      kind: "populated",
      releases: [
        {
          version: "fixture-version",
          slug: "fixture-release",
          title: "Fixture release title",
          summary: "Fixture summary supplied only by the test adapter.",
          gitTag: "fixture-tag",
          commitSha: "fixture-commit",
          releasedAt: "2026-08-24T12:00:00.000Z",
          items: [
            {
              category: "added",
              area: "Test surface",
              title: "Fixture release item",
              description: "Fixture detail supplied only by the test adapter.",
              sortOrder: 0,
            },
          ],
        },
      ],
    });

    renderPage(adapter);

    const article = await screen.findByRole("article", { name: "fixture-version" });
    expect(within(article).getByRole("heading", { name: "fixture-version" })).toBeVisible();
    expect(within(article).getByText("Fixture release title")).toBeVisible();
    expect(within(article).getByRole("heading", { name: "Fixture release item" })).toBeVisible();
    expect(within(article).getByText("Fixture detail supplied only by the test adapter.")).toBeVisible();
    expect(within(article).getByText("fixture-tag")).toBeVisible();
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
