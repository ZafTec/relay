import axe from "axe-core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { ProtectedRoute } from "../../src/auth/ProtectedRoute";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import type { RelayIdentity, RelayWorkspace } from "../../src/auth/types";
import { ToolDetailPage } from "../../src/features/tools/ToolDetailPage";
import type {
  ToolArtifactsAdapter,
  ToolRunsAdapter,
  ProductionToolKey,
} from "../../src/features/tools/ToolExecutionComposer";
import type {
  ArtifactSummary,
  ListArtifactsAdapterResult,
} from "../../src/lib/api/artifacts";
import type {
  CreateRunAdapterResult,
  CreateRunRequest,
  RunDetail,
} from "../../src/lib/api/runs";
import type {
  ToolDetail,
  ToolDetailAdapter,
} from "../../src/lib/api/tools";

const IDENTITY: RelayIdentity = {
  session: {
    id: "session-tool-execution",
    userId: "user-tool-execution",
    expiresAt: null,
    activeWorkspaceId: "workspace-tool-execution",
  },
  user: {
    id: "user-tool-execution",
    name: "Tool Operator",
    email: "operator@example.test",
    image: null,
  },
};

const WORKSPACE: RelayWorkspace = {
  id: "workspace-tool-execution",
  name: "Tool execution workspace",
  slug: "tool-execution",
};

const IMAGE_ARTIFACT: ArtifactSummary = {
  id: `art_${"1".repeat(32)}`,
  name: "Reference image",
  mediaKind: "image",
  sourceRunId: null,
  currentVersion: {
    id: `aver_${"2".repeat(32)}`,
    sequence: 4,
    sha256: "a".repeat(64),
    contentMd5: "A".repeat(22) + "==",
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
    createdAt: "2026-08-26T10:00:00.000Z",
  },
  shared: false,
  createdAt: "2026-08-26T10:00:00.000Z",
};

const PDF_ARTIFACT: ArtifactSummary = {
  id: `art_${"3".repeat(32)}`,
  name: "Quarterly report",
  mediaKind: "document",
  sourceRunId: null,
  currentVersion: {
    id: `aver_${"4".repeat(32)}`,
    sequence: 2,
    sha256: "b".repeat(64),
    contentMd5: "B".repeat(22) + "==",
    sizeBytes: 2_000_000,
    mimeType: "application/pdf",
    width: null,
    height: null,
    durationMs: null,
    source: "upload",
    sourceRunId: null,
    parentVersionId: null,
    metadata: {},
    verificationStatus: "cryptographically_verified",
    createdAt: "2026-08-26T10:00:00.000Z",
  },
  shared: false,
  createdAt: "2026-08-26T10:00:00.000Z",
};

function tool(
  key: ProductionToolKey,
  lifecycle: ToolDetail["lifecycle"] = "published",
): ToolDetail {
  const names = {
    "image.generate.gpt-image-2": "GPT Image 2",
    "image.generate.flux-2-pro": "FLUX.2 Pro",
    "document.ocr": "Document OCR",
    "image.edit.gpt-image-2": "GPT Image 2 Edit",
    "image.edit.flux-2-pro": "FLUX.2 Pro Edit",
    "image.generate.mai-image-2.5": "MAI Image 2.5",
    "image.edit.mai-image-2.5": "MAI Image 2.5 Edit",
    "image.generate.mai-image-2.5-flash": "MAI Image 2.5 Flash",
    "image.edit.mai-image-2.5-flash": "MAI Image 2.5 Flash Edit",
  } as const;
  return {
    id: `tool_${"5".repeat(32)}`,
    key,
    name: names[key],
    category: key === "document.ocr" ? "document" : "image",
    summary: `Production fixture for ${names[key]}.`,
    lifecycle,
    activeVersionId: `tver_${"6".repeat(32)}`,
    version: 1,
    executionMode: "async",
    maxDurationSeconds: 300,
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
  };
}

function detailAdapter(value: ToolDetail): ToolDetailAdapter {
  return { get: vi.fn().mockResolvedValue({ kind: "found", tool: value }) };
}

function artifactAdapter(
  result: ListArtifactsAdapterResult = {
    kind: "ok",
    items: [IMAGE_ARTIFACT, PDF_ARTIFACT],
    nextCursor: null,
  },
): ToolArtifactsAdapter {
  return {
    list: vi.fn().mockResolvedValue(result),
    get: vi.fn().mockResolvedValue({ kind: "not_found" }),
    createUpload: vi.fn().mockRejectedValue(new Error("not used")),
    putUpload: vi.fn().mockRejectedValue(new Error("not used")),
    completeUpload: vi.fn().mockRejectedValue(new Error("not used")),
  };
}

function acceptedRun(
  key: ToolDetail["key"],
  input: CreateRunRequest["input"],
): Extract<CreateRunAdapterResult, { readonly kind: "accepted" }> {
  const run: RunDetail = {
    id: `run_${"7".repeat(32)}`,
    tool: {
      key,
      name: "Production tool",
      versionId: `tver_${"6".repeat(32)}`,
      version: 1,
    },
    status: "queued",
    resultCompleteness: null,
    acceptedAt: "2026-08-26T10:00:00.000Z",
    startedAt: null,
    terminalAt: null,
    input,
    outputSet: null,
    reservation: null,
  };
  return {
    kind: "accepted",
    run,
    replayed: false,
    queueReason: "awaiting_dispatch",
  };
}

function acceptedAdapter(key: ToolDetail["key"]) {
  const create = vi.fn<ToolRunsAdapter["create"]>(async (request) =>
    acceptedRun(key, request.input)
  );
  return { adapter: { create } satisfies ToolRunsAdapter, create };
}

function renderTool(
  value: ToolDetail,
  runsAdapter: ToolRunsAdapter,
  artifactsAdapter: ToolArtifactsAdapter = artifactAdapter(),
) {
  return render(
    <MemoryRouter initialEntries={[`/dashboard/tools/${value.key}`]}>
      <AuthProvider
        adapter={createTestAuthAdapter({
          identity: IDENTITY,
          activeWorkspace: WORKSPACE,
        })}
      >
        <main className="product-surface">
          <ToolDetailPage
            toolAdapter={detailAdapter(value)}
            runsAdapter={runsAdapter}
            artifactsAdapter={artifactsAdapter}
            toolKey={value.key}
          />
        </main>
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

async function configureGptPrompt(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText("Prompt"), "A graphite observatory at dawn");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("production tool run composers", () => {
  it("maps every GPT Image 2 field into a frozen CreateRunRequest and links the accepted run", async () => {
    const user = userEvent.setup();
    const { adapter, create } = acceptedAdapter("image.generate.gpt-image-2");
    const { container } = renderTool(tool("image.generate.gpt-image-2"), adapter);

    await configureGptPrompt(user);
    await user.clear(screen.getByLabelText("Images"));
    await user.type(screen.getByLabelText("Images"), "3");
    await user.clear(screen.getByLabelText("Size"));
    await user.type(screen.getByLabelText("Size"), "1536x1024");
    await user.selectOptions(screen.getByLabelText("Quality"), "high");
    await user.selectOptions(screen.getByLabelText("Output format"), "jpeg");
    await user.clear(screen.getByLabelText("Output compression"));
    await user.type(screen.getByLabelText("Output compression"), "81");
    await user.selectOptions(screen.getByLabelText("Background"), "opaque");
    await user.selectOptions(screen.getByLabelText("Moderation"), "low");
    await user.click(screen.getByRole("button", { name: "Create run" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const request = create.mock.calls[0]?.[0];
    const key = create.mock.calls[0]?.[1];
    expect(request).toEqual({
      toolKey: "image.generate.gpt-image-2",
      input: {
        prompt: "A graphite observatory at dawn",
        n: 3,
        size: "1536x1024",
        quality: "high",
        outputFormat: "jpeg",
        outputCompression: 81,
        background: "opaque",
        moderation: "low",
      },
    });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request?.input)).toBe(true);
    expect(key).toMatch(/^tool-run:image\.generate\.gpt-image-2:/);
    expect(await screen.findByRole("link", { name: "View run" })).toHaveAttribute(
      "href",
      `/dashboard/runs/run_${"7".repeat(32)}`,
    );
    expect(screen.getByRole("region", { name: "Run accepted" })).toHaveFocus();
    expect(screen.getByLabelText("Prompt")).toHaveValue("A graphite observatory at dawn");
    await expectNoAxeViolations(container);
  });

  it("maps FLUX controls and selected current artifact versions", async () => {
    const user = userEvent.setup();
    const { adapter, create } = acceptedAdapter("image.generate.flux-2-pro");
    const artifacts = artifactAdapter();
    const { container } = renderTool(tool("image.generate.flux-2-pro"), adapter, artifacts);

    await user.type(await screen.findByLabelText("Prompt"), "Combine the selected reference");
    await user.click(screen.getByRole("checkbox", { name: /Disable prompt upsampling/i }));
    await user.click(await screen.findByRole("checkbox", { name: /Reference image/i }));
    await user.type(screen.getByLabelText("Seed"), "99");
    await user.type(screen.getByLabelText("Width"), "1024");
    await user.type(screen.getByLabelText("Height"), "1024");
    await user.selectOptions(screen.getByLabelText("Safety tolerance"), "4");
    await user.selectOptions(screen.getByLabelText("Output format"), "webp");
    await user.click(screen.getByRole("button", { name: "Create run" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toEqual({
      toolKey: "image.generate.flux-2-pro",
      input: {
        prompt: "Combine the selected reference",
        disablePromptUpsampling: true,
        inputArtifactVersionIds: [IMAGE_ARTIFACT.currentVersion?.id],
        seed: 99,
        width: 1024,
        height: 1024,
        safetyTolerance: 4,
        outputFormat: "webp",
      },
    });
    expect(artifacts.list).toHaveBeenCalledWith(
      { limit: 100 },
      expect.any(AbortSignal),
    );
    await expectNoAxeViolations(container);
  });

  it("maps the OCR source and complete extraction capability set", async () => {
    const user = userEvent.setup();
    const { adapter, create } = acceptedAdapter("document.ocr");
    const { container } = renderTool(tool("document.ocr"), adapter);
    const imageSchema = {
      type: "object",
      properties: { caption: { type: "string" } },
    };
    const extractionSchema = {
      type: "object",
      properties: { invoiceNumber: { type: "string" } },
      additionalProperties: false,
    };

    await user.click(await screen.findByRole("radio", { name: /Quarterly report/i }));
    await user.type(screen.getByLabelText("Pages"), "0-2,5");
    await user.click(screen.getByText("Embedded images", { selector: "summary" }));
    await user.click(screen.getByRole("checkbox", { name: "Include images" }));
    await user.type(screen.getByLabelText("Image limit"), "8");
    await user.type(screen.getByLabelText("Image minimum size"), "64");
    fireEvent.change(screen.getByLabelText("Image annotation JSON schema"), {
      target: { value: JSON.stringify(imageSchema) },
    });
    await user.click(screen.getByText("Structured extraction", { selector: "summary" }));
    fireEvent.change(screen.getByLabelText("Document extraction JSON schema"), {
      target: { value: JSON.stringify(extractionSchema) },
    });
    await user.type(screen.getByLabelText("Extraction prompt"), "Extract invoice fields");
    await user.selectOptions(screen.getByLabelText("Table format"), "html");
    await user.selectOptions(screen.getByLabelText("Confidence granularity"), "page");
    await user.click(screen.getByRole("checkbox", { name: "Extract headers" }));
    await user.click(screen.getByRole("checkbox", { name: "Extract footers" }));
    await user.click(screen.getByRole("button", { name: "Create run" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toEqual({
      toolKey: "document.ocr",
      input: {
        sourceArtifactVersionId: PDF_ARTIFACT.currentVersion?.id,
        pages: "0-2,5",
        includeImages: true,
        imageLimit: 8,
        imageMinSize: 64,
        imageAnnotationSchema: imageSchema,
        extractionSchema,
        extractionPrompt: "Extract invoice fields",
        tableFormat: "html",
        extractHeader: false,
        extractFooter: false,
        confidenceGranularity: "page",
      },
    });
    await expectNoAxeViolations(container);
  });

  it("retains the exact frozen request and idempotency key after an unknown outcome", async () => {
    const user = userEvent.setup();
    const create = vi.fn<ToolRunsAdapter["create"]>()
      .mockResolvedValueOnce({
        kind: "unknown-outcome",
        message: "Test-only unknown run outcome.",
        retryable: true,
        retryMode: "exact-request",
        retryAfterSeconds: null,
      })
      .mockImplementationOnce(async (request) => ({
        ...acceptedRun("image.generate.gpt-image-2", request.input),
        replayed: true,
      }));
    renderTool(tool("image.generate.gpt-image-2"), { create });

    await configureGptPrompt(user);
    await user.click(screen.getByRole("button", { name: "Create run" }));
    expect(await screen.findByText("Still waiting for confirmation")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Retry request" }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create.mock.calls[1]?.[0]).toBe(create.mock.calls[0]?.[0]);
    expect(create.mock.calls[1]?.[1]).toBe(create.mock.calls[0]?.[1]);
    expect(Object.isFrozen(create.mock.calls[1]?.[0])).toBe(true);
    expect(await screen.findByText("Run already created")).toBeVisible();
  });

  it("blocks invalid provider dimensions before creating a run", async () => {
    const user = userEvent.setup();
    const create = vi.fn<ToolRunsAdapter["create"]>();
    renderTool(tool("image.generate.flux-2-pro"), { create });

    await user.type(await screen.findByLabelText("Prompt"), "An invalid oversized frame");
    await user.type(screen.getByLabelText("Width"), "4096");
    await user.type(screen.getByLabelText("Height"), "2048");
    await user.click(screen.getByRole("button", { name: "Create run" }));

    expect(await screen.findByText("Width × height must not exceed 4,194,304 pixels."))
      .toBeVisible();
    expect(create).not.toHaveBeenCalled();
  });

  it("shows artifact empty/degraded states and opens the reusable upload dialog", async () => {
    const user = userEvent.setup();
    const create = vi.fn<ToolRunsAdapter["create"]>();
    const emptyRender = renderTool(
      tool("image.generate.flux-2-pro"),
      { create },
      artifactAdapter({ kind: "ok", items: [], nextCursor: null }),
    );

    expect(await screen.findByText("No compatible current versions")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Upload artifact" }));
    expect(screen.getByRole("dialog", { name: "Upload artifact" })).toBeVisible();
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    emptyRender.unmount();

    renderTool(
      tool("document.ocr"),
      { create },
      artifactAdapter({ kind: "degraded", message: "Test-only artifact outage." }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Artifact inputs unavailable");
    expect(alert).toHaveTextContent("Test-only artifact outage");
  });

  it("keeps deprecated production tools read-only", async () => {
    const create = vi.fn<ToolRunsAdapter["create"]>();
    renderTool(tool("document.ocr", "deprecated"), { create });

    expect(await screen.findByText("Execution disabled for deprecated tool")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create run" })).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("expires the session when run admission reports authentication expiry", async () => {
    const user = userEvent.setup();
    const value = tool("image.generate.gpt-image-2");
    const create = vi.fn<ToolRunsAdapter["create"]>().mockResolvedValue({
      kind: "auth-expired",
    });
    render(
      <MemoryRouter initialEntries={[`/dashboard/tools/${value.key}`]}>
        <AuthProvider
          adapter={createTestAuthAdapter({
            identity: IDENTITY,
            activeWorkspace: WORKSPACE,
          })}
        >
          <Routes>
            <Route path="/sign-in" element={<h1>Sign in again</h1>} />
            <Route element={<ProtectedRoute />}>
              <Route
                path="/dashboard/tools/:toolKey"
                element={
                  <ToolDetailPage
                    toolAdapter={detailAdapter(value)}
                    runsAdapter={{ create }}
                    artifactsAdapter={artifactAdapter()}
                  />
                }
              />
            </Route>
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );

    await configureGptPrompt(user);
    await user.click(screen.getByRole("button", { name: "Create run" }));
    expect(await screen.findByRole("heading", { name: "Sign in again" })).toBeVisible();
  });

  it.each([
    [
      "queue-full",
      {
        kind: "queue-full",
        scope: "workspace_tool",
        retryable: true,
        retryAfterSeconds: 5,
      } satisfies CreateRunAdapterResult,
      "Run queue is full",
    ],
    [
      "not-entitled",
      { kind: "not-entitled" } satisfies CreateRunAdapterResult,
      "Tool access required",
    ],
    [
      "allowance-exceeded",
      {
        kind: "allowance-exceeded",
        metric: "requested_units",
        unit: "image",
        limitAmount: "10",
        consumedAmount: "8",
        reservedAmount: "1",
        requestedAmount: "3",
      } satisfies CreateRunAdapterResult,
      "Workspace allowance exceeded",
    ],
    [
      "tool-unavailable",
      { kind: "tool-unavailable" } satisfies CreateRunAdapterResult,
      "Tool temporarily unavailable",
    ],
    [
      "idempotency-conflict",
      { kind: "idempotency-conflict" } satisfies CreateRunAdapterResult,
      "Request could not be reused",
    ],
  ])("renders the %s admission result", async (_name, result, title) => {
    const user = userEvent.setup();
    const create = vi.fn<ToolRunsAdapter["create"]>().mockResolvedValue(result);
    renderTool(tool("image.generate.gpt-image-2"), { create });

    await configureGptPrompt(user);
    await user.click(screen.getByRole("button", { name: "Create run" }));
    expect(await screen.findByText(title)).toBeVisible();
  });
});

describe("new image tools", () => {
  it.each(["image.generate.mai-image-2.5", "image.generate.mai-image-2.5-flash"] as const)("submits %s dimensions and blocks an oversized image", async (key) => {
    const user = userEvent.setup();
    const { adapter, create } = acceptedAdapter(key);
    renderTool(tool(key), adapter);
    await user.type(await screen.findByLabelText("Prompt"), "A simple receipt");
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "1365" } });
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "1365" } });
    await user.click(screen.getByRole("button", { name: "Create run" }));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByText(/must not exceed 1,048,576 pixels/)).toBeVisible();
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "768" } });
    await user.click(screen.getByRole("button", { name: "Create run" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toEqual({ toolKey: key, input: { prompt: "A simple receipt", width: 1365, height: 768 } });
  });

  it.each(["image.edit.gpt-image-2", "image.edit.flux-2-pro", "image.edit.mai-image-2.5", "image.edit.mai-image-2.5-flash"] as const)("requires and pins the source for %s", async (key) => {
    const user = userEvent.setup();
    const { adapter, create } = acceptedAdapter(key);
    const { container } = renderTool(tool(key), adapter);
    const mai = key.includes("mai-image");
    await user.type(await screen.findByLabelText(mai ? "Edit instruction" : "Prompt"), "Make the background blue");
    await user.click(screen.getByRole("button", { name: "Create run" }));
    expect(create).not.toHaveBeenCalled();
    await user.click(await screen.findByRole(mai ? "radio" : "checkbox", { name: /Reference image/i }));
    await user.click(screen.getByRole("button", { name: "Create run" }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ toolKey: key, input: { prompt: "Make the background blue", ...(mai ? { sourceArtifactVersionId: IMAGE_ARTIFACT.currentVersion?.id } : { inputArtifactVersionIds: [IMAGE_ARTIFACT.currentVersion?.id] }) } });
    await expectNoAxeViolations(container);
  });
});
