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
  versionPolicy?: string;
  pinnedVersion?: string;
  expiryPolicy?: string;
  expiresAt?: string;
  resolutionPolicy?: string;
  maxResolutions?: string;
  accessPolicy?: string;
  contentDisposition?: string;
}

type VersionPolicy = "" | "follow" | "pinned";
type ExpiryPolicy = "" | "never" | "custom";
type ResolutionPolicy = "" | "unlimited" | "limited";
type AccessPolicy = "" | "public";
type ContentDisposition = "" | "inline" | "attachment";

type CreatedSecret = Extract<CreateShareLinkAdapterResult, { kind: "created" }>;

interface FrozenShareCreate {
  readonly request: CreateShareLinkRequest;
  readonly idempotencyKey: string;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
  )).filter((element) => !element.hasAttribute("hidden"));
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
  const firstFieldRef = useRef<HTMLSelectElement>(null);
  const outcomeHeadingRef = useRef<HTMLHeadingElement>(null);
  const mutationStatusRef = useRef<HTMLDivElement>(null);
  const unknownStatusRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef(false);
  const createGenerationRef = useRef(0);
  const frozenCreateRef = useRef<FrozenShareCreate | null>(null);
  const [versionPolicy, setVersionPolicy] = useState<VersionPolicy>("");
  const [pinnedVersionId, setPinnedVersionId] = useState("");
  const [expiryPolicy, setExpiryPolicy] = useState<ExpiryPolicy>("");
  const [expiresAt, setExpiresAt] = useState("");
  const [resolutionPolicy, setResolutionPolicy] = useState<ResolutionPolicy>("");
  const [maxResolutions, setMaxResolutions] = useState("");
  const [accessPolicy, setAccessPolicy] = useState<AccessPolicy>("");
  const [contentDisposition, setContentDisposition] = useState<ContentDisposition>("");
  const [errors, setErrors] = useState<SharePolicyErrors>({});
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [unknownOutcome, setUnknownOutcome] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedSecret | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");

  useEffect(() => {
    activeRef.current = true;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 0);

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
    if (versionPolicy === "") next.versionPolicy = "Choose whether this link follows the current version or stays pinned.";
    if (versionPolicy === "pinned" && !artifact.versions.some((version) => version.id === pinnedVersionId)) {
      next.pinnedVersion = "Choose the artifact version this link should use.";
    }
    if (expiryPolicy === "") next.expiryPolicy = "Choose an explicit expiry policy.";
    if (expiryPolicy === "custom") {
      const parsedExpiry = Date.parse(expiresAt);
      if (expiresAt.length === 0 || !Number.isFinite(parsedExpiry)) {
        next.expiresAt = "Enter a valid expiry date and time.";
      } else if (parsedExpiry <= Date.now()) {
        next.expiresAt = "Expiry must be in the future.";
      }
    }
    if (resolutionPolicy === "") next.resolutionPolicy = "Choose an explicit resolution limit policy.";
    if (resolutionPolicy === "limited") {
      const parsedLimit = Number(maxResolutions);
      if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1) {
        next.maxResolutions = "Resolution limit must be a whole number greater than zero.";
      }
    }
    if (accessPolicy !== "public") {
      next.accessPolicy = "Choose public bearer access to create this share link.";
    }
    if (contentDisposition === "") {
      next.contentDisposition = "Choose whether Relay opens the artifact inline or downloads it.";
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
    if (Object.keys(nextErrors).length > 0) return;

    try {
      const request = Object.freeze<CreateShareLinkRequest>({
        artifactId: artifact.id,
        followCurrent: versionPolicy === "follow",
        ...(versionPolicy === "pinned" ? { artifactVersionId: pinnedVersionId } : {}),
        expiresAt: expiryPolicy === "never" ? null : new Date(expiresAt).toISOString(),
        maxResolutions: resolutionPolicy === "unlimited" ? null : Number(maxResolutions),
        requireAuth: false,
        contentDisposition: contentDisposition as "inline" | "attachment",
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
      setRevealed(true);
      setCopyStatus(`Copy failed. ${label} is now visible so you can select it manually.`);
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

  return (
    <div
      className="share-dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <div
        ref={dialogRef}
        className="share-dialog"
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
            <p className="mono-label">Managed share</p>
            <h2 id={`${id}-title`} ref={outcomeHeadingRef} tabIndex={created === null ? undefined : -1}>
              {created !== null
                ? "Share link created"
                : unknownOutcome !== null
                  ? "Creation outcome unknown"
                  : "Create share link"}
            </h2>
          </div>
          <Button
            className="share-dialog__close"
            variant="quiet"
            aria-disabled={pending || undefined}
            onClick={() => closeDialog(true)}
          >
            {created !== null
              ? "Clear and close"
              : unknownOutcome !== null
                ? "Close and inspect"
                : refreshRequired
                  ? "Close and refresh"
                  : "Close"}
          </Button>
        </div>

        {created === null ? (
          <form className="share-policy-form" onSubmit={(event) => void submit(event)} noValidate>
            <p id={`${id}-description`} className="share-policy-form__intro">
              Set every policy explicitly. Relay shows the public share URL and token once after creation.
            </p>

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

            <fieldset disabled={pending || unknownOutcome !== null || refreshRequired}>
              <legend className="sr-only">Share link policy</legend>

              <div className="share-field">
                <label htmlFor={`${id}-version-policy`}>Version policy</label>
                <select
                  ref={firstFieldRef}
                  id={`${id}-version-policy`}
                  value={versionPolicy}
                  onChange={(event) => {
                    setVersionPolicy(event.currentTarget.value as VersionPolicy);
                    setErrors((current) => ({ ...current, versionPolicy: undefined }));
                  }}
                  aria-invalid={errors.versionPolicy ? true : undefined}
                  aria-describedby={errors.versionPolicy ? `${id}-version-policy-error` : undefined}
                >
                  <option value="">Choose a version policy</option>
                  <option value="follow">Follow the current version</option>
                  <option value="pinned">Pin to a specific version</option>
                </select>
                {errors.versionPolicy ? (
                  <p id={`${id}-version-policy-error`} className="share-field__error" role="alert">
                    {errors.versionPolicy}
                  </p>
                ) : null}
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
                  <label htmlFor={`${id}-expiry-policy`}>Expiry policy</label>
                  <select
                    id={`${id}-expiry-policy`}
                    value={expiryPolicy}
                    onChange={(event) => {
                      setExpiryPolicy(event.currentTarget.value as ExpiryPolicy);
                      setErrors((current) => ({ ...current, expiryPolicy: undefined }));
                    }}
                    aria-invalid={errors.expiryPolicy ? true : undefined}
                    aria-describedby={errors.expiryPolicy ? `${id}-expiry-policy-error` : undefined}
                  >
                    <option value="">Choose an expiry policy</option>
                    <option value="never">No expiry</option>
                    <option value="custom">Set date and time</option>
                  </select>
                  {errors.expiryPolicy ? (
                    <p id={`${id}-expiry-policy-error`} className="share-field__error" role="alert">
                      {errors.expiryPolicy}
                    </p>
                  ) : null}
                </div>

                <div className="share-field">
                  <label htmlFor={`${id}-resolution-policy`}>Resolution limit</label>
                  <select
                    id={`${id}-resolution-policy`}
                    value={resolutionPolicy}
                    onChange={(event) => {
                      setResolutionPolicy(event.currentTarget.value as ResolutionPolicy);
                      setErrors((current) => ({ ...current, resolutionPolicy: undefined }));
                    }}
                    aria-invalid={errors.resolutionPolicy ? true : undefined}
                    aria-describedby={errors.resolutionPolicy
                      ? `${id}-resolution-policy-error`
                      : `${id}-resolution-policy-hint`}
                  >
                    <option value="">Choose a limit policy</option>
                    <option value="unlimited">No resolution limit</option>
                    <option value="limited" disabled>Limited links require recipient confirmation</option>
                  </select>
                  {errors.resolutionPolicy ? (
                    <p id={`${id}-resolution-policy-error`} className="share-field__error" role="alert">
                      {errors.resolutionPolicy}
                    </p>
                  ) : (
                    <p id={`${id}-resolution-policy-hint`} className="share-field__hint">
                      Limited-resolution links stay unavailable until recipient confirmation prevents automated previews from consuming the limit.
                    </p>
                  )}
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

              {resolutionPolicy === "limited" ? (
                <div className="share-field">
                  <label htmlFor={`${id}-max-resolutions`}>Maximum resolutions</label>
                  <input
                    id={`${id}-max-resolutions`}
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    value={maxResolutions}
                    onChange={(event) => {
                      setMaxResolutions(event.currentTarget.value);
                      setErrors((current) => ({ ...current, maxResolutions: undefined }));
                    }}
                    aria-invalid={errors.maxResolutions ? true : undefined}
                    aria-describedby={errors.maxResolutions ? `${id}-max-resolutions-error` : undefined}
                  />
                  {errors.maxResolutions ? (
                    <p id={`${id}-max-resolutions-error`} className="share-field__error" role="alert">
                      {errors.maxResolutions}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="share-field">
                <label htmlFor={`${id}-access-policy`}>Access policy</label>
                <select
                  id={`${id}-access-policy`}
                  value={accessPolicy}
                  onChange={(event) => {
                    setAccessPolicy(event.currentTarget.value as AccessPolicy);
                    setErrors((current) => ({ ...current, accessPolicy: undefined }));
                  }}
                  aria-invalid={errors.accessPolicy ? true : undefined}
                  aria-describedby={[
                    `${id}-access-policy-hint`,
                    errors.accessPolicy ? `${id}-access-policy-error` : null,
                  ].filter(Boolean).join(" ")}
                >
                  <option value="">Choose access policy</option>
                  <option value="public">Public bearer access</option>
                  <option value="workspace" disabled>Workspace membership, not available</option>
                </select>
                <p id={`${id}-access-policy-hint`} className="share-field__hint">
                  Anyone with the share URL can resolve it. Workspace membership access requires a recipient continuation flow that is not available yet.
                </p>
                {errors.accessPolicy ? (
                  <p id={`${id}-access-policy-error`} className="share-field__error" role="alert">
                    {errors.accessPolicy}
                  </p>
                ) : null}
              </div>

              <div className="share-field">
                <label htmlFor={`${id}-content-disposition`}>Delivery behavior</label>
                <select
                  id={`${id}-content-disposition`}
                  value={contentDisposition}
                  onChange={(event) => {
                    setContentDisposition(event.currentTarget.value as ContentDisposition);
                    setErrors((current) => ({ ...current, contentDisposition: undefined }));
                  }}
                  aria-invalid={errors.contentDisposition ? true : undefined}
                  aria-describedby={errors.contentDisposition ? `${id}-content-disposition-error` : undefined}
                >
                  <option value="">Choose delivery behavior</option>
                  <option value="inline">Open inline</option>
                  <option value="attachment">Download as attachment</option>
                </select>
                {errors.contentDisposition ? (
                  <p id={`${id}-content-disposition-error`} className="share-field__error" role="alert">
                    {errors.contentDisposition}
                  </p>
                ) : null}
              </div>

            </fieldset>

            <p className="share-policy-form__warning">
              Revoking blocks future Relay resolutions. An authorization already issued before revocation may remain valid until its own expiry.
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
          <section className="share-secret" aria-labelledby={`${id}-secret-title`}>
            <div className="share-secret__notice" role="status" aria-live="polite">
              <span aria-hidden="true">■</span>
              <div>
                <h3 id={`${id}-secret-title`}>Copy these values now</h3>
                <p id={`${id}-secret-description`}>
                  {created.replayed
                    ? "Relay replayed the stored creation result. Copy the recovered share URL and token now; closing this panel clears them from the page."
                    : "Relay shows this share URL and token once. Closing this panel clears them from the page. Later artifact reads do not return either value."}
                </p>
              </div>
            </div>

            <dl className="share-secret__identity">
              <div>
                <dt>Share record</dt>
                <dd><code>{created.shareLinkId}</code></dd>
              </div>
            </dl>

            <div className="share-secret__field">
              <label htmlFor={`${id}-share-url`}>Public share URL, shown once</label>
              <input
                id={`${id}-share-url`}
                type={revealed ? "text" : "password"}
                value={shareUrl ?? ""}
                readOnly
                autoComplete="off"
                spellCheck={false}
              />
              <Button variant="outline" onClick={() => void copySecret(shareUrl ?? "", "Share URL")}>
                Copy share URL
              </Button>
            </div>

            <div className="share-secret__field">
              <label htmlFor={`${id}-token`}>Share token, shown once</label>
              <input
                id={`${id}-token`}
                type={revealed ? "text" : "password"}
                value={created.token}
                readOnly
                autoComplete="off"
                spellCheck={false}
              />
              <Button variant="outline" onClick={() => void copySecret(created.token, "Token")}>
                Copy token
              </Button>
            </div>

            <div className="share-secret__controls">
              <Button variant="quiet" onClick={() => setRevealed((value) => !value)}>
                {revealed ? "Hide values" : "Reveal values"}
              </Button>
              <Button onClick={onDone}>Clear values and refresh</Button>
            </div>

            <p className="share-secret__copy-status" role="status" aria-live="polite">
              {copyStatus}
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
