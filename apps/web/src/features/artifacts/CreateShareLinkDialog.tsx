import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../../components/ui/Button";
import type {
  ArtifactDetail,
  CreateShareLinkAdapterResult,
  CreateShareLinkRequest,
} from "../../lib/api/artifacts";
import { createArtifactIdempotencyKey } from "./artifact-idempotency";

interface CreateShareLinkDialogProps {
  readonly artifact: ArtifactDetail;
  readonly createShareLink: (
    request: CreateShareLinkRequest,
    idempotencyKey: string,
  ) => Promise<CreateShareLinkAdapterResult>;
  readonly onAuthExpired: () => void;
  readonly onMutationBusyChange: (busy: boolean) => void;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

interface SharePolicyErrors {
  pinnedVersion?: string;
  expiresAt?: string;
}

type VersionPolicy = "follow" | "pinned";
type ExpiryPolicy = "never" | "custom";
type ContentDisposition = "inline" | "attachment";

type CreatedSecret = Extract<CreateShareLinkAdapterResult, { kind: "created" }>;

interface FrozenShareCreate {
  readonly request: CreateShareLinkRequest;
  readonly idempotencyKey: string;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), select:not(:disabled), summary:not([aria-disabled='true']), [href], [tabindex]:not([tabindex='-1'])",
  )).filter((element) => {
    if (element.closest("[hidden]") !== null) return false;
    const closedDetails = element.closest("details:not([open])");
    return closedDetails === null || element === closedDetails.querySelector("summary");
  });
}

export function CreateShareLinkDialog({
  artifact,
  createShareLink,
  onAuthExpired,
  onMutationBusyChange,
  onClose,
  onDone,
}: CreateShareLinkDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const outcomeHeadingRef = useRef<HTMLHeadingElement>(null);
  const shareUrlRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const mutationStatusRef = useRef<HTMLDivElement>(null);
  const unknownStatusRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(false);
  const createGenerationRef = useRef(0);
  const frozenCreateRef = useRef<FrozenShareCreate | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [versionPolicy, setVersionPolicy] = useState<VersionPolicy>("follow");
  const [pinnedVersionId, setPinnedVersionId] = useState(artifact.currentVersion?.id ?? "");
  const [expiryPolicy, setExpiryPolicy] = useState<ExpiryPolicy>("never");
  const [expiresAt, setExpiresAt] = useState("");
  const [contentDisposition, setContentDisposition] = useState<ContentDisposition>("inline");
  const [errors, setErrors] = useState<SharePolicyErrors>({});
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [unknownOutcome, setUnknownOutcome] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSecret | null>(null);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    activeRef.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => outcomeHeadingRef.current?.focus(), 0);

    return () => {
      activeRef.current = false;
      createGenerationRef.current += 1;
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    if (created !== null) outcomeHeadingRef.current?.focus();
  }, [created]);

  useEffect(() => {
    if (unknownOutcome !== null) unknownStatusRef.current?.focus();
  }, [unknownOutcome]);

  useEffect(() => {
    if (mutationError !== null) mutationStatusRef.current?.focus();
  }, [mutationError]);

  useEffect(() => {
    if (pending) dialogRef.current?.focus();
  }, [pending]);

  useEffect(() => {
    if (Object.keys(errors).length > 0) {
      dialogRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
    }
  }, [errors]);

  function closeDialog(discardFrozen = false) {
    if (pending || (unknownOutcome !== null && !discardFrozen)) return;
    if (created !== null || unknownOutcome !== null || refreshRequired) onDone();
    else onClose();
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
      if (event.shiftKey) last.focus();
      else first.focus();
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

  function validate(): SharePolicyErrors {
    const next: SharePolicyErrors = {};
    if (versionPolicy === "pinned" && !artifact.versions.some((version) => version.id === pinnedVersionId)) {
      next.pinnedVersion = "Choose the artifact version this link should use.";
    }
    if (expiryPolicy === "custom") {
      const parsedExpiry = Date.parse(expiresAt);
      if (expiresAt.length === 0 || !Number.isFinite(parsedExpiry)) {
        next.expiresAt = "Enter a valid expiry date and time.";
      } else if (parsedExpiry <= Date.now()) {
        next.expiresAt = "Expiry must be in the future.";
      }
    }
    return next;
  }

  async function executeCreate(operation: FrozenShareCreate) {
    if (pending || created !== null) return;
    const generation = ++createGenerationRef.current;
    let retainCreateLock = false;
    setPending(true);
    setMutationError(null);
    setUnknownOutcome(null);
    onMutationBusyChange(true);
    try {
      const result = await createShareLink(operation.request, operation.idempotencyKey);
      if (result.kind === "auth-expired") {
        onAuthExpired();
        return;
      }
      if (!activeRef.current || generation !== createGenerationRef.current) return;
      if (result.kind === "created") {
        retainCreateLock = true;
        setUnknownOutcome(null);
        setCreated(result);
        setCopyStatus("");
        return;
      }
      if (result.kind === "unknown_outcome") {
        retainCreateLock = true;
        setUnknownOutcome(result.message);
        return;
      }

      frozenCreateRef.current = null;
      setUnknownOutcome(null);
      if (result.kind === "conflict") {
        setRefreshRequired(false);
        setMutationError("This share policy conflicts with the artifact's current state. No share link was created.");
      } else if (result.kind === "idempotency-conflict") {
        retainCreateLock = true;
        setRefreshRequired(true);
        setMutationError("The idempotency key conflicts with a different request. This request cannot be retried; refresh authoritative share records before continuing.");
      } else if (result.kind === "not_found") {
        setMutationError("The artifact was not found. No share link was created.");
      } else {
        setMutationError(result.message);
      }
    } catch {
      if (!activeRef.current || generation !== createGenerationRef.current) return;
      retainCreateLock = true;
      setUnknownOutcome("Relay could not confirm whether the share link was created. Retry only this exact frozen policy with the same idempotency key.");
    } finally {
      if (activeRef.current && generation === createGenerationRef.current) {
        setPending(false);
        if (!retainCreateLock) onMutationBusyChange(false);
      }
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || created !== null || unknownOutcome !== null || refreshRequired) return;
    const nextErrors = validate();
    setErrors(nextErrors);
    setMutationError(null);
    setRefreshRequired(false);
    if (Object.keys(nextErrors).length > 0) {
      setAdvancedOpen(true);
      return;
    }

    try {
      const request = Object.freeze<CreateShareLinkRequest>({
        artifactId: artifact.id,
        followCurrent: versionPolicy === "follow",
        ...(versionPolicy === "pinned" ? { artifactVersionId: pinnedVersionId } : {}),
        expiresAt: expiryPolicy === "never" ? null : new Date(expiresAt).toISOString(),
        maxResolutions: null,
        requireAuth: false,
        contentDisposition,
      });
      const operation = Object.freeze({
        request,
        idempotencyKey: createArtifactIdempotencyKey("share-create"),
      });
      frozenCreateRef.current = operation;
      await executeCreate(operation);
    } catch (error) {
      setMutationError(error instanceof Error
        ? `Relay could not prepare a stable share request. ${error.message}`
        : "Relay could not prepare a stable share request.");
    }
  }

  async function retryExactCreate() {
    const operation = frozenCreateRef.current;
    if (operation === null || pending || created !== null) return;
    await executeCreate(operation);
  }

  async function copySecret(value: string, label: string) {
    try {
      if (navigator.clipboard?.writeText === undefined) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      if (activeRef.current) setCopyStatus(`${label} copied.`);
    } catch {
      if (!activeRef.current) return;
      const field = label === "Token" ? tokenRef.current : shareUrlRef.current;
      field?.focus();
      field?.select();
      setCopyStatus(`Copy failed. ${label} is selected so you can copy it manually.`);
    }
  }

  const shareUrl = created === null
    ? null
    : new URL(created.publicPath, window.location.origin).href;
  const descriptionId = created !== null
    ? `${id}-secret-description`
    : unknownOutcome !== null
      ? `${id}-unknown-description`
      : `${id}-description`;
  const policyLocked = pending || unknownOutcome !== null || refreshRequired;

  return (
    <div
      className="share-dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div
        ref={dialogRef}
        className="share-dialog share-link-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={descriptionId}
        aria-busy={pending || undefined}
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <div className="share-dialog__header">
          <div>
            <h2 id={`${id}-title`} ref={outcomeHeadingRef} tabIndex={-1}>
              {created !== null
                ? "Share link created"
                : unknownOutcome !== null
                  ? "Creation outcome unknown"
                  : "Create share link"}
            </h2>
            <p className="share-dialog__artifact">{artifact.name}</p>
          </div>
          <Button
            className="share-dialog__close"
            variant="quiet"
            aria-disabled={pending || undefined}
            onClick={() => closeDialog(true)}
          >
            {created !== null
              ? "Close"
              : unknownOutcome !== null
                ? "Close and inspect"
                : refreshRequired
                  ? "Close and refresh"
                  : "Close"}
          </Button>
        </div>

        {created === null ? (
          <form className="share-policy-form" onSubmit={(event) => void submit(event)} noValidate>
            <div className="share-link-access">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <ellipse cx="12" cy="12" rx="4" ry="9" />
                <path d="M3 12h18M5 6.5h14M5 17.5h14" />
              </svg>
              <div>
                <h3>Anyone with the link</h3>
                <p id={`${id}-description`}>Anyone with this link can view and download the file. No sign-in needed.</p>
              </div>
            </div>

            {unknownOutcome ? (
              <div
                ref={unknownStatusRef}
                className="share-mutation-message share-mutation-message--error"
                id={`${id}-unknown-description`}
                role="alert"
                tabIndex={-1}
              >
                <span aria-hidden="true">▲</span>
                <div>
                  <strong>Exact request retained</strong>
                  <p>{unknownOutcome}</p>
                </div>
              </div>
            ) : mutationError ? (
              <div
                ref={mutationStatusRef}
                className="share-mutation-message share-mutation-message--error"
                role="alert"
                tabIndex={-1}
              >
                <span aria-hidden="true">▲</span>
                <p>{mutationError}</p>
              </div>
            ) : null}

            <details className="share-advanced" open={advancedOpen}>
              <summary
                aria-disabled={policyLocked || undefined}
                tabIndex={policyLocked ? -1 : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  if (!policyLocked) setAdvancedOpen((open) => !open);
                }}
              >
                <span>Advanced options</span>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </summary>
              <fieldset disabled={policyLocked} hidden={!advancedOpen}>
                <legend className="sr-only">Share link policy</legend>

                <div className="share-field">
                  <label htmlFor={`${id}-version-policy`}>File version</label>
                  <select
                    id={`${id}-version-policy`}
                    value={versionPolicy}
                    onChange={(event) => {
                      setVersionPolicy(event.currentTarget.value as VersionPolicy);
                      setErrors((current) => ({ ...current, pinnedVersion: undefined }));
                    }}
                  >
                    <option value="follow">Always use the latest version</option>
                    <option value="pinned">Pin to a specific version</option>
                  </select>
                </div>

                {versionPolicy === "pinned" ? (
                  <div className="share-field">
                    <label htmlFor={`${id}-pinned-version`}>Pinned version</label>
                    <select
                      id={`${id}-pinned-version`}
                      value={pinnedVersionId}
                      onChange={(event) => {
                        setPinnedVersionId(event.currentTarget.value);
                        setErrors((current) => ({ ...current, pinnedVersion: undefined }));
                      }}
                      aria-invalid={errors.pinnedVersion ? true : undefined}
                      aria-describedby={errors.pinnedVersion ? `${id}-pinned-version-error` : undefined}
                    >
                      <option value="">Choose a version</option>
                      {[...artifact.versions]
                        .sort((left, right) => right.sequence - left.sequence)
                        .map((version) => (
                          <option value={version.id} key={version.id}>
                            Version {version.sequence}
                            {artifact.currentVersion?.id === version.id ? " (current)" : ""}
                          </option>
                        ))}
                    </select>
                    {errors.pinnedVersion ? (
                      <p id={`${id}-pinned-version-error`} className="share-field__error" role="alert">
                        {errors.pinnedVersion}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="share-policy-form__pair">
                  <div className="share-field">
                    <label htmlFor={`${id}-expiry-policy`}>Link expiry</label>
                    <select
                      id={`${id}-expiry-policy`}
                      value={expiryPolicy}
                      onChange={(event) => {
                        setExpiryPolicy(event.currentTarget.value as ExpiryPolicy);
                        setErrors((current) => ({ ...current, expiresAt: undefined }));
                      }}
                    >
                      <option value="never">Never expires</option>
                      <option value="custom">Set date and time</option>
                    </select>
                  </div>

                  <div className="share-field">
                    <label htmlFor={`${id}-resolution-policy`}>Open limit</label>
                    <select
                      id={`${id}-resolution-policy`}
                      defaultValue="unlimited"
                    >
                      <option value="unlimited">Unlimited opens</option>
                      <option value="limited" disabled>Limited opens (unavailable)</option>
                    </select>
                  </div>
                </div>

                {expiryPolicy === "custom" ? (
                  <div className="share-field">
                    <label htmlFor={`${id}-expires-at`}>Expires at</label>
                    <input
                      id={`${id}-expires-at`}
                      type="datetime-local"
                      value={expiresAt}
                      onChange={(event) => {
                        setExpiresAt(event.currentTarget.value);
                        setErrors((current) => ({ ...current, expiresAt: undefined }));
                      }}
                      aria-invalid={errors.expiresAt ? true : undefined}
                      aria-describedby={errors.expiresAt ? `${id}-expires-at-error` : undefined}
                    />
                    {errors.expiresAt ? (
                      <p id={`${id}-expires-at-error`} className="share-field__error" role="alert">
                        {errors.expiresAt}
                      </p>
                    ) : null}
                  </div>
                ) : null}

                <div className="share-field">
                  <label htmlFor={`${id}-access-policy`}>Link access</label>
                  <select
                    id={`${id}-access-policy`}
                    defaultValue="public"
                  >
                    <option value="public">Public — anyone with the link</option>
                    <option value="workspace" disabled>Workspace members only (unavailable)</option>
                  </select>
                </div>

                <div className="share-field">
                  <label htmlFor={`${id}-content-disposition`}>When opened</label>
                  <select
                    id={`${id}-content-disposition`}
                    value={contentDisposition}
                    onChange={(event) => {
                      setContentDisposition(event.currentTarget.value as ContentDisposition);
                    }}
                  >
                    <option value="inline">View in browser</option>
                    <option value="attachment">Download the file</option>
                  </select>
                </div>

              </fieldset>

              <p className="share-policy-form__warning" hidden={!advancedOpen}>
                You can revoke this link later. Downloads already started may still finish.
              </p>
            </details>

            <p className="share-policy-summary">
              {versionPolicy === "follow" ? "Latest version" : "Pinned version"}
              {" · "}{expiryPolicy === "never" ? "Never expires" : "Expires on your chosen date"}
              {" · Unlimited opens"}
            </p>

            <div className="share-dialog__actions">
              <Button variant="quiet" disabled={pending} onClick={() => closeDialog(true)}>
                {unknownOutcome !== null
                  ? "Close and inspect shares"
                  : refreshRequired
                    ? "Close and refresh"
                    : "Cancel"}
              </Button>
              {unknownOutcome === null && !refreshRequired ? (
                <Button
                  type="submit"
                  pending={pending}
                  pendingLabel="Creating link"
                >
                  Create link
                </Button>
              ) : unknownOutcome !== null ? (
                <Button
                  pending={pending}
                  pendingLabel="Retrying exact request"
                  onClick={() => void retryExactCreate()}
                >
                  Retry exact request
                </Button>
              ) : (
                <Button variant="outline" onClick={() => closeDialog(true)}>Refresh authoritative records</Button>
              )}
            </div>
          </form>
        ) : (
          <section className="share-secret" aria-label="Your share link">
            <p id={`${id}-secret-description`} className="share-secret__description">
              {created.replayed ? "Your link was recovered. " : "Your link is ready. "}
              Copy it before closing. Anyone with the link can view and download the file.
            </p>

            <div className="share-secret__field">
              <label htmlFor={`${id}-share-url`}>Share link</label>
              <input
                ref={shareUrlRef}
                id={`${id}-share-url`}
                type="text"
                value={shareUrl ?? ""}
                readOnly
                autoComplete="off"
                spellCheck={false}
                onFocus={(event) => event.currentTarget.select()}
              />
              <Button onClick={() => void copySecret(shareUrl ?? "", "Link")}>
                Copy link
              </Button>
            </div>

            <p className="share-secret__copy-status" role="status" aria-live="polite">
              {copyStatus}
            </p>

            <details className="share-advanced share-secret__details">
              <summary>
                <span>Link details</span>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </summary>
              <div className="share-secret__details-body">
                <dl className="share-secret__identity">
                  <div>
                    <dt>Share record</dt>
                    <dd><code>{created.shareLinkId}</code></dd>
                  </div>
                </dl>
                <div className="share-secret__field">
                  <label htmlFor={`${id}-token`}>Share token</label>
                  <input
                    ref={tokenRef}
                    id={`${id}-token`}
                    type="text"
                    value={created.token}
                    readOnly
                    autoComplete="off"
                    spellCheck={false}
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <Button variant="outline" onClick={() => void copySecret(created.token, "Token")}>
                    Copy token
                  </Button>
                </div>
                <p className="share-field__hint">The link includes this token. You only need it separately for API requests.</p>
              </div>
            </details>

            <div className="share-dialog__actions">
              <Button variant="outline" onClick={onDone}>Done</Button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
