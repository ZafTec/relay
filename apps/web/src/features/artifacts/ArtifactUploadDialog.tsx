import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import type {
  ArtifactSummary,
  ArtifactUploadResource,
  ArtifactsAdapter,
  CreateArtifactUploadRequest,
} from "../../lib/api/artifacts";
import {
  calculateFileHashes,
  type FileHashes,
} from "../../lib/api/file-hashes";
import { createArtifactIdempotencyKey } from "./artifact-idempotency";
import { formatBytes } from "./artifact-display";
import "./artifacts.css";

const MEDIA_KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
function mediaKindForFile(file: File): string {
  const category = file.type.split("/")[0] ?? "";
  if (["image", "audio", "video"].includes(category)) return category;
  if (file.type === "application/pdf" || category === "text") return "document";
  return "file";
}
const MIME_TYPE_PATTERN =
  /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;\s*[a-z0-9!#$&^_.+-]+=(?:[a-z0-9!#$&^_.+-]+|"[^"\r\n]*"))*$/;

type UploadStage =
  | "ready"
  | "hashing"
  | "reserving"
  | "uploading"
  | "verifying"
  | "pending"
  | "completed"
  | "error";

type RetryPhase = "reserve" | "upload" | "complete";

interface UploadErrors {
  file?: string;
  name?: string;
  mediaKind?: string;
  mimeType?: string;
}

interface FrozenUploadOperation {
  readonly file: File;
  readonly request: CreateArtifactUploadRequest;
  readonly createKey: string;
  readonly completeKey: string;
  readonly upload?: ArtifactUploadResource;
}

interface CompletedUpload {
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly replayed: boolean;
}

export interface ArtifactUploadDialogProps {
  readonly adapter: Pick<ArtifactsAdapter, "createUpload" | "putUpload" | "completeUpload">;
  readonly artifact?: Pick<ArtifactSummary, "id" | "name">;
  readonly calculateHashes?: (file: Blob) => Promise<FileHashes>;
  readonly onAuthExpired: () => void;
  readonly onClose: () => void;
  readonly onCompleted?: (artifactId: string, artifactVersionId: string) => void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
  )).filter((element) => !element.hasAttribute("hidden"));
}

function freezeRequest(
  artifact: ArtifactUploadDialogProps["artifact"],
  file: File,
  name: string,
  mediaKind: string,
  mimeType: string,
  hashes: FileHashes,
): CreateArtifactUploadRequest {
  const target = artifact === undefined
    ? Object.freeze({
        kind: "new_artifact" as const,
        name: name.trim(),
        mediaKind: mediaKind.trim(),
      })
    : Object.freeze({ kind: "new_version" as const, artifactId: artifact.id });
  return Object.freeze({
    target,
    sizeBytes: file.size,
    mimeType: mimeType.trim(),
    sha256: hashes.sha256,
    contentMd5: hashes.contentMd5,
  });
}

function statusTitle(stage: UploadStage): string {
  switch (stage) {
    case "hashing":
      return "Hashing file";
    case "reserving":
      return "Reserving upload";
    case "uploading":
      return "Uploading bytes";
    case "verifying":
      return "Verifying upload";
    case "pending":
      return "Verification pending";
    case "completed":
      return "Upload complete";
    case "error":
      return "Upload needs attention";
    case "ready":
      return "Ready to upload";
  }
}

function statusMessage(stage: UploadStage): string {
  switch (stage) {
    case "hashing":
      return "Calculating SHA-256 and MD5 in this browser. File bytes have not been sent.";
    case "reserving":
      return "Sending the frozen metadata request with its stable idempotency key.";
    case "uploading":
      return "Sending the selected file with the exact signed upload authorization.";
    case "verifying":
      return "Requesting upload completion with a separate stable idempotency key.";
    case "pending":
      return "Relay accepted the completion request, but verification is still pending.";
    case "completed":
      return "Relay completed the artifact upload.";
    case "error":
      return "The upload did not complete.";
    case "ready":
      return "Choose a file and review its artifact metadata.";
  }
}

export function ArtifactUploadDialog({
  adapter,
  artifact,
  calculateHashes = calculateFileHashes,
  onAuthExpired,
  onClose,
  onCompleted,
}: ArtifactUploadDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const outcomeHeadingRef = useRef<HTMLHeadingElement>(null);
  const operationRef = useRef<FrozenUploadOperation | null>(null);
  const activeRef = useRef(false);
  const generationRef = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [mediaKind, setMediaKind] = useState("");
  const [mimeType, setMimeType] = useState("");
  const [errors, setErrors] = useState<UploadErrors>({});
  const [stage, setStage] = useState<UploadStage>("ready");
  const [message, setMessage] = useState("");
  const [retryPhase, setRetryPhase] = useState<RetryPhase | null>(null);
  const [completed, setCompleted] = useState<CompletedUpload | null>(null);

  const busy = stage === "hashing"
    || stage === "reserving"
    || stage === "uploading"
    || stage === "verifying";

  useEffect(() => {
    activeRef.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => fileInputRef.current?.focus(), 0);

    return () => {
      activeRef.current = false;
      generationRef.current += 1;
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (stage === "pending" || stage === "completed" || stage === "error") {
      outcomeHeadingRef.current?.focus();
    } else if (busy) {
      dialogRef.current?.focus();
    }
  }, [busy, stage]);

  function isCurrent(generation: number): boolean {
    return activeRef.current && generation === generationRef.current;
  }

  function closeDialog(discardFrozen = false) {
    if (busy) return;
    if (operationRef.current !== null && completed === null && !discardFrozen) return;
    if (completed !== null) {
      onCompleted?.(completed.artifactId, completed.artifactVersionId);
    }
    onClose();
  }

  function handleDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeDialog();
      return;
    }
    if (event.key !== "Tab" || dialogRef.current === null) return;

    const focusable = focusableElements(dialogRef.current);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    if (!focusable.includes(document.activeElement as HTMLElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function validate(): UploadErrors {
    const next: UploadErrors = {};
    if (file === null) next.file = "Choose the file to upload.";
    if (artifact === undefined) {
      const trimmedName = name.trim();
      if (trimmedName.length === 0) next.name = "Enter an artifact name.";
      else if (trimmedName.length > 255) next.name = "Artifact name must be 255 characters or fewer.";
      if (!MEDIA_KIND_PATTERN.test(mediaKind.trim())) {
        next.mediaKind = "Use a lowercase media kind with letters, numbers, dots, underscores, or hyphens.";
      }
    }
    const trimmedMimeType = mimeType.trim();
    if (trimmedMimeType.length === 0) next.mimeType = "Enter the file MIME type.";
    else if (trimmedMimeType.length > 255 || !MIME_TYPE_PATTERN.test(trimmedMimeType)) {
      next.mimeType = "Enter a valid MIME type such as image/png or text/plain.";
    }
    return next;
  }

  function fail(
    nextMessage: string,
    nextRetryPhase: RetryPhase | null,
    generation: number,
  ) {
    if (!isCurrent(generation)) return;
    setMessage(nextMessage);
    setRetryPhase(nextRetryPhase);
    setStage("error");
  }

  function finish(
    result: CompletedUpload,
    generation: number,
    nextMessage?: string,
  ) {
    if (!isCurrent(generation)) return;
    setCompleted(result);
    setMessage(nextMessage ?? (result.replayed
      ? "Relay replayed the stored completion result; no duplicate version was created."
      : "Relay completed the upload and created an immutable artifact version."));
    setRetryPhase(null);
    setStage("completed");
  }

  async function completeUpload(operation: FrozenUploadOperation, generation: number) {
    if (operation.upload === undefined) {
      fail("The frozen upload reservation is unavailable.", null, generation);
      return;
    }
    setStage("verifying");
    setMessage("");
    setRetryPhase(null);

    try {
      const result = await adapter.completeUpload(operation.upload.id, operation.completeKey);
      if (!isCurrent(generation)) return;
      if (result.kind === "auth-expired") {
        fail("Your session expired before Relay could confirm completion.", null, generation);
        onAuthExpired();
      } else if (result.kind === "completed") {
        finish({
          artifactId: result.artifactId,
          artifactVersionId: result.artifactVersionId,
          replayed: result.replayed,
        }, generation);
      } else if (result.kind === "pending") {
        setMessage(statusMessage("pending"));
        setRetryPhase("complete");
        setStage("pending");
      } else if (result.kind === "unknown_outcome") {
        fail(result.message, "complete", generation);
      } else if (result.kind === "verification-failed") {
        fail(`Relay could not verify the uploaded bytes (${result.reason}).`, null, generation);
      } else if (result.kind === "idempotency-conflict") {
        fail("The completion idempotency key conflicts with a different request. The frozen completion request cannot be retried.", null, generation);
      } else if (result.kind === "not_found") {
        fail("Relay could not find the upload reservation during completion.", null, generation);
      } else {
        fail(result.message, null, generation);
      }
    } catch {
      fail(
        "Relay could not confirm the completion result. Retry only this exact frozen completion request with the same idempotency key.",
        "complete",
        generation,
      );
    }
  }

  async function uploadBytes(operation: FrozenUploadOperation, generation: number) {
    const authorization = operation.upload?.authorization;
    if (authorization === undefined || authorization === null) {
      fail("The frozen signed upload authorization is unavailable.", null, generation);
      return;
    }
    setStage("uploading");
    setMessage("");
    setRetryPhase(null);

    try {
      const result = await adapter.putUpload(authorization, operation.file);
      if (!isCurrent(generation)) return;
      if (result.kind === "uploaded") {
        await completeUpload(operation, generation);
      } else if (result.kind === "unknown_outcome") {
        fail(result.message, "upload", generation);
      } else if (result.kind === "authorization-expired") {
        fail("The signed upload authorization expired before Relay confirmed the file transfer.", null, generation);
      } else if (result.kind === "rejected") {
        fail(`The signed upload request was rejected with HTTP status ${result.status}.`, null, generation);
      } else {
        fail(result.message, null, generation);
      }
    } catch {
      fail(
        "Relay could not confirm the file transfer. Retry only the exact file and signed authorization retained in this panel.",
        "upload",
        generation,
      );
    }
  }

  async function reserveUpload(operation: FrozenUploadOperation, generation: number) {
    setStage("reserving");
    setMessage("");
    setRetryPhase(null);

    try {
      const result = await adapter.createUpload(operation.request, operation.createKey);
      if (!isCurrent(generation)) return;
      if (result.kind === "auth-expired") {
        fail("Your session expired before Relay could reserve the upload.", null, generation);
        onAuthExpired();
      } else if (result.kind === "created") {
        const nextOperation = Object.freeze({ ...operation, upload: result.upload });
        operationRef.current = nextOperation;
        if (result.upload.status === "completed") {
          finish({
            artifactId: result.upload.artifactId,
            artifactVersionId: result.upload.artifactVersionId,
            replayed: result.replayed,
          }, generation, result.replayed
            ? "Relay replayed a completed upload reservation; no file bytes were sent again."
            : "Relay returned a completed upload reservation; no file bytes were sent again.");
        } else if (result.upload.status !== "pending") {
          fail(`The retained upload reservation is ${result.upload.status}.`, null, generation);
        } else {
          await uploadBytes(nextOperation, generation);
        }
      } else if (result.kind === "unknown_outcome") {
        fail(result.message, "reserve", generation);
      } else if (result.kind === "idempotency-conflict") {
        fail("The upload reservation idempotency key conflicts with a different request. The frozen reservation cannot be retried.", null, generation);
      } else if (result.kind === "quota-exceeded") {
        fail("The upload quota was exceeded. No file bytes were sent.", null, generation);
      } else if (result.kind === "not_found") {
        fail("Relay could not find the requested upload target. No file bytes were sent.", null, generation);
      } else {
        fail(result.message, null, generation);
      }
    } catch {
      fail(
        "Relay could not confirm the upload reservation. Retry only this exact frozen metadata request with the same idempotency key.",
        "reserve",
        generation,
      );
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (stage !== "ready") return;
    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || file === null) return;

    const generation = ++generationRef.current;
    setStage("hashing");
    setMessage("");
    setRetryPhase(null);
    let hashes: FileHashes;
    try {
      hashes = await calculateHashes(file);
    } catch (error) {
      fail(
        error instanceof Error
          ? `Relay could not calculate the file hashes. ${error.message}`
          : "Relay could not calculate the file hashes in this browser.",
        null,
        generation,
      );
      return;
    }
    if (!isCurrent(generation)) return;

    let operation: FrozenUploadOperation;
    try {
      const request = freezeRequest(artifact, file, name, mediaKind, mimeType, hashes);
      operation = Object.freeze({
        file,
        request,
        createKey: createArtifactIdempotencyKey("upload-create"),
        completeKey: createArtifactIdempotencyKey("upload-complete"),
      });
    } catch (error) {
      fail(
        error instanceof Error
          ? `Relay could not prepare stable upload keys. ${error.message}`
          : "Relay could not prepare stable upload keys in this browser.",
        null,
        generation,
      );
      return;
    }
    operationRef.current = operation;
    await reserveUpload(operation, generation);
  }

  async function retryFrozen() {
    const operation = operationRef.current;
    const phase = retryPhase;
    if (operation === null || phase === null || busy) return;
    const generation = ++generationRef.current;
    if (phase === "reserve") await reserveUpload(operation, generation);
    else if (phase === "upload") await uploadBytes(operation, generation);
    else await completeUpload(operation, generation);
  }

  function discardFrozenRequest() {
    if (busy) return;
    generationRef.current += 1;
    operationRef.current = null;
    setCompleted(null);
    setMessage("");
    setRetryPhase(null);
    setStage("ready");
    window.setTimeout(() => fileInputRef.current?.focus(), 0);
  }

  const title = artifact === undefined ? "Upload artifact" : `Upload a new version of ${artifact.name}`;
  const descriptionId = `${id}-description`;
  const statusId = `${id}-status`;

  return (
    <div
      className="share-dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div
        ref={dialogRef}
        className="share-dialog artifact-upload-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={completed === null ? descriptionId : statusId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="share-dialog__header">
          <div>
            <h2
              id={`${id}-title`}
              ref={outcomeHeadingRef}
              tabIndex={stage === "pending" || stage === "completed" || stage === "error" ? -1 : undefined}
            >
              {stage === "completed" ? "Artifact uploaded" : title}
            </h2>
          </div>
          <Button
            className="share-dialog__close"
            variant="quiet"
            disabled={busy}
            onClick={() => closeDialog(true)}
          >
            {completed !== null ? "Close" : operationRef.current === null ? "Close" : "Discard and close"}
          </Button>
        </div>

        {completed !== null ? (
          <section className="artifact-upload-complete" aria-labelledby={`${id}-complete-title`}>
            <div className="artifact-upload-status artifact-upload-status--success" id={statusId} role="status" aria-live="polite">
              <span className="artifact-upload-status__marker" aria-hidden="true" />
              <div>
                <h3 id={`${id}-complete-title`}>{statusTitle("completed")}</h3>
                <p>{message}</p>
              </div>
            </div>
            <dl className="artifact-upload-summary">
              <div>
                <dt>Artifact</dt>
                <dd><code>{completed.artifactId}</code></dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd><code>{completed.artifactVersionId}</code></dd>
              </div>
            </dl>
            <div className="artifact-upload-complete__actions">
              <Button variant="quiet" onClick={() => closeDialog()}>Close</Button>
              <Link
                className="button button--accent"
                to={`/dashboard/artifacts/${encodeURIComponent(completed.artifactId)}`}
                onClick={() => closeDialog()}
              >
                <span className="button__label">Open artifact</span>
              </Link>
            </div>
          </section>
        ) : (
          <form className="artifact-upload-form" onSubmit={(event) => void submit(event)} noValidate>
            <p id={descriptionId} className="artifact-upload-form__intro">
              {artifact === undefined
                ? "Choose a file to add to your workspace. Give it a name so it is easy to find and use in a tool."
                : "Choose a file for the next version. Previous versions remain available."}
            </p>

            {stage !== "ready" ? (
              <div
                className={`artifact-upload-status${stage === "error" ? " artifact-upload-status--error" : ""}`}
                id={statusId}
                role={stage === "error" ? "alert" : "status"}
                aria-live={stage === "error" ? "assertive" : "polite"}
              >
                <span className="artifact-upload-status__marker" aria-hidden="true" />
                <div>
                  <h3>{statusTitle(stage)}</h3>
                  <p>{message || statusMessage(stage)}</p>
                  {stage === "pending" || (stage === "error" && retryPhase !== null) ? (
                    <div className="artifact-upload-status__actions">
                      <Button
                        pending={busy}
                        pendingLabel="Retrying exact request"
                        onClick={() => void retryFrozen()}
                      >
                        {stage === "pending" ? "Check verification again" : "Retry exact request"}
                      </Button>
                      <Button variant="quiet" onClick={discardFrozenRequest}>
                        Discard frozen request
                      </Button>
                    </div>
                  ) : stage === "error" ? (
                    <div className="artifact-upload-status__actions">
                      <Button variant="outline" onClick={discardFrozenRequest}>Review upload</Button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            <fieldset disabled={stage !== "ready"}>
              <legend className="sr-only">Artifact upload details</legend>
              <div className="artifact-upload-field artifact-upload-field--file">
                <label htmlFor={`${id}-file`}>File</label>
                <input
                  ref={fileInputRef}
                  id={`${id}-file`}
                  type="file"
                  onChange={(event) => {
                    const nextFile = event.currentTarget.files?.[0] ?? null;
                    const previousFileName = file?.name ?? "";
                    setFile(nextFile);
                    if (nextFile !== null) {
                      setMimeType(nextFile.type);
                      if (artifact === undefined && (mediaKind === "" || (file !== null && mediaKind === mediaKindForFile(file)))) {
                        setMediaKind(mediaKindForFile(nextFile));
                      }
                      if (artifact === undefined && (name.trim().length === 0 || name === previousFileName)) {
                        setName(nextFile.name);
                      }
                    }
                    setErrors((current) => ({ ...current, file: undefined, mimeType: undefined }));
                  }}
                  aria-invalid={errors.file ? true : undefined}
                  aria-describedby={errors.file ? `${id}-file-error` : file !== null ? `${id}-file-summary` : undefined}
                />
                {errors.file ? (
                  <p id={`${id}-file-error`} className="artifact-upload-field__error" role="alert">{errors.file}</p>
                ) : file !== null ? (
                  <p id={`${id}-file-summary`} className="artifact-upload-field__hint">
                    {file.name} · {formatBytes(file.size)}
                  </p>
                ) : null}
              </div>

              {artifact === undefined ? (
                <div className="artifact-upload-form__pair">
                  <div className="artifact-upload-field">
                    <label htmlFor={`${id}-name`}>Artifact name</label>
                    <input
                      id={`${id}-name`}
                      value={name}
                      onChange={(event) => {
                        setName(event.currentTarget.value);
                        setErrors((current) => ({ ...current, name: undefined }));
                      }}
                      aria-invalid={errors.name ? true : undefined}
                      aria-describedby={errors.name ? `${id}-name-error` : undefined}
                    />
                    {errors.name ? (
                      <p id={`${id}-name-error`} className="artifact-upload-field__error" role="alert">{errors.name}</p>
                    ) : null}
                  </div>
                  <div className="artifact-upload-field">
                    <label htmlFor={`${id}-media-kind`}>Media kind</label>
                    <input
                      id={`${id}-media-kind`}
                      value={mediaKind}
                      onChange={(event) => {
                        setMediaKind(event.currentTarget.value);
                        setErrors((current) => ({ ...current, mediaKind: undefined }));
                      }}
                      placeholder="image"
                      aria-invalid={errors.mediaKind ? true : undefined}
                      aria-describedby={errors.mediaKind ? `${id}-media-kind-error` : undefined}
                    />
                    {errors.mediaKind ? (
                      <p id={`${id}-media-kind-error`} className="artifact-upload-field__error" role="alert">{errors.mediaKind}</p>
                    ) : null}
                  </div>
                </div>
              ) : (
                <dl className="artifact-upload-target">
                  <div>
                    <dt>Target artifact</dt>
                    <dd>{artifact.name}</dd>
                  </div>
                  <div>
                    <dt>Artifact ID</dt>
                    <dd><code>{artifact.id}</code></dd>
                  </div>
                </dl>
              )}

              <div className="artifact-upload-field">
                <label htmlFor={`${id}-mime-type`}>MIME type</label>
                <input
                  id={`${id}-mime-type`}
                  value={mimeType}
                  onChange={(event) => {
                    setMimeType(event.currentTarget.value);
                    setErrors((current) => ({ ...current, mimeType: undefined }));
                  }}
                  placeholder="application/octet-stream"
                  spellCheck={false}
                  aria-invalid={errors.mimeType ? true : undefined}
                  aria-describedby={errors.mimeType ? `${id}-mime-type-error` : `${id}-mime-type-hint`}
                />
                {errors.mimeType ? (
                  <p id={`${id}-mime-type-error`} className="artifact-upload-field__error" role="alert">{errors.mimeType}</p>
                ) : (
                  <p id={`${id}-mime-type-hint`} className="artifact-upload-field__hint">
                    Review this value when the browser does not identify the file type.
                  </p>
                )}
              </div>
            </fieldset>

            <div className="share-dialog__actions">
              <Button variant="quiet" disabled={busy} onClick={() => closeDialog(true)}>
                {operationRef.current === null ? "Cancel" : "Discard and close"}
              </Button>
              <Button
                type="submit"
                pending={busy}
                pendingLabel={statusTitle(stage)}
                disabled={stage !== "ready"}
              >
                {artifact === undefined ? "Upload artifact" : "Upload new version"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
