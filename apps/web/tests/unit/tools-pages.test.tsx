import axe from "axe-core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { RelayIdentity, RelayWorkspace } from "../../src/auth/types";
import { ToolDetailPage } from "../../src/features/tools/ToolDetailPage";
import { ToolsPage } from "../../src/features/tools/ToolsPage";
import {
  httpToolDetailAdapter,
  httpToolsCatalogAdapter,
  type ToolCatalogLoadResult,
  type ToolDetail,
  type ToolDetailAdapter,
  type ToolDetailLoadResult,
  type ToolsCatalogAdapter,
  type ToolSummary,
} from "../../src/lib/api/tools";

const TEST_ONLY_IDENTITY_FIXTURE: RelayIdentity = {
  session: {
    id: "session-tools-fixture",
    userId: "user-tools-fixture",
    expiresAt: null,
    activeWorkspaceId: "workspace-tools-fixture",
  },
  user: {
    id: "user-tools-fixture",
    name: "Tool Test Operator",
    email: "tools@example.test",
    image: null,
  },
};

const TEST_ONLY_WORKSPACE_FIXTURE: RelayWorkspace = {
  id: "workspace-tools-fixture",
  name: "Tools fixture workspace",
  slug: "tools-fixture",
};

const TEST_ONLY_TOOL_SUMMARY_FIXTURE: ToolSummary = {
  id: `tool_${"1".repeat(32)}`,
  key: "image.generate.fixture",
  name: "Fixture Image Generator",
  category: "image",
  summary: "A test-only summary for catalog rendering.",
  lifecycle: "published",
  activeVersionId: `tver_${"2".repeat(32)}`,
  version: 3,
};

const TEST_ONLY_SECOND_TOOL_SUMMARY_FIXTURE: ToolSummary = {
  id: `tool_${"3".repeat(32)}`,
  key: "media.transform.fixture",
  name: "Fixture Media Transformer",
  category: "media",
  summary: null,
  lifecycle: "deprecated",
  activeVersionId: `tver_${"4".repeat(32)}`,
  version: 1,
};

const TEST_ONLY_TOOL_DETAIL_FIXTURE: ToolDetail = {
  ...TEST_ONLY_TOOL_SUMMARY_FIXTURE,
  executionMode: "async",
  maxDurationSeconds: 300,
  inputSchema: {
    type: "object",
    required: ["prompt"],
    properties: {
      prompt: { type: "string", maxLength: 2000 },
    },
  },
  outputSchema: {
    type: "object",
    properties: {
      artifactIds: { type: "array", items: { type: "string" } },
    },
  },
};

function testOnlyCatalogAdapter(
  result: ToolCatalogLoadResult,
): ToolsCatalogAdapter {
  return { list: vi.fn().mockResolvedValue(result) };
}

function testOnlyDetailAdapter(
  result: ToolDetailLoadResult,
): ToolDetailAdapter {
  return { get: vi.fn().mockResolvedValue(result) };
}

function renderWithTestOnlyAuth(
  children: ReactNode,
  initialEntry = "/dashboard/tools",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AuthProvider
        adapter={createTestAuthAdapter({
          identity: TEST_ONLY_IDENTITY_FIXTURE,
          activeWorkspace: TEST_ONLY_WORKSPACE_FIXTURE,
        })}
      >
        <main className="product-surface">{children}</main>
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tools API adapters", () => {
  it("strictly parses catalog payloads and sends supported filters", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "ok",
            items: [TEST_ONLY_TOOL_SUMMARY_FIXTURE],
            nextCursor: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            kind: "ok",
            items: [{
              ...TEST_ONLY_TOOL_SUMMARY_FIXTURE,
              unimplementedField: "fixture",
            }],
            nextCursor: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const valid = await httpToolsCatalogAdapter.list({
      limit: 100,
      category: "image",
      search: "fixture generator",
    });

    expect(valid).toEqual({
      kind: "populated",
      tools: [TEST_ONLY_TOOL_SUMMARY_FIXTURE],
      nextCursor: null,
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/tools?limit=100&category=image&search=fixture+generator",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      credentials: "include",
    }));

    const malformed = await httpToolsCatalogAdapter.list();
    expect(malformed).toEqual({
      kind: "degraded",
      message:
        "Relay returned an unreadable tool catalog. No tool data was shown.",
    });
  });

  it("maps detail 404 and 401 responses to explicit page states", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "not_found", message: "not found" },
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { code: "unauthorized", message: "expired" },
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpToolDetailAdapter.get("image.missing")).resolves.toEqual({
      kind: "not-found",
    });
    await expect(httpToolDetailAdapter.get("image.generate.fixture")).resolves
      .toEqual({
        kind: "auth-expired",
      });
  });
});

describe("tool catalog page", () => {
  it("renders a semantic, searchable catalog and passes axe", async () => {
    const adapter = testOnlyCatalogAdapter({
      kind: "populated",
      tools: [
        TEST_ONLY_TOOL_SUMMARY_FIXTURE,
        TEST_ONLY_SECOND_TOOL_SUMMARY_FIXTURE,
      ],
      nextCursor: null,
    });
    const { container } = renderWithTestOnlyAuth(
      <ToolsPage toolsAdapter={adapter} />,
    );

    const table = await screen.findByRole("table", {
      name: "Tools, 2 results",
    });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Tools" }))
      .toBeVisible();
    expect(
      within(table).getAllByRole("columnheader").map((header) =>
        header.textContent
      ),
    )
      .toEqual(["Tool", "Category", "Lifecycle", "Version"]);
    expect(
      within(table).getByRole("link", {
        name: /Fixture Image Generator, image\.generate\.fixture/i,
      }),
    ).toHaveAttribute("href", "/dashboard/tools/image.generate.fixture");
    expect(screen.getByLabelText("Search tools")).toBeVisible();
    expect(screen.getByLabelText("Category")).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply filters" })).toBeVisible();
    await expectNoAxeViolations(container);
  });

  it("applies search and category filters and renders the no-match state", async () => {
    const user = userEvent.setup();
    const list = vi.fn().mockResolvedValue(
      {
        kind: "populated",
        tools: [
          TEST_ONLY_TOOL_SUMMARY_FIXTURE,
          TEST_ONLY_SECOND_TOOL_SUMMARY_FIXTURE,
        ],
        nextCursor: null,
      } satisfies ToolCatalogLoadResult,
    );
    renderWithTestOnlyAuth(<ToolsPage toolsAdapter={{ list }} />);

    await screen.findByRole("table", { name: "Tools, 2 results" });
    await user.selectOptions(screen.getByLabelText("Category"), "media");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    const filteredTable = await screen.findByRole("table", {
      name: "Tools, 1 result",
    });
    expect(within(filteredTable).getByText("Fixture Media Transformer"))
      .toBeVisible();
    expect(within(filteredTable).queryByText("Fixture Image Generator")).not
      .toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: "media", limit: 100 }),
      expect.any(AbortSignal),
    );

    const search = screen.getByLabelText("Search tools");
    await user.clear(search);
    await user.type(search, "no matching fixture");
    await user.selectOptions(screen.getByLabelText("Category"), "");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    expect(
      await screen.findByRole("heading", {
        name: "No tools match the current filters",
      }),
    ).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("names loading, empty, not-found, and degraded catalog states", async () => {
    let resolveCatalog!: (result: ToolCatalogLoadResult) => void;
    const pendingCatalog = new Promise<ToolCatalogLoadResult>((resolve) => {
      resolveCatalog = resolve;
    });
    const loadingRender = renderWithTestOnlyAuth(
      <ToolsPage toolsAdapter={{ list: () => pendingCatalog }} />,
    );

    expect(screen.getByText("Loading tool catalog")).toBeInTheDocument();
    await act(async () => resolveCatalog({ kind: "empty", nextCursor: null }));
    expect(
      await screen.findByRole("heading", { name: "No tools are available" }),
    ).toBeVisible();
    loadingRender.unmount();

    const notFoundRender = renderWithTestOnlyAuth(
      <ToolsPage
        toolsAdapter={testOnlyCatalogAdapter({ kind: "not-found" })}
      />,
    );
    expect(await screen.findByText("Tool catalog not found")).toBeVisible();
    notFoundRender.unmount();

    renderWithTestOnlyAuth(
      <ToolsPage
        toolsAdapter={testOnlyCatalogAdapter({
          kind: "degraded",
          message: "Test-only catalog failure. No data was changed.",
        })}
      />,
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Tool catalog unavailable");
    expect(alert).toHaveTextContent("Test-only catalog failure");
  });
});

describe("tool detail page", () => {
  it("renders only implemented contract fields and the execution boundary", async () => {
    const { container } = renderWithTestOnlyAuth(
      <ToolDetailPage
        toolAdapter={testOnlyDetailAdapter({
          kind: "found",
          tool: TEST_ONLY_TOOL_DETAIL_FIXTURE,
        })}
        toolKey={TEST_ONLY_TOOL_DETAIL_FIXTURE.key}
      />,
      `/dashboard/tools/${TEST_ONLY_TOOL_DETAIL_FIXTURE.key}`,
    );

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: TEST_ONLY_TOOL_DETAIL_FIXTURE.key,
      }),
    ).toBeVisible();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(await screen.findByText(
      "Execution is unavailable until a real provider and meter policy are configured.",
    )).toBeVisible();
    expect(screen.getByRole("heading", { name: "Contract facts" }))
      .toBeVisible();
    expect(screen.getByRole("heading", { name: "Input schema" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Output schema" }))
      .toBeVisible();
    expect(
      screen.getByLabelText(
        `Input schema for ${TEST_ONLY_TOOL_DETAIL_FIXTURE.key}`,
      ),
    )
      .toHaveTextContent('"prompt"');
    expect(screen.queryByRole("button", { name: /run/i })).not
      .toBeInTheDocument();
    expect(container).not.toHaveTextContent(
      /Halide|Aurora|pricing|usage|composer/i,
    );
    await expectNoAxeViolations(container);
  });

  it("renders a recoverable not-found detail state", async () => {
    renderWithTestOnlyAuth(
      <ToolDetailPage
        toolAdapter={testOnlyDetailAdapter({ kind: "not-found" })}
        toolKey="image.missing"
      />,
      "/dashboard/tools/image.missing",
    );

    expect(
      await screen.findByRole("heading", { level: 1, name: "Tool not found" }),
    )
      .toBeVisible();
    expect(screen.getByText("No matching tool contract")).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to tools" }))
      .toHaveAttribute("href", "/dashboard/tools");
  });

  it("expires the authenticated session when the page adapter returns 401 state", async () => {
    let resolveCatalog!: (result: ToolCatalogLoadResult) => void;
    const catalog = new Promise<ToolCatalogLoadResult>((resolve) => {
      resolveCatalog = resolve;
    });

    render(
      <MemoryRouter initialEntries={["/dashboard/tools"]}>
        <AuthProvider
          adapter={createTestAuthAdapter({
            identity: TEST_ONLY_IDENTITY_FIXTURE,
            activeWorkspace: TEST_ONLY_WORKSPACE_FIXTURE,
          })}
        >
          <Routes>
            <Route
              path="/sign-in"
              element={<h1>Test-only sign-in boundary</h1>}
            />
            <Route element={<ProtectedRoute />}>
              <Route
                path="/dashboard/tools"
                element={<ToolsPage toolsAdapter={{ list: () => catalog }} />}
              />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { level: 1, name: "Tools" }))
      .toBeVisible();
    await act(async () => resolveCatalog({ kind: "auth-expired" }));

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Test-only sign-in boundary",
      }),
    ).toBeVisible();
  });

  it("renders a degraded detail response without exposing partial data", async () => {
    renderWithTestOnlyAuth(
      <ToolDetailPage
        toolAdapter={testOnlyDetailAdapter({
          kind: "degraded",
          message: "Test-only unreadable contract response.",
        })}
        toolKey="image.generate.fixture"
      />,
      "/dashboard/tools/image.generate.fixture",
    );

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "Tool contract unavailable",
      }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Test-only unreadable contract response",
    );
    await waitFor(() => {
      expect(screen.queryByText(TEST_ONLY_TOOL_DETAIL_FIXTURE.name)).not
        .toBeInTheDocument();
    });
  });
});
