import axe from "axe-core";
import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactUploadDialog,
  type ArtifactUploadDialogProps,
} from "../../src/features/artifacts/ArtifactUploadDialog";
import type {
  ArtifactSummary,
  ArtifactUploadResource,
  ArtifactsAdapter,
  CompleteArtifactUploadAdapterResult,
  CreateArtifactUploadAdapterResult,
} from "../../src/lib/api/artifacts";
import type { FileHashes } from "../../src/lib/api/file-hashes";

const ARTIFACT_ID = "art_11111111111111111111111111111111";
const VERSION_ID = "aver_22222222222222222222222222222222";
const UPLOAD_ID = "upl_33333333333333333333333333333333";
const SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CONTENT_MD5 = "AAAAAAAAAAAAAAAAAAAAAA==";

const authorization = {
  method: "PUT" as const,
  url: "https://objects.example.test/upload?signature=opaque",
  expiresAt: "2099-01-01T00:00:00.000Z",
  requiredHeaders: {
    "content-length": "5",
    "content-type": "text/plain",
    "content-md5": CONTENT_MD5,
    "x-upload-checksum": SHA256,
  },
};

const upload: ArtifactUploadResource = {
  id: UPLOAD_ID,
  artifactId: ARTIFACT_ID,
  artifactVersionId: VERSION_ID,
  sequence: 1,
  status: "pending",
  authorization,
};

const artifact: Pick<ArtifactSummary, "id" | "name"> = {
  id: ARTIFACT_ID,
  name: "Campaign master",
};

type UploadAdapter = Pick<ArtifactsAdapter, "createUpload" | "putUpload" | "completeUpload">;

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createUploadAdapter(overrides: Partial<UploadAdapter> = {}): UploadAdapter {
  return {
    createUpload: vi.fn(async () => ({
      kind: "degraded",
      message: "Unexpected reservation call.",
    })),
    putUpload: vi.fn(async () => ({
      kind: "degraded",
      message: "Unexpected upload call.",
    })),
    completeUpload: vi.fn(async () => ({
      kind: "degraded",
      message: "Unexpected completion call.",
    })),
    ...overrides,
  };
}

interface UploadHarnessProps {
  readonly adapter: UploadAdapter;
  readonly artifact?: Pick<ArtifactSummary, "id" | "name">;
  readonly calculateHashes: NonNullable<ArtifactUploadDialogProps["calculateHashes"]>;
  readonly onCompleted?: (artifactId: string, artifactVersionId: string) => void;
}

function UploadHarness({
  adapter,
  artifact: targetArtifact,
  calculateHashes,
  onCompleted,
}: UploadHarnessProps) {
  const [open, setOpen] = useState(false);
  return (
    <MemoryRouter>
      <button type="button" onClick={() => setOpen(true)}>
        {targetArtifact === undefined ? "Open artifact upload" : "Open version upload"}
      </button>
      {open ? (
        <ArtifactUploadDialog
          adapter={adapter}
          artifact={targetArtifact}
          calculateHashes={calculateHashes}
          onAuthExpired={vi.fn()}
          onClose={() => setOpen(false)}
          onCompleted={onCompleted}
        />
      ) : null}
    </MemoryRouter>
  );
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(results.violations).toEqual([]);
}

async function chooseNewArtifact(
  user: ReturnType<typeof userEvent.setup>,
  file = new File(["hello"], "hello.txt", { type: "text/plain" }),
) {
  await user.upload(screen.getByLabelText("File"), file);
  await user.clear(screen.getByLabelText("Media kind"));
  await user.type(screen.getByLabelText("Media kind"), "text");
  return file;
}

describe("ArtifactUploadDialog", () => {
  it("runs hashing, reservation, signed upload, pending verification, and completion", async () => {
    const user = userEvent.setup();
    const hashes = deferred<FileHashes>();
    const reservation = deferred<CreateArtifactUploadAdapterResult>();
    const transfer = deferred<Awaited<ReturnType<UploadAdapter["putUpload"]>>>();
    const firstCompletion = deferred<CompleteArtifactUploadAdapterResult>();
    const secondCompletion = deferred<CompleteArtifactUploadAdapterResult>();
    const createUpload = vi.fn(() => reservation.promise);
    const putUpload = vi.fn(() => transfer.promise);
    const completeUpload = vi.fn()
      .mockReturnValueOnce(firstCompletion.promise)
      .mockReturnValueOnce(secondCompletion.promise);
    const onCompleted = vi.fn();
    const adapter = createUploadAdapter({ createUpload, putUpload, completeUpload });
    const { container } = render(
      <UploadHarness
        adapter={adapter}
        calculateHashes={() => hashes.promise}
        onCompleted={onCompleted}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Open artifact upload" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Upload artifact" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("File")).toHaveFocus());
    const file = await chooseNewArtifact(user);
    expect(screen.getByLabelText("Artifact name")).toHaveValue("hello.txt");
    expect(screen.getByLabelText("MIME type")).toHaveValue("text/plain");

    await user.click(screen.getByRole("button", { name: "Upload artifact" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Hashing file" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await act(async () => hashes.resolve({ sha256: SHA256, contentMd5: CONTENT_MD5 }));
    expect(await screen.findByRole("heading", { level: 3, name: "Reserving upload" })).toBeInTheDocument();
    expect(createUpload).toHaveBeenCalledTimes(1);
    const [request, createKey] = createUpload.mock.calls[0]!;
    expect(request).toEqual({
      target: { kind: "new_artifact", name: "hello.txt", mediaKind: "text" },
      sizeBytes: 5,
      mimeType: "text/plain",
      sha256: SHA256,
      contentMd5: CONTENT_MD5,
    });
    expect(createKey).toMatch(/^artifact-ui:upload-create:/);

    await act(async () => reservation.resolve({ kind: "created", upload, replayed: false }));
    expect(await screen.findByRole("heading", { level: 3, name: "Uploading bytes" })).toBeInTheDocument();
    expect(putUpload).toHaveBeenCalledWith(authorization, file);
    expect(putUpload.mock.calls[0]?.[0]).toBe(authorization);
    expect(putUpload.mock.calls[0]?.[1]).toBe(file);

    await act(async () => transfer.resolve({ kind: "uploaded", status: 200 }));
    expect(await screen.findByRole("heading", { level: 3, name: "Verifying upload" })).toBeInTheDocument();
    expect(completeUpload).toHaveBeenCalledTimes(1);
    const completeKey = completeUpload.mock.calls[0]?.[1];
    expect(completeUpload).toHaveBeenCalledWith(UPLOAD_ID, expect.stringMatching(/^artifact-ui:upload-complete:/));
    expect(completeKey).not.toBe(createKey);

    await act(async () => firstCompletion.resolve({ kind: "pending", replayed: false }));
    expect(await screen.findByRole("heading", { level: 3, name: "Verification pending" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Upload artifact" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Check verification again" }));
    expect(await screen.findByRole("heading", { level: 3, name: "Verifying upload" })).toBeInTheDocument();
    expect(completeUpload).toHaveBeenCalledTimes(2);
    expect(completeUpload.mock.calls[1]?.[1]).toBe(completeKey);

    await act(async () => secondCompletion.resolve({
      kind: "completed",
      artifactId: ARTIFACT_ID,
      artifactVersionId: VERSION_ID,
      becameCurrent: true,
      replayed: true,
    }));
    expect(await screen.findByRole("heading", { name: "Artifact uploaded" })).toHaveFocus();
    expect(screen.getByText(/replayed the stored completion result/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open artifact" })).toHaveAttribute(
      "href",
      `/dashboard/artifacts/${ARTIFACT_ID}`,
    );
    await expectNoAxeViolations(container);

    await user.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(onCompleted).toHaveBeenCalledWith(ARTIFACT_ID, VERSION_ID);
    expect(trigger).toHaveFocus();
  });

  it("retries ambiguous reservation and completion outcomes with the exact frozen values", async () => {
    const user = userEvent.setup();
    const unknown = {
      kind: "unknown_outcome" as const,
      message: "Relay could not confirm the result. Retry only the exact request.",
      retryable: true as const,
      retryMode: "exact-request" as const,
      retryAfterSeconds: null,
    };
    const createUpload = vi.fn()
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce({ kind: "created" as const, upload, replayed: true });
    const putUpload = vi.fn(async () => ({ kind: "uploaded" as const, status: 200 }));
    const completeUpload = vi.fn()
      .mockResolvedValueOnce(unknown)
      .mockResolvedValueOnce({
        kind: "completed" as const,
        artifactId: ARTIFACT_ID,
        artifactVersionId: VERSION_ID,
        becameCurrent: true,
        replayed: true,
      });
    const adapter = createUploadAdapter({ createUpload, putUpload, completeUpload });
    render(
      <UploadHarness
        adapter={adapter}
        calculateHashes={async () => ({ sha256: SHA256, contentMd5: CONTENT_MD5 })}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Open artifact upload" }));
    await chooseNewArtifact(user);
    await user.click(screen.getByRole("button", { name: "Upload artifact" }));

    expect(await screen.findByText("Upload needs attention")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Retry only the exact request");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog", { name: "Upload artifact" })).toBeInTheDocument();
    const [request, createKey] = createUpload.mock.calls[0]!;
    await user.click(screen.getByRole("button", { name: "Retry exact request" }));

    await waitFor(() => expect(createUpload).toHaveBeenCalledTimes(2));
    expect(createUpload.mock.calls[1]?.[0]).toBe(request);
    expect(createUpload.mock.calls[1]?.[1]).toBe(createKey);
    expect(putUpload).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Upload needs attention")).toBeInTheDocument();
    const [uploadId, completeKey] = completeUpload.mock.calls[0]!;

    await user.click(screen.getByRole("button", { name: "Retry exact request" }));
    expect(await screen.findByRole("heading", { name: "Artifact uploaded" })).toBeInTheDocument();
    expect(completeUpload).toHaveBeenCalledTimes(2);
    expect(completeUpload.mock.calls[1]?.[0]).toBe(uploadId);
    expect(completeUpload.mock.calls[1]?.[1]).toBe(completeKey);
  });

  it("targets a new version and distinguishes an idempotency conflict from a retryable outcome", async () => {
    const user = userEvent.setup();
    const createUpload = vi.fn(async () => ({
      kind: "idempotency-conflict" as const,
      message: "This idempotency key was already used for a different request.",
    }));
    const adapter = createUploadAdapter({ createUpload });
    const { container } = render(
      <UploadHarness
        adapter={adapter}
        artifact={artifact}
        calculateHashes={async () => ({ sha256: SHA256, contentMd5: CONTENT_MD5 })}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Open version upload" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", {
      name: "Upload a new version of Campaign master",
    })).toBeInTheDocument();
    expect(screen.queryByLabelText("Artifact name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Media kind")).not.toBeInTheDocument();
    await user.upload(
      screen.getByLabelText("File"),
      new File(["hello"], "replacement.txt", { type: "text/plain" }),
    );
    await user.click(screen.getByRole("button", { name: "Upload new version" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("idempotency key conflicts with a different request");
    expect(screen.queryByRole("button", { name: "Retry exact request" })).not.toBeInTheDocument();
    expect(createUpload.mock.calls[0]?.[0]).toMatchObject({
      target: { kind: "new_version", artifactId: ARTIFACT_ID },
      sizeBytes: 5,
      mimeType: "text/plain",
    });
    await expectNoAxeViolations(container);

    await user.click(screen.getByRole("button", { name: "Review upload" }));
    expect(screen.getByLabelText("File")).toBeEnabled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});
