import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  CHANGELOG_CATEGORIES,
  createAdminChangelogIdempotencyKey,
  type AdminChangelogDraftInput,
  type AdminChangelogReleaseDetail,
  type CreateAdminChangelogAdapterResult,
  type PublishAdminChangelogAdapterResult,
  type PublishAdminChangelogRequest,
  type ReviseAdminChangelogAdapterResult,
  type ReviseAdminChangelogRequest,
  type UnpublishAdminChangelogAdapterResult,
  type UnpublishAdminChangelogRequest,
} from "../../lib/api/admin-changelog";
import {
  isBoundaryAccessFailure,
  useAdminChangelog,
} from "./AdminChangelogContext";
import { ReleaseActionDialog, type ReleaseActionKind } from "./ReleaseActionDialog";
import {
  createEditorItem,
  createEmptyEditorModel,
  editorModelSignature,
  editorModelToDraft,
  hasValidationErrors,
  isAbortError,
  isAdminChangelogReleaseId,
  publishabilityReasonLabel,
  publishChecks,
  releaseStatusPresentation,
  snapshotToEditorModel,
  validateEditorModel,
  type AdminChangelogEditorItem,
  type AdminChangelogEditorModel,
  type AdminChangelogItemErrors,
  type AdminChangelogValidationErrors,
} from "./model";

interface AdminChangelogEditorPageProps {
  readonly createNew?: boolean;
}

type DetailState =
  | { readonly kind: "loading"; readonly scopeKey: string }
  | { readonly kind: "ready"; readonly scopeKey: string; readonly release: AdminChangelogReleaseDetail | null }
  | { readonly kind: "not-found"; readonly scopeKey: string }
  | { readonly kind: "degraded"; readonly scopeKey: string; readonly message: string };

type SavePhase = "idle" | "saving" | "saved" | "error";

type FrozenMutation =
  | { readonly operation: "create"; readonly payload: AdminChangelogDraftInput; readonly key: string; readonly message: string }
  | { readonly operation: "revise"; readonly releaseId: string; readonly payload: ReviseAdminChangelogRequest; readonly key: string; readonly message: string }
  | { readonly operation: "publish"; readonly releaseId: string; readonly payload: PublishAdminChangelogRequest; readonly key: string; readonly message: string }
  | { readonly operation: "unpublish"; readonly releaseId: string; readonly payload: UnpublishAdminChangelogRequest; readonly key: string; readonly message: string };

type EditorBlock =
  | { readonly kind: "conflict" | "reload-required"; readonly message: string }
  | null;

interface DialogState {
  readonly kind: ReleaseActionKind;
  readonly error: string | null;
  readonly serverBlockers: readonly string[];
}

const EMPTY_ERRORS: AdminChangelogValidationErrors = { itemErrors: [] };

function fieldDescriptionId(id: string, error: string | undefined, hint: string | undefined): string | undefined {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ") || undefined;
}

interface EditorFieldProps {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly error?: string;
  readonly hint?: string;
  readonly required?: boolean;
  readonly maxLength?: number;
  readonly mono?: boolean;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}

function EditorField({
  id,
  label,
  value,
  error,
  hint,
  required,
  maxLength,
  mono,
  placeholder,
  onChange,
}: EditorFieldProps) {
  return (
    <div className="admin-field">
      <label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      {hint ? <p className="admin-field__hint" id={`${id}-hint`}>{hint}</p> : null}
      <input
        id={id}
        className={mono ? "admin-input admin-input--mono" : "admin-input"}
        value={value}
        required={required}
        maxLength={maxLength}
        placeholder={placeholder}
        spellCheck={mono ? false : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldDescriptionId(id, error, hint)}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error ? <p className="admin-field__error" id={`${id}-error`} role="alert">{error}</p> : null}
    </div>
  );
}

interface EditorTextareaProps extends Omit<EditorFieldProps, "mono" | "placeholder"> {
  readonly rows: number;
}

function EditorTextarea({
  id,
  label,
  value,
  error,
  hint,
  required,
  maxLength,
  rows,
  onChange,
}: EditorTextareaProps) {
  return (
    <div className="admin-field">
      <label htmlFor={id}>{label}{required ? <span aria-hidden="true"> *</span> : null}</label>
      {hint ? <p className="admin-field__hint" id={`${id}-hint`}>{hint}</p> : null}
      <textarea
        id={id}
        className="admin-textarea"
        value={value}
        required={required}
        maxLength={maxLength}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={fieldDescriptionId(id, error, hint)}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      {error ? <p className="admin-field__error" id={`${id}-error`} role="alert">{error}</p> : null}
    </div>
  );
}

function StaticIdentityField({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="admin-static-field">
      <span>{label}</span>
      <code>{children}</code>
    </div>
  );
}

function SaveStateLabel({
  creating,
  dirty,
  phase,
}: {
  readonly creating: boolean;
  readonly dirty: boolean;
  readonly phase: SavePhase;
}) {
  const presentation = phase === "saving"
    ? { glyph: "□", text: "Saving" }
    : phase === "error"
      ? { glyph: "▲", text: "Save failed" }
      : dirty
        ? { glyph: "□", text: "Unsaved changes" }
        : creating
          ? { glyph: "□", text: "Not saved" }
          : { glyph: "■", text: "Saved" };
  return (
    <span className={`admin-save-state admin-save-state--${phase}`} role="status">
      <span aria-hidden="true">{presentation.glyph}</span>
      {presentation.text}
    </span>
  );
}

function firstErrorControlId(
  errors: AdminChangelogValidationErrors,
  model: AdminChangelogEditorModel,
): string | null {
  for (const key of ["version", "slug", "title", "summary", "gitTag", "commitSha", "releasedAt"] as const) {
    if (errors[key]) return `admin-release-${key}`;
  }
  const itemIndex = errors.itemErrors.findIndex((item) => Object.keys(item).length > 0);
  if (itemIndex < 0) return null;
  const item = model.items[itemIndex];
  const itemErrors = errors.itemErrors[itemIndex];
  if (item === undefined || itemErrors === undefined) return null;
  for (const key of ["category", "area", "title", "description"] as const) {
    if (itemErrors[key]) return `admin-item-${item.clientId}-${key}`;
  }
  return null;
}

function mutationConflictMessage(result: {
  readonly kind: string;
  readonly actualRevision?: number;
}): string {
  switch (result.kind) {
    case "identity-conflict":
      return `Version or slug was locked by revision ${result.actualRevision ?? "unknown"}. Reload the authoritative release before continuing.`;
    case "revision-conflict":
      return `The release advanced to revision ${result.actualRevision ?? "unknown"}. Reload the authoritative release before continuing.`;
    case "version-conflict":
      return "Another release already uses this version. No release was overwritten.";
    case "slug-conflict":
      return "Another release already uses this slug. No release was overwritten.";
    case "version-and-slug-conflict":
      return "Another release already uses this version and slug. No release was overwritten.";
    case "idempotency-conflict":
      return "The mutation key does not match its original request. Reload authoritative state before continuing.";
    default:
      return "The release changed before this action completed. Reload authoritative state before continuing.";
  }
}

export function AdminChangelogEditorPage({ createNew = false }: AdminChangelogEditorPageProps) {
  const params = useParams<{ releaseId: string }>();
  const navigate = useNavigate();
  const { adapter, reportAccessFailure } = useAdminChangelog();
  const { session } = useAuth();
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const creating = createNew || params.releaseId === undefined;
  usePageMetadata(
    creating ? "New changelog draft | Relay" : "Edit admin changelog | Relay",
    "#141A16",
  );
  const releaseId = creating ? null : params.releaseId;
  const scopeKey = `${sessionId ?? "none"}:${creating ? "new" : releaseId ?? "invalid"}`;
  const [detailState, setDetailState] = useState<DetailState>({ kind: "loading", scopeKey });
  const [model, setModel] = useState<AdminChangelogEditorModel>(createEmptyEditorModel);
  const [baselineSignature, setBaselineSignature] = useState(() => editorModelSignature(createEmptyEditorModel()));
  const [errors, setErrors] = useState<AdminChangelogValidationErrors>(EMPTY_ERRORS);
  const [savePhase, setSavePhase] = useState<SavePhase>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  const [frozenMutation, setFrozenMutation] = useState<FrozenMutation | null>(null);
  const [block, setBlock] = useState<EditorBlock>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const activeRef = useRef(true);
  const scopeKeyRef = useRef(scopeKey);
  const sessionIdRef = useRef(sessionId);
  const readGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const readControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const frozenStatusRef = useRef<HTMLDivElement>(null);
  const conflictStatusRef = useRef<HTMLDivElement>(null);
  const actionNoticeRef = useRef<HTMLDivElement>(null);
  scopeKeyRef.current = scopeKey;
  sessionIdRef.current = sessionId;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      readGenerationRef.current += 1;
      mutationGenerationRef.current += 1;
      readControllerRef.current?.abort();
      mutationControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    mutationGenerationRef.current += 1;
    mutationControllerRef.current?.abort();
    setDialog(null);
    setMutationPending(false);
    setFrozenMutation(null);
    setBlock(null);
    setActionNotice(null);
    setSaveError(null);
    setErrors(EMPTY_ERRORS);

    if (sessionId === undefined) return;
    if (creating) {
      const empty = createEmptyEditorModel();
      readGenerationRef.current += 1;
      readControllerRef.current?.abort();
      setModel(empty);
      setBaselineSignature(editorModelSignature(empty));
      setSavePhase("idle");
      setDetailState({ kind: "ready", scopeKey, release: null });
      return;
    }
    if (!isAdminChangelogReleaseId(releaseId)) {
      readGenerationRef.current += 1;
      readControllerRef.current?.abort();
      setDetailState({ kind: "not-found", scopeKey });
      return;
    }

    const expectedSessionId = sessionId;
    const expectedScopeKey = scopeKey;
    const generation = ++readGenerationRef.current;
    const controller = new AbortController();
    readControllerRef.current?.abort();
    readControllerRef.current = controller;
    setDetailState({ kind: "loading", scopeKey: expectedScopeKey });

    void adapter.get(releaseId, controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        reportAccessFailure(result, expectedSessionId);
        return;
      }
      if (
        !activeRef.current
        || controller.signal.aborted
        || generation !== readGenerationRef.current
        || scopeKeyRef.current !== expectedScopeKey
        || sessionIdRef.current !== expectedSessionId
      ) return;
      if (isBoundaryAccessFailure(result)) {
        reportAccessFailure(result, expectedSessionId);
        return;
      }
      if (result.kind === "found") {
        const nextModel = snapshotToEditorModel(result.release.latest);
        setModel(nextModel);
        setBaselineSignature(editorModelSignature(nextModel));
        setSavePhase("saved");
        setDetailState({ kind: "ready", scopeKey: expectedScopeKey, release: result.release });
      } else if (result.kind === "not-found") {
        setDetailState({ kind: "not-found", scopeKey: expectedScopeKey });
      } else {
        setDetailState({ kind: "degraded", scopeKey: expectedScopeKey, message: result.message });
      }
    }).catch((error: unknown) => {
      if (
        isAbortError(error)
        || !activeRef.current
        || controller.signal.aborted
        || generation !== readGenerationRef.current
        || scopeKeyRef.current !== expectedScopeKey
        || sessionIdRef.current !== expectedSessionId
      ) return;
      setDetailState({
        kind: "degraded",
        scopeKey: expectedScopeKey,
        message: "Relay could not load this changelog release. No release data was changed.",
      });
    }).finally(() => {
      if (readControllerRef.current === controller) readControllerRef.current = null;
    });

    return () => controller.abort();
  }, [adapter, creating, releaseId, reloadGeneration, reportAccessFailure, scopeKey, sessionId]);

  useEffect(() => {
    if (frozenMutation !== null) frozenStatusRef.current?.focus();
  }, [frozenMutation]);

  useEffect(() => {
    if (block !== null) conflictStatusRef.current?.focus();
  }, [block]);

  useEffect(() => {
    if (actionNotice !== null) actionNoticeRef.current?.focus();
  }, [actionNotice]);

  const release = detailState.kind === "ready" && detailState.scopeKey === scopeKey
    ? detailState.release
    : null;
  const dirty = editorModelSignature(model) !== baselineSignature;
  const lockedIdentity = release !== null && release.firstPublishedAt !== null;
  const formDisabled = mutationPending || frozenMutation !== null || block !== null;
  const currentDraft = useMemo(() => editorModelToDraft(model), [model]);
  const checks = useMemo(() => publishChecks(currentDraft), [currentDraft]);
  const publishBlockers = checks.filter((check) => !check.passed).map((check) => check.label);
  const canOpenReleaseActions = release !== null
    && !dirty
    && savePhase !== "saving"
    && savePhase !== "error"
    && frozenMutation === null
    && block === null;

  function changeModel(update: (current: AdminChangelogEditorModel) => AdminChangelogEditorModel) {
    if (formDisabled) return;
    setModel(update);
    setErrors(EMPTY_ERRORS);
    setSaveError(null);
    setActionNotice(null);
    if (savePhase !== "saving") setSavePhase("idle");
  }

  function updateItem(index: number, update: Partial<Omit<AdminChangelogEditorItem, "clientId">>) {
    changeModel((current) => ({
      ...current,
      items: current.items.map((item, itemIndex) => itemIndex === index
        ? { ...item, ...update }
        : item),
    }));
  }

  function moveItem(index: number, direction: -1 | 1) {
    changeModel((current) => {
      const target = index + direction;
      if (target < 0 || target >= current.items.length) return current;
      const items = [...current.items];
      const item = items[index];
      const other = items[target];
      if (item === undefined || other === undefined) return current;
      items[index] = other;
      items[target] = item;
      return { ...current, items };
    });
  }

  function addItem() {
    if (model.items.length >= 200) return;
    changeModel((current) => ({ ...current, items: [...current.items, createEditorItem()] }));
  }

  function removeItem(index: number) {
    changeModel((current) => ({
      ...current,
      items: current.items.filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  function currentOperation(): "create" | "revise" {
    return release === null ? "create" : "revise";
  }

  function freezeUnknown(operation: FrozenMutation, message: string) {
    setDialog(null);
    setMutationPending(false);
    setSavePhase("error");
    setSaveError(null);
    setFrozenMutation({ ...operation, message });
  }

  function requireReload(message: string) {
    setDialog(null);
    setFrozenMutation(null);
    setBlock({ kind: "conflict", message });
    setSavePhase("error");
    setSaveError(null);
  }

  function reportOwningSessionExpiry(
    result: { readonly kind: string },
    expectedSessionId: string,
  ): boolean {
    if (result.kind !== "auth-expired") return false;
    reportAccessFailure({ kind: "auth-expired" }, expectedSessionId);
    return true;
  }

  function reportCurrentAccessLoss(
    result: { readonly kind: string },
    expectedSessionId: string,
  ): boolean {
    if (result.kind === "reauthentication-required") {
      reportAccessFailure({ kind: "reauthentication-required" }, expectedSessionId);
      return true;
    }
    if (result.kind === "denied") {
      reportAccessFailure({ kind: "denied" }, expectedSessionId);
      return true;
    }
    return false;
  }

  async function refreshAuthoritative(
    targetReleaseId: string,
    expectedSessionId: string,
    expectedScopeKey: string,
    mutationGeneration: number,
    successMessage: string,
  ) {
    const readGeneration = ++readGenerationRef.current;
    const controller = new AbortController();
    readControllerRef.current?.abort();
    readControllerRef.current = controller;
    try {
      const result = await adapter.get(targetReleaseId, controller.signal);
      if (reportOwningSessionExpiry(result, expectedSessionId)) return;
      if (
        !activeRef.current
        || controller.signal.aborted
        || mutationGeneration !== mutationGenerationRef.current
        || readGeneration !== readGenerationRef.current
        || scopeKeyRef.current !== expectedScopeKey
        || sessionIdRef.current !== expectedSessionId
      ) return;
      if (reportCurrentAccessLoss(result, expectedSessionId)) return;

      if (result.kind === "found") {
        const nextModel = snapshotToEditorModel(result.release.latest);
        setModel(nextModel);
        setBaselineSignature(editorModelSignature(nextModel));
        setErrors(EMPTY_ERRORS);
        setSavePhase("saved");
        setSaveError(null);
        setBlock(null);
        setDetailState({ kind: "ready", scopeKey: expectedScopeKey, release: result.release });
        setActionNotice(successMessage);
      } else if (result.kind === "not-found") {
        setDetailState({ kind: "not-found", scopeKey: expectedScopeKey });
      } else {
        setBlock({
          kind: "reload-required",
          message: `${successMessage} Relay could not load the authoritative release. Reload before another action.`,
        });
      }
    } catch (error) {
      if (
        isAbortError(error)
        || !activeRef.current
        || controller.signal.aborted
        || mutationGeneration !== mutationGenerationRef.current
        || readGeneration !== readGenerationRef.current
        || scopeKeyRef.current !== expectedScopeKey
        || sessionIdRef.current !== expectedSessionId
      ) return;
      setBlock({
        kind: "reload-required",
        message: `${successMessage} Relay could not load the authoritative release. Reload before another action.`,
      });
    } finally {
      if (readControllerRef.current === controller) readControllerRef.current = null;
    }
  }

  function handleKnownSaveFailure(
    result: CreateAdminChangelogAdapterResult | ReviseAdminChangelogAdapterResult,
    operation: FrozenMutation,
    retryingFrozen: boolean,
  ) {
    if (result.kind === "unknown-outcome") {
      freezeUnknown(operation, result.message);
    } else if (
      result.kind === "version-conflict"
      || result.kind === "slug-conflict"
      || result.kind === "version-and-slug-conflict"
    ) {
      const versionConflict = result.kind === "version-conflict"
        || result.kind === "version-and-slug-conflict";
      const slugConflict = result.kind === "slug-conflict"
        || result.kind === "version-and-slug-conflict";
      setFrozenMutation(null);
      setBlock(null);
      setSavePhase("error");
      setSaveError(
        "The request was not applied. Change the marked release identity and save again.",
      );
      setErrors({
        ...(versionConflict
          ? { version: "Another release already uses this version." }
          : {}),
        ...(slugConflict
          ? { slug: "Another release already uses this slug." }
          : {}),
        itemErrors: model.items.map(() => ({})),
      });
      window.setTimeout(() => {
        document.getElementById(
          versionConflict ? "admin-release-version" : "admin-release-slug",
        )?.focus();
      }, 0);
    } else if (
      result.kind === "identity-conflict"
      || result.kind === "revision-conflict"
      || result.kind === "idempotency-conflict"
    ) {
      requireReload(mutationConflictMessage(result));
    } else if (result.kind === "not-found") {
      setDetailState({ kind: "not-found", scopeKey });
    } else if (result.kind === "degraded") {
      if (retryingFrozen) {
        freezeUnknown(operation, `${operation.message} The exact retry was rejected: ${result.message}`);
      } else {
        setSavePhase("error");
        setSaveError(result.message);
      }
    } else if (result.kind === "not-publishable") {
      setSavePhase("error");
      setSaveError("Relay rejected the saved snapshot. Review every field before trying again.");
    }
  }

  function handleKnownActionFailure(
    result: PublishAdminChangelogAdapterResult | UnpublishAdminChangelogAdapterResult,
    operation: FrozenMutation,
    retryingFrozen: boolean,
  ) {
    if (result.kind === "unknown-outcome") {
      freezeUnknown(operation, result.message);
    } else if (result.kind === "not-publishable") {
      setFrozenMutation(null);
      setDialog({
        kind: "publish",
        error: "Backend publish checks did not permit publication.",
        serverBlockers: result.reasons.map(publishabilityReasonLabel),
      });
    } else if (
      result.kind === "identity-conflict"
      || result.kind === "revision-conflict"
      || result.kind === "version-conflict"
      || result.kind === "slug-conflict"
      || result.kind === "version-and-slug-conflict"
      || result.kind === "idempotency-conflict"
    ) {
      requireReload(mutationConflictMessage(result));
    } else if (result.kind === "not-found") {
      setDetailState({ kind: "not-found", scopeKey });
      setDialog(null);
    } else if (result.kind === "degraded") {
      if (retryingFrozen) {
        freezeUnknown(operation, `${operation.message} The exact retry was rejected: ${result.message}`);
      } else {
        setDialog((current) => current === null ? null : { ...current, error: result.message });
      }
    }
  }

  async function executeMutation(operation: FrozenMutation, retryingFrozen = false) {
    if (sessionId === undefined || mutationPending) return;
    const expectedSessionId = sessionId;
    const expectedScopeKey = scopeKey;
    const generation = ++mutationGenerationRef.current;
    const controller = new AbortController();
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = controller;
    setMutationPending(true);
    setSaveError(null);
    setActionNotice(null);
    if (operation.operation === "create" || operation.operation === "revise") setSavePhase("saving");

    try {
      if (operation.operation === "create") {
        const result = await adapter.create(operation.payload, operation.key, controller.signal);
        if (reportOwningSessionExpiry(result, expectedSessionId)) return;
        if (
          !activeRef.current
          || generation !== mutationGenerationRef.current
          || scopeKeyRef.current !== expectedScopeKey
          || sessionIdRef.current !== expectedSessionId
        ) return;
        if (reportCurrentAccessLoss(result, expectedSessionId)) return;
        if (result.kind === "created") {
          setFrozenMutation(null);
          setSavePhase("saved");
          navigate(`/admin/changelog/${result.releaseId}`, { replace: true });
        } else {
          handleKnownSaveFailure(result, operation, retryingFrozen);
        }
      } else if (operation.operation === "revise") {
        const result = await adapter.revise(
          operation.releaseId,
          operation.payload,
          operation.key,
          controller.signal,
        );
        if (reportOwningSessionExpiry(result, expectedSessionId)) return;
        if (
          !activeRef.current
          || generation !== mutationGenerationRef.current
          || scopeKeyRef.current !== expectedScopeKey
          || sessionIdRef.current !== expectedSessionId
        ) return;
        if (reportCurrentAccessLoss(result, expectedSessionId)) return;
        if (result.kind === "revised" || result.kind === "unchanged") {
          setFrozenMutation(null);
          await refreshAuthoritative(
            operation.releaseId,
            expectedSessionId,
            expectedScopeKey,
            generation,
            result.kind === "unchanged" ? "The saved snapshot was already current." : `Revision ${result.revision} saved.`,
          );
        } else {
          handleKnownSaveFailure(result, operation, retryingFrozen);
        }
      } else if (operation.operation === "publish") {
        const result = await adapter.publish(
          operation.releaseId,
          operation.payload,
          operation.key,
          controller.signal,
        );
        if (reportOwningSessionExpiry(result, expectedSessionId)) return;
        if (
          !activeRef.current
          || generation !== mutationGenerationRef.current
          || scopeKeyRef.current !== expectedScopeKey
          || sessionIdRef.current !== expectedSessionId
        ) return;
        if (reportCurrentAccessLoss(result, expectedSessionId)) return;
        if (result.kind === "published" || result.kind === "superseded" || result.kind === "unchanged") {
          setFrozenMutation(null);
          setDialog(null);
          const message = result.kind === "published"
            ? `Revision ${result.revision} published.`
            : result.kind === "superseded"
              ? `Revision ${result.revision} published. Revision ${result.supersededRevision} is archived.`
              : `Revision ${result.revision} was already published.`;
          await refreshAuthoritative(
            operation.releaseId,
            expectedSessionId,
            expectedScopeKey,
            generation,
            message,
          );
        } else {
          handleKnownActionFailure(result, operation, retryingFrozen);
        }
      } else {
        const result = await adapter.unpublish(
          operation.releaseId,
          operation.payload,
          operation.key,
          controller.signal,
        );
        if (reportOwningSessionExpiry(result, expectedSessionId)) return;
        if (
          !activeRef.current
          || generation !== mutationGenerationRef.current
          || scopeKeyRef.current !== expectedScopeKey
          || sessionIdRef.current !== expectedSessionId
        ) return;
        if (reportCurrentAccessLoss(result, expectedSessionId)) return;
        if (result.kind === "unpublished" || result.kind === "unchanged") {
          setFrozenMutation(null);
          setDialog(null);
          const message = result.kind === "unpublished"
            ? `Revision ${result.revision} unpublished. Stored release history remains archived.`
            : "Public visibility was already removed. Stored release history remains unchanged.";
          await refreshAuthoritative(
            operation.releaseId,
            expectedSessionId,
            expectedScopeKey,
            generation,
            message,
          );
        } else {
          handleKnownActionFailure(result, operation, retryingFrozen);
        }
      }
    } catch (error) {
      if (
        !activeRef.current
        || generation !== mutationGenerationRef.current
        || scopeKeyRef.current !== expectedScopeKey
        || sessionIdRef.current !== expectedSessionId
      ) return;
      if (isAbortError(error) && controller.signal.aborted && scopeKeyRef.current !== expectedScopeKey) return;
      freezeUnknown(
        operation,
        `Relay could not confirm the ${operation.operation} result. Retry only this exact request with its existing idempotency key.`,
      );
    } finally {
      if (
        activeRef.current
        && generation === mutationGenerationRef.current
        && scopeKeyRef.current === expectedScopeKey
        && sessionIdRef.current === expectedSessionId
      ) {
        setMutationPending(false);
        if (
          operation.operation !== "publish"
          && operation.operation !== "unpublish"
          && frozenMutation === null
        ) {
          setSavePhase((current) => current === "saving" ? "idle" : current);
        }
      }
      if (mutationControllerRef.current === controller) mutationControllerRef.current = null;
    }
  }

  function submitSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (formDisabled || savePhase === "saving") return;
    const nextErrors = validateEditorModel(model);
    setErrors(nextErrors);
    setSaveError(null);
    setActionNotice(null);
    if (hasValidationErrors(nextErrors)) {
      setSavePhase("error");
      const id = firstErrorControlId(nextErrors, model);
      if (id !== null) window.setTimeout(() => document.getElementById(id)?.focus(), 0);
      return;
    }
    if (release !== null && !dirty) {
      setSavePhase("saved");
      return;
    }

    const draft = editorModelToDraft(model);
    if (release === null) {
      const operation: FrozenMutation = {
        operation: "create",
        payload: draft,
        key: createAdminChangelogIdempotencyKey("create"),
        message: "Relay could not confirm whether the draft was created.",
      };
      void executeMutation(operation);
    } else {
      const operation: FrozenMutation = {
        operation: "revise",
        releaseId: release.releaseId,
        payload: { expectedRevision: release.latestRevision, ...draft },
        key: createAdminChangelogIdempotencyKey("revise"),
        message: "Relay could not confirm whether the revision was saved.",
      };
      void executeMutation(operation);
    }
  }

  function confirmReleaseAction() {
    if (release === null || dialog === null || mutationPending || !canOpenReleaseActions) return;
    if (dialog.kind === "publish") {
      const operation: FrozenMutation = {
        operation: "publish",
        releaseId: release.releaseId,
        payload: { expectedRevision: release.latestRevision },
        key: createAdminChangelogIdempotencyKey("publish"),
        message: "Relay could not confirm whether the revision was published.",
      };
      void executeMutation(operation);
    } else if (release.status === "published" && release.publishedRevision !== null) {
      const operation: FrozenMutation = {
        operation: "unpublish",
        releaseId: release.releaseId,
        payload: { expectedPublishedRevision: release.publishedRevision },
        key: createAdminChangelogIdempotencyKey("unpublish"),
        message: "Relay could not confirm whether public visibility was removed.",
      };
      void executeMutation(operation);
    }
  }

  function reloadAuthoritative() {
    setBlock(null);
    setFrozenMutation(null);
    setSaveError(null);
    setActionNotice(null);
    setSavePhase("idle");
    setReloadGeneration((value) => value + 1);
  }

  if (detailState.scopeKey !== scopeKey || detailState.kind === "loading") {
    return (
      <section className="admin-changelog-page admin-editor-page" aria-labelledby="admin-editor-loading-title">
        <header className="admin-page-header">
          <div>
            <p className="mono-label">Platform changelog</p>
            <h1 id="admin-editor-loading-title">Loading release editor</h1>
          </div>
        </header>
        <div className="admin-page-body"><Skeleton label="Loading changelog release" lines={8} /></div>
      </section>
    );
  }

  if (detailState.kind === "not-found") {
    return (
      <section className="admin-changelog-page" aria-labelledby="admin-editor-not-found-title">
        <header className="admin-page-header">
          <div>
            <p className="mono-label">Platform changelog</p>
            <h1 id="admin-editor-not-found-title">Release not found</h1>
          </div>
        </header>
        <div className="admin-page-body">
          <InlineNotice title="Release unavailable" tone="error">
            <p>The release does not exist or is no longer available. No changelog data was changed.</p>
          </InlineNotice>
          <LinkButton variant="outline" to="/admin/changelog">Return to release list</LinkButton>
        </div>
      </section>
    );
  }

  if (detailState.kind === "degraded") {
    return (
      <section className="admin-changelog-page" aria-labelledby="admin-editor-degraded-title">
        <header className="admin-page-header">
          <div>
            <p className="mono-label">Platform changelog</p>
            <h1 id="admin-editor-degraded-title">Release editor unavailable</h1>
          </div>
        </header>
        <div className="admin-page-body">
          <InlineNotice
            title="Release not loaded"
            tone="error"
            action={<Button variant="outline" onClick={reloadAuthoritative}>Try again</Button>}
          >
            <p>{detailState.message}</p>
          </InlineNotice>
          <LinkButton variant="quiet" to="/admin/changelog">Return to release list</LinkButton>
        </div>
      </section>
    );
  }

  const status = release === null ? null : releaseStatusPresentation(release.status);
  const pageTitle = release === null ? "New changelog draft" : `Edit ${release.latest.version}`;

  return (
    <section className="admin-changelog-page admin-editor-page" aria-labelledby="admin-editor-title">
      <header className="admin-editor-header">
        <div className="admin-editor-header__identity">
          <Link className="admin-text-link" to="/admin/changelog">Back to releases</Link>
          <div className="admin-editor-heading">
            <h1 id="admin-editor-title">{pageTitle}</h1>
            {status !== null ? (
              <span className={`admin-release-status admin-release-status--${release?.status}`}>
                <span aria-hidden="true">{status.glyph}</span>{status.label}
              </span>
            ) : null}
          </div>
          <SaveStateLabel creating={release === null} dirty={dirty} phase={savePhase} />
        </div>
        {frozenMutation === null && block === null ? (
          <div className="admin-editor-header__actions">
            <Button
              form="admin-changelog-editor-form"
              type="submit"
              variant="outline"
              pending={savePhase === "saving"}
              pendingLabel="Saving..."
              disabled={mutationPending || (!dirty && release !== null)}
            >
              {release === null ? "Create draft" : "Save revision"}
            </Button>
            {release !== null ? (
              <LinkButton variant="outline" to={`/admin/changelog/${release.releaseId}/preview`}>
                Preview stored revision
              </LinkButton>
            ) : null}
            {release !== null ? (
              <Button
                disabled={!canOpenReleaseActions}
                aria-describedby={!canOpenReleaseActions ? "admin-save-before-action" : undefined}
                onClick={() => setDialog({ kind: "publish", error: null, serverBlockers: [] })}
              >
                Publish
              </Button>
            ) : null}
            {release?.status === "published" ? (
              <Button
                variant="outline"
                disabled={!canOpenReleaseActions}
                aria-describedby={!canOpenReleaseActions ? "admin-save-before-action" : undefined}
                onClick={() => setDialog({ kind: "unpublish", error: null, serverBlockers: [] })}
              >
                Unpublish
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="admin-editor-layout">
        <div className="admin-editor-main">
          {!canOpenReleaseActions && release !== null && frozenMutation === null && block === null ? (
            <p className="admin-action-requirement" id="admin-save-before-action">
              Save a valid, clean snapshot before publishing or unpublishing.
            </p>
          ) : null}

          {frozenMutation !== null ? (
            <div className="admin-mutation-lock" role="alert" tabIndex={-1} ref={frozenStatusRef}>
              <p className="mono-label">Outcome unknown</p>
              <h2>Editing is frozen</h2>
              <p>{frozenMutation.message} Retry only the exact saved request with the same idempotency key, or return to the release list.</p>
              <div className="admin-inline-actions">
                <Button
                  pending={mutationPending}
                  pendingLabel="Retrying exact request..."
                  onClick={() => void executeMutation(frozenMutation, true)}
                >
                  Retry exact request
                </Button>
                <LinkButton variant="outline" to="/admin/changelog">Return to release list</LinkButton>
              </div>
            </div>
          ) : null}

          {block !== null ? (
            <div className="admin-mutation-lock" role="alert" tabIndex={-1} ref={conflictStatusRef}>
              <p className="mono-label">Authoritative reload required</p>
              <h2>Release changed</h2>
              <p>{block.message}</p>
              <div className="admin-inline-actions">
                {releaseId !== null && isAdminChangelogReleaseId(releaseId) ? (
                  <Button onClick={reloadAuthoritative}>Reload authoritative release</Button>
                ) : null}
                <LinkButton variant="outline" to="/admin/changelog">Return to release list</LinkButton>
              </div>
            </div>
          ) : null}

          {saveError ? (
            <InlineNotice title={`${currentOperation() === "create" ? "Draft creation" : "Revision save"} failed`} tone="error">
              <p>{saveError}</p>
            </InlineNotice>
          ) : null}
          {actionNotice ? (
            <div className="admin-action-notice" ref={actionNoticeRef} tabIndex={-1}>
              <InlineNotice title="Release state updated" tone="success">
                <p>{actionNotice}</p>
              </InlineNotice>
            </div>
          ) : null}
          {hasValidationErrors(errors) ? (
            <InlineNotice title="Review the marked fields" tone="error">
              <p>The full release snapshot was not submitted.</p>
            </InlineNotice>
          ) : null}

          <form id="admin-changelog-editor-form" className="admin-editor-form" onSubmit={submitSave} noValidate>
            <fieldset className="admin-editor-fieldset" disabled={formDisabled}>
              <legend className="sr-only">Release snapshot</legend>

              <section className="admin-editor-section" aria-labelledby="admin-editor-identity-title">
                <div className="admin-editor-section__heading">
                  <div>
                    <h2 id="admin-editor-identity-title">Release identity</h2>
                    <p>Version and slug become permanent after the first publication.</p>
                  </div>
                </div>
                {lockedIdentity ? (
                  <>
                    <div className="admin-form-grid admin-form-grid--two">
                      <StaticIdentityField label="Version">{model.version}</StaticIdentityField>
                      <StaticIdentityField label="Slug">{model.slug}</StaticIdentityField>
                    </div>
                    <p className="admin-identity-lock-copy">Version and slug are locked because this release has been published before. Create a new release to use a different identity.</p>
                  </>
                ) : (
                  <div className="admin-form-grid admin-form-grid--two">
                    <EditorField
                      id="admin-release-version"
                      label="Version"
                      value={model.version}
                      error={errors.version}
                      required
                      maxLength={64}
                      mono
                      onChange={(version) => changeModel((current) => ({ ...current, version }))}
                    />
                    <EditorField
                      id="admin-release-slug"
                      label="Slug"
                      value={model.slug}
                      error={errors.slug}
                      hint="Lowercase letters, numbers, and internal hyphens."
                      required
                      maxLength={128}
                      mono
                      onChange={(slug) => changeModel((current) => ({ ...current, slug }))}
                    />
                  </div>
                )}
              </section>

              <section className="admin-editor-section" aria-labelledby="admin-editor-content-title">
                <div className="admin-editor-section__heading">
                  <div>
                    <h2 id="admin-editor-content-title">Release content</h2>
                    <p>Saving replaces the complete latest snapshot.</p>
                  </div>
                </div>
                <div className="admin-form-grid admin-form-grid--two">
                  <EditorField
                    id="admin-release-title"
                    label="Title"
                    value={model.title}
                    error={errors.title}
                    required
                    maxLength={200}
                    onChange={(title) => changeModel((current) => ({ ...current, title }))}
                  />
                  <EditorField
                    id="admin-release-gitTag"
                    label="Git tag"
                    value={model.gitTag}
                    error={errors.gitTag}
                    maxLength={256}
                    mono
                    onChange={(gitTag) => changeModel((current) => ({ ...current, gitTag }))}
                  />
                  <EditorField
                    id="admin-release-commitSha"
                    label="Commit SHA"
                    value={model.commitSha}
                    error={errors.commitSha}
                    hint="Optional to save. Required to publish."
                    maxLength={64}
                    mono
                    onChange={(commitSha) => changeModel((current) => ({ ...current, commitSha }))}
                  />
                  <EditorField
                    id="admin-release-releasedAt"
                    label="Release timestamp (UTC)"
                    value={model.releasedAt}
                    error={errors.releasedAt}
                    hint="Exact format: 2026-08-25T10:00:00.000Z"
                    maxLength={24}
                    mono
                    onChange={(releasedAt) => changeModel((current) => ({ ...current, releasedAt }))}
                  />
                </div>
                <EditorTextarea
                  id="admin-release-summary"
                  label="Summary"
                  value={model.summary}
                  error={errors.summary}
                  hint="Optional public release summary."
                  maxLength={2_000}
                  rows={4}
                  onChange={(summary) => changeModel((current) => ({ ...current, summary }))}
                />
              </section>

              <section className="admin-editor-section admin-items-section" aria-labelledby="admin-editor-items-title">
                <div className="admin-editor-section__heading">
                  <div>
                    <h2 id="admin-editor-items-title">Release items</h2>
                    <p>Array order becomes the stored sort order. Up to 200 items are allowed.</p>
                  </div>
                  <Button variant="outline" disabled={model.items.length >= 200} onClick={addItem}>Add item</Button>
                </div>
                {errors.items ? <p className="admin-field__error" role="alert">{errors.items}</p> : null}
                {model.items.length === 0 ? (
                  <p className="admin-items-empty">No release items. A draft can be saved now, but publication requires at least one item.</p>
                ) : (
                  <div className="admin-item-ledger">
                    {model.items.map((item, index) => {
                      const itemErrors: AdminChangelogItemErrors = errors.itemErrors[index] ?? {};
                      return (
                        <fieldset className="admin-item-editor" key={item.clientId}>
                          <legend>Item {index + 1}</legend>
                          <div className="admin-item-editor__toolbar">
                            <span className="admin-item-order">Sort order {index}</span>
                            <div className="admin-item-editor__actions">
                              <Button variant="quiet" disabled={index === 0} onClick={() => moveItem(index, -1)}>Move up</Button>
                              <Button variant="quiet" disabled={index === model.items.length - 1} onClick={() => moveItem(index, 1)}>Move down</Button>
                              <Button variant="outline" onClick={() => removeItem(index)}>Remove</Button>
                            </div>
                          </div>
                          <div className="admin-form-grid admin-form-grid--item-meta">
                            <div className="admin-field">
                              <label htmlFor={`admin-item-${item.clientId}-category`}>Category *</label>
                              <select
                                id={`admin-item-${item.clientId}-category`}
                                className="admin-select"
                                value={item.category}
                                aria-invalid={itemErrors.category ? true : undefined}
                                aria-describedby={itemErrors.category ? `admin-item-${item.clientId}-category-error` : undefined}
                                onChange={(event) => updateItem(index, { category: event.currentTarget.value as AdminChangelogEditorItem["category"] })}
                              >
                                {CHANGELOG_CATEGORIES.map((category) => (
                                  <option value={category} key={category}>{category}</option>
                                ))}
                              </select>
                              {itemErrors.category ? <p id={`admin-item-${item.clientId}-category-error`} className="admin-field__error" role="alert">{itemErrors.category}</p> : null}
                            </div>
                            <EditorField
                              id={`admin-item-${item.clientId}-area`}
                              label="Area"
                              value={item.area}
                              error={itemErrors.area}
                              maxLength={100}
                              onChange={(area) => updateItem(index, { area })}
                            />
                          </div>
                          <EditorField
                            id={`admin-item-${item.clientId}-title`}
                            label="Item title"
                            value={item.title}
                            error={itemErrors.title}
                            required
                            maxLength={240}
                            onChange={(title) => updateItem(index, { title })}
                          />
                          <EditorTextarea
                            id={`admin-item-${item.clientId}-description`}
                            label="Description"
                            value={item.description}
                            error={itemErrors.description}
                            required
                            maxLength={8_000}
                            rows={4}
                            onChange={(description) => updateItem(index, { description })}
                          />
                        </fieldset>
                      );
                    })}
                  </div>
                )}
              </section>
            </fieldset>
          </form>
        </div>

        <aside className="admin-publish-checks" aria-labelledby="admin-publish-checks-title">
          <div className="admin-publish-checks__header">
            <h2 id="admin-publish-checks-title">Publish checks</h2>
            <p>Checks use the current form. Publication uses the latest saved revision.</p>
          </div>
          <ul>
            {checks.map((check) => (
              <li className={check.passed ? "is-passing" : "is-blocking"} key={check.id}>
                <span aria-hidden="true">{check.passed ? "■" : "▲"}</span>
                <span>{check.label}</span>
              </li>
            ))}
          </ul>
        </aside>
      </div>

      {dialog !== null && release !== null ? (
        <ReleaseActionDialog
          kind={dialog.kind}
          version={release.latest.version}
          blockers={dialog.kind === "publish"
            ? [...new Set([...publishBlockers, ...dialog.serverBlockers])]
            : []}
          requiresSecurityAcknowledgement={
            dialog.kind === "publish"
            && release.latest.items.some((item) => item.category === "security")
          }
          pending={mutationPending}
          error={dialog.error}
          onClose={() => {
            if (!mutationPending) setDialog(null);
          }}
          onConfirm={confirmReleaseAction}
        />
      ) : null}
    </section>
  );
}
