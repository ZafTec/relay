import axe from "axe-core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocsPage } from "../../src/features/docs/DocsPage";
import { StatusPage } from "../../src/features/status/StatusPage";
import {
  type StatusAdapter,
  type StatusBuildSnapshot,
  type StatusReadinessSnapshot,
  httpStatusAdapter,
} from "../../src/lib/api/status";

const build = {
  version: "0.4.0",
  revision: "abc123",
} as const;

const operationalReadiness: StatusReadinessSnapshot = {
  kind: "operational",
  readiness: {
    service: "api",
    status: "ok",
    checks: [{ name: "database", status: "ok" }],
  },
};

const availableBuild: StatusBuildSnapshot = {
  kind: "available",
  build,
};

function adapterReturning(
  readiness: StatusReadinessSnapshot,
  buildState: StatusBuildSnapshot,
): StatusAdapter {
  return {
    loadReadiness: vi.fn().mockResolvedValue(readiness),
    loadBuild: vi.fn().mockResolvedValue(buildState),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderPage(page: React.ReactNode) {
  return render(<MemoryRouter>{page}</MemoryRouter>);
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations).toEqual([]);
}

describe("public docs", () => {
  it("documents and searches implemented HTTP and MCP contracts", async () => {
    const user = userEvent.setup();
    const { container } = renderPage(<DocsPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Quickstart" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Documentation" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "On this page" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Discover a published tool" })).toBeInTheDocument();
    expect(screen.getByText("Implemented transport contracts")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Workspace and public HTTP routes" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Stable MCP management tool names" })).toBeInTheDocument();

    expect(container).toHaveTextContent("/api/v1/tools/:toolKey");
    expect(container).toHaveTextContent("/api/v1/runs");
    expect(container).toHaveTextContent("/api/v1/artifacts/:artifactId/download");
    expect(container).toHaveTextContent("/api/v1/artifacts/:artifactId/share-links");
    expect(container).toHaveTextContent("/s/:token");
    expect(container).toHaveTextContent("relay.artifacts.create_share_link");
    expect(container).toHaveTextContent("GET /health/ready");
    expect(container).toHaveTextContent("GET /version");
    expect(container).not.toHaveTextContent("Halide XL");
    expect(container).not.toHaveTextContent("Route contracts are still being finalized");

    await user.type(
      screen.getByRole("searchbox", { name: "Search HTTP paths and MCP tool names" }),
      "runs:cancel",
    );
    expect(screen.getByRole("link", { name: "relay.runs.cancel" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "relay.tools.list" })).not.toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});

describe("public status", () => {
  it("announces loading while both endpoint requests are pending", () => {
    const adapter: StatusAdapter = {
      loadReadiness: vi.fn(() => new Promise<StatusReadinessSnapshot>(() => undefined)),
      loadBuild: vi.fn(() => new Promise<StatusBuildSnapshot>(() => undefined)),
    };

    renderPage(<StatusPage statusAdapter={adapter} />);

    expect(screen.getByRole("heading", { name: "Checking Relay readiness" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Checking status" })).toBeDisabled();
  });

  it("renders only reported operational checks and build identity", async () => {
    const { container } = renderPage(
      <StatusPage statusAdapter={adapterReturning(operationalReadiness, availableBuild)} />,
    );

    expect(await screen.findByRole("heading", {
      level: 1,
      name: "All reported checks operational",
    })).toBeInTheDocument();
    expect(screen.getByText("database")).toBeInTheDocument();
    expect(screen.getByText("0.4.0")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("99.81%");
    expect(container).not.toHaveTextContent("Halide XL");
    await expectNoAxeViolations(container);
  });

  it("preserves operational readiness when build identity is unavailable", async () => {
    renderPage(<StatusPage statusAdapter={adapterReturning(operationalReadiness, {
      kind: "unknown",
      message: "Build identity could not be verified.",
    })} />);

    expect(await screen.findByRole("heading", { name: "All reported checks operational" }))
      .toBeInTheDocument();
    expect(screen.getByText("Build identity could not be verified.")).toBeInTheDocument();
  });

  it("preserves build identity when readiness is unknown", async () => {
    renderPage(<StatusPage statusAdapter={adapterReturning({
      kind: "unknown",
      message: "Relay readiness could not be verified. The service may still be available.",
    }, availableBuild)} />);

    expect(await screen.findByRole("heading", { name: "Current readiness unknown" }))
      .toBeInTheDocument();
    expect(screen.getByText("No last-known state is substituted")).toBeInTheDocument();
    expect(screen.getByText("0.4.0")).toBeInTheDocument();
  });

  it("shows degraded readiness from the injected adapter", async () => {
    const adapter = adapterReturning({
      kind: "degraded",
      readiness: {
        service: "api",
        status: "degraded",
        checks: [{ name: "database", status: "error", message: "unreachable" }],
      },
    }, {
      kind: "unknown",
      message: "Build identity could not be verified.",
    });

    renderPage(<StatusPage statusAdapter={adapter} />);

    expect(await screen.findByRole("heading", {
      level: 1,
      name: "Relay readiness is degraded",
    })).toBeInTheDocument();
    expect(screen.getByText("unreachable")).toBeInTheDocument();
    expect(screen.getByText("Build identity could not be verified.")).toBeInTheDocument();
  });

  it("loads readiness and version independently without browser caching", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      if (path === "/health/ready") {
        return new Response(JSON.stringify({
          service: "api",
          status: "degraded",
          checks: [{ name: "database", status: "error", message: "unreachable" }],
          build,
        }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/version") {
        return new Response(JSON.stringify(build), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(httpStatusAdapter.loadReadiness()).resolves.toEqual({
      kind: "degraded",
      readiness: {
        service: "api",
        status: "degraded",
        checks: [{ name: "database", status: "error", message: "unreachable" }],
      },
    });
    await expect(httpStatusAdapter.loadBuild()).resolves.toEqual(availableBuild);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith("/health/ready", expect.objectContaining({
      cache: "no-store",
      credentials: "include",
    }));
    expect(fetchMock).toHaveBeenCalledWith("/version", expect.objectContaining({
      cache: "no-store",
      credentials: "include",
    }));
  });

  it("bounds a stalled readiness request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected an abort signal");
      const rejectAbort = () => reject(signal.reason);
      if (signal.aborted) rejectAbort();
      else signal.addEventListener("abort", rejectAbort, { once: true });
    })));

    const result = httpStatusAdapter.loadReadiness();
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(result).resolves.toEqual({
      kind: "unknown",
      message: "Relay readiness did not respond before the request timed out.",
    });
  });

  it("propagates an external abort instead of reporting an unknown endpoint", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Expected an abort signal");
      const rejectAbort = () => reject(signal.reason);
      if (signal.aborted) rejectAbort();
      else signal.addEventListener("abort", rejectAbort, { once: true });
    })));
    const controller = new AbortController();
    const reason = new DOMException("Navigation changed.", "AbortError");
    const result = httpStatusAdapter.loadBuild(controller.signal);

    controller.abort(reason);

    await expect(result).rejects.toBe(reason);
  });

  it("returns unknown readiness without discarding a separately available build", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input) => {
      if (String(input) === "/health/ready") throw new TypeError("offline");
      return new Response(JSON.stringify(build), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await expect(httpStatusAdapter.loadReadiness()).resolves.toEqual({
      kind: "unknown",
      message: "Relay readiness could not be verified. The service may still be available.",
    });
    await expect(httpStatusAdapter.loadBuild()).resolves.toEqual(availableBuild);
  });
});
