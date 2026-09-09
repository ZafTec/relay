import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AuthProvider } from "../../src/auth/AuthProvider";
import { createTestAuthAdapter } from "../../src/auth/test-adapter";
import { ArtifactPreview } from "../../src/features/artifacts/ArtifactPreview";
import { ImportUrlForm } from "../../src/features/artifacts/ImportUrlForm";
import { ConnectedApps } from "../../src/features/oauth-clients/ConnectedApps";
import type {
  ArtifactSummary,
  ArtifactVersionResource,
} from "../../src/lib/api/artifacts";
import { parseOverview } from "../../src/lib/api/dashboard";
import { emptyOverviewResponse } from "../fixtures/overview";

const id = "art_" + "1".repeat(32), versionId = "aver_" + "2".repeat(32);
const version = {
  id: versionId,
  sequence: 1,
  mimeType: "image/png",
  sizeBytes: 100,
} as ArtifactVersionResource;
const artifact = {
  id,
  name: "Mountain.png",
  mediaKind: "image",
  currentVersion: version,
} as ArtifactSummary;
function mount(ui: ReactNode) {
  return render(
    <MemoryRouter>
      <AuthProvider
        adapter={createTestAuthAdapter({
          identity: {
            session: {
              id: "session",
              userId: "user",
              activeWorkspaceId: "workspace",
              expiresAt: null,
            },
            user: {
              id: "user",
              name: "Avery",
              email: "avery@example.test",
              image: null,
            },
          },
          activeWorkspace: { id: "workspace", name: "Studio", slug: "studio" },
        })}
      >
        {ui}
      </AuthProvider>
    </MemoryRouter>,
  );
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("loads private previews and obtains a new URL after a rendering failure", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn<typeof fetch>(async () =>
    json({
      kind: "authorized",
      artifactId: id,
      artifactVersionId: versionId,
      download: {
        method: "GET",
        url: "https://storage.example.test/private-image?signature=short-lived",
        expiresAt: "2031-01-01T00:00:00Z",
      },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
  mount(<ArtifactPreview artifact={artifact} detail />);
  const image = await screen.findByRole("img", {
    name: "Preview of Mountain.png",
  });
  expect(image).toHaveAttribute("referrerpolicy", "no-referrer");
  expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1]?.body as string))
    .toMatchObject({
      artifactVersionId: versionId,
      contentDisposition: "inline",
    });
  fireEvent.error(image);
  expect(await screen.findByText("Preview unavailable")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Retry preview" }));
  expect(await screen.findByRole("img", { name: "Preview of Mountain.png" }))
    .toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Download file" })).toBeEnabled();
});

it("renders text as text and never executes saved markup", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) =>
      String(input).startsWith("/api/")
        ? json({
          kind: "authorized",
          artifactId: id,
          artifactVersionId: versionId,
          download: {
            method: "GET",
            url: "https://storage.example.test/file",
            expiresAt: "2031-01-01T00:00:00Z",
          },
        })
        : new Response("<script>alert('unsafe')</script>")
    ),
  );
  const { container } = mount(
    <ArtifactPreview
      artifact={{
        ...artifact,
        name: "notes.html",
        currentVersion: { ...version, mimeType: "text/html" },
      }}
      detail
    />,
  );
  expect(await screen.findByText("<script>alert('unsafe')</script>"))
    .toBeInTheDocument();
  expect(container.querySelector("script")).toBeNull();
});

it("retries a URL import with its original key and reports the saved artifact", async () => {
  const user = userEvent.setup();
  const completed = vi.fn();
  const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(
    new TypeError("offline"),
  ).mockResolvedValueOnce(
    json(
      { kind: "authorized", artifactId: id, artifactVersionId: versionId },
      201,
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  mount(
    <ImportUrlForm
      onBusy={() => {}}
      onCompleted={completed}
      onAuthExpired={() => {}}
    />,
  );
  await user.type(
    screen.getByRole("textbox", { name: "File URL" }),
    "https://example.com/file.png",
  );
  await user.click(screen.getByRole("button", { name: "Import file" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Couldn’t confirm the import",
  );
  await user.click(screen.getByRole("button", { name: "Import file" }));
  await waitFor(() => expect(completed).toHaveBeenCalledWith(id, versionId));
  expect(fetchMock.mock.calls[0][1]?.headers).toEqual(
    fetchMock.mock.calls[1][1]?.headers,
  );
  expect(fetchMock.mock.calls[0][1]?.body).toEqual(
    fetchMock.mock.calls[1][1]?.body,
  );
});

it("shows a dynamically registered Claude connection and confirms disconnect", async () => {
  const user = userEvent.setup();
  const fetchMock = vi.fn<typeof fetch>(async (_input, init) =>
    json(
      init?.method === "DELETE" ? { disconnected: true } : {
        items: [{
          id: "consent-claude",
          clientId: "dynamic-claude",
          name: "Claude",
          workspaceId: "workspace",
          workspaceName: "Studio",
          scopes: ["tools:read"],
          connectedAt: "2026-09-09T10:00:00Z",
        }],
      },
    )
  );
  vi.stubGlobal("fetch", fetchMock);
  mount(<ConnectedApps />);
  expect(await screen.findByRole("heading", { name: "Claude" }))
    .toBeInTheDocument();
  await user.click(screen.getByText("Connection details"));
  await user.click(screen.getByRole("button", { name: "Disconnect app" }));
  expect(fetchMock.mock.calls.some((call) => call[1]?.method === "DELETE"))
    .toBe(false);
  await user.click(screen.getByRole("button", { name: "Confirm disconnect" }));
  await screen.findByText(/No apps connected yet/);
  expect(fetchMock).toHaveBeenCalledWith(
    "/api/v1/workspaces/connections/consent-claude",
    expect.objectContaining({ method: "DELETE" }),
  );
});

it("distinguishes valid empty overview data from missing or inconsistent counts", () => {
  expect(parseOverview(emptyOverviewResponse).counts.runs).toBe(0);
  expect(() => parseOverview({ name: "Relay", status: "ok" })).toThrow();
  expect(() =>
    parseOverview({
      ...emptyOverviewResponse,
      counts: { runs: 1, activeRuns: 2, failedRuns: 0, artifacts: 0 },
    })
  ).toThrow();
});
