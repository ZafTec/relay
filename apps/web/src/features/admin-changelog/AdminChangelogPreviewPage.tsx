import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  createAdminChangelogIdempotencyKey,
  type AdminChangelogReleaseDetail,
  type PublishAdminChangelogAdapterResult,
  type PublishAdminChangelogRequest,
} from "../../lib/api/admin-changelog";
import {
  isBoundaryAccessFailure,
  useAdminChangelog,
} from "./AdminChangelogContext";
import { ReleaseActionDialog } from "./ReleaseActionDialog";
import { ReleasePreviewContent } from "./ReleasePreviewContent";
import {
  isAbortError,
  isAdminChangelogReleaseId,
  publishabilityReasonLabel,
  publishChecks,
} from "./model";

type PreviewState =
  | { readonly kind: "loading" }
  | { readonly kind: "found"; readonly release: AdminChangelogReleaseDetail }
  | { readonly kind: "not-found" }
  | { readonly kind: "degraded"; readonly message: string };

interface FrozenPublish {
  readonly releaseId: string;
  readonly payload: PublishAdminChangelogRequest;
  readonly key: string;
  readonly message: string;
}

interface PreviewDialogState {
  readonly error: string | null;
  readonly serverBlockers: readonly string[];
}

export function AdminChangelogPreviewPage() {
  usePageMetadata("Admin changelog preview | Relay", "#141A16");
  const params = useParams<{ releaseId: string }>();
  const releaseId = params.releaseId;
  const { adapter, reportAccessFailure } = useAdminChangelog();
  const { session } = useAuth();
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const scopeKey = `${sessionId ?? "none"}:${releaseId ?? "invalid"}`;
  const [state, setState] = useState<PreviewState>({ kind: "loading" });
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [dialog, setDialog] = useState<PreviewDialogState | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [frozen, setFrozen] = useState<FrozenPublish | null>(null);
  const [reloadRequired, setReloadRequired] = useState<string | null>(null);
  const activeRef = useRef(true);
  const scopeKeyRef = useRef(scopeKey);
  const sessionIdRef = useRef(sessionId);
  const readGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const readControllerRef = useRef<AbortController | null>(null);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const frozenRef = useRef<HTMLDivElement>(null);
  const conflictRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
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
    setPending(false);
    setFrozen(null);
    setReloadRequired(null);
    setNotice(null);

    if (sessionId === undefined) return;
    if (!isAdminChangelogReleaseId(releaseId)) {
      readGenerationRef.current += 1;
      readControllerRef.current?.abort();
      setState({ kind: "not-found" });
      return;
    }
    const expectedSessionId = sessionId;
    const expectedScopeKey = scopeKey;
    const generation = ++readGenerationRef.current;
    const controller = new AbortController();
    readControllerRef.current?.abort();
    readControllerRef.current = controller;
    setState({ kind: "loading" });

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
      if (result.kind === "found") setState({ kind: "found", release: result.release });
      else if (result.kind === "not-found") setState({ kind: "not-found" });
      else setState({ kind: "degraded", message: result.message });
    }).catch((error: unknown) => {
      if (
        isAbortError(error)
        || !activeRef.current
        || controller.signal.aborted
        || generation !== readGenerationRef.current
        || scopeKeyRef.current !== expectedScopeKey
        || sessionIdRef.current !== expectedSessionId
      ) return;
      setState({
        kind: "degraded",
        message: "Relay could not load the stored changelog revision. No preview data was shown.",
      });
    }).finally(() => {
      if (readControllerRef.current === controller) readControllerRef.current = null;
    });

    return () => controller.abort();
  }, [adapter, releaseId, reloadGeneration, reportAccessFailure, scopeKey, sessionId]);

  useEffect(() => {
    if (frozen !== null) frozenRef.current?.focus();
  }, [frozen]);

  useEffect(() => {
    if (reloadRequired !== null) conflictRef.current?.focus();
  }, [reloadRequired]);

  useEffect(() => {
    if (notice !== null) noticeRef.current?.focus();
  }, [notice]);

  const release = state.kind === "found" ? state.release : null;
  const checks = useMemo(() => release === null ? [] : publishChecks(release.latest), [release]);
  const blockers = checks.filter((check) => !check.passed).map((check) => check.label);
  const publishEligible = release !== null
    && blockers.length === 0
    && (release.status !== "published" || release.hasUnpublishedChanges)
    && frozen === null
    && reloadRequired === null;

  function previewStateLabel(detail: AdminChangelogReleaseDetail): string {
    if (detail.publishedRevision === null) return "Not published";
    if (detail.hasUnpublishedChanges) return "Published revision differs";
    return detail.status === "published" ? "Matches published revision" : "Not published";
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

  async function refreshAfterSuccess(
    targetReleaseId: string,
    expectedSessionId: string,
    expectedScopeKey: string,
    mutationGeneration: number,
    message: string,
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
        setState({ kind: "found", release: result.release });
        setNotice(message);
        setReloadRequired(null);
      } else if (result.kind === "not-found") {
        setState({ kind: "not-found" });
      } else {
        setReloadRequired(`${message} Relay could not load the authoritative release. Reload before another action.`);
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
      setReloadRequired(`${message} Relay could not load the authoritative release. Reload before another action.`);
    } finally {
      if (readControllerRef.current === controller) readControllerRef.current = null;
    }
  }

  function conflictMessage(result: { readonly kind: string; readonly actualRevision?: number }): string {
    if (result.kind === "revision-conflict") {
      return `The release advanced to revision ${result.actualRevision ?? "unknown"}. Reload the authoritative release before publishing.`;
    }
    return "The release changed before publication completed. Reload the authoritative release before publishing.";
  }

  function handlePublishFailure(
    result: PublishAdminChangelogAdapterResult,
    operation: FrozenPublish,
    retrying: boolean,
  ) {
    if (result.kind === "unknown-outcome") {
      setDialog(null);
      setFrozen({ ...operation, message: result.message });
    } else if (result.kind === "not-publishable") {
      setFrozen(null);
      setDialog({
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
      setDialog(null);
      setFrozen(null);
      setReloadRequired(conflictMessage(result));
    } else if (result.kind === "not-found") {
      setDialog(null);
      setState({ kind: "not-found" });
    } else if (result.kind === "degraded") {
      if (retrying) {
        setFrozen({
          ...operation,
          message: `${operation.message} The exact retry was rejected: ${result.message}`,
        });
      } else {
        setDialog((current) => current === null ? null : { ...current, error: result.message });
      }
    }
  }

  async function executePublish(operation: FrozenPublish, retrying = false) {
    if (sessionId === undefined || pending) return;
    const expectedSessionId = sessionId;
    const expectedScopeKey = scopeKey;
    const generation = ++mutationGenerationRef.current;
    const controller = new AbortController();
    mutationControllerRef.current?.abort();
    mutationControllerRef.current = controller;
    setPending(true);
    setNotice(null);

    try {
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
        setFrozen(null);
        setDialog(null);
        const message = result.kind === "published"
          ? `Revision ${result.revision} published.`
          : result.kind === "superseded"
            ? `Revision ${result.revision} published. Revision ${result.supersededRevision} is archived.`
            : `Revision ${result.revision} was already published.`;
        await refreshAfterSuccess(
          operation.releaseId,
          expectedSessionId,
          expectedScopeKey,
          generation,
          message,
        );
      } else {
        handlePublishFailure(result, operation, retrying);
      }
    } catch (error) {
      if (
        !activeRef.current
        || generation !== mutationGenerationRef.current
        || scopeKeyRef.current !== expectedScopeKey
        || sessionIdRef.current !== expectedSessionId
      ) return;
      if (isAbortError(error) && controller.signal.aborted && scopeKeyRef.current !== expectedScopeKey) return;
      setDialog(null);
      setFrozen({
        ...operation,
        message: "Relay could not confirm the publish result. Retry only this exact request with its existing idempotency key.",
      });
    } finally {
      if (
        activeRef.current
        && generation === mutationGenerationRef.current
        && scopeKeyRef.current === expectedScopeKey
        && sessionIdRef.current === expectedSessionId
      ) setPending(false);
      if (mutationControllerRef.current === controller) mutationControllerRef.current = null;
    }
  }

  function confirmPublish() {
    if (release === null || !publishEligible || pending) return;
    const operation: FrozenPublish = {
      releaseId: release.releaseId,
      payload: { expectedRevision: release.latestRevision },
      key: createAdminChangelogIdempotencyKey("publish"),
      message: "Relay could not confirm whether the stored revision was published.",
    };
    void executePublish(operation);
  }

  function reload() {
    setFrozen(null);
    setReloadRequired(null);
    setNotice(null);
    setReloadGeneration((value) => value + 1);
  }

  if (state.kind === "loading") {
    return (
      <section className="admin-preview-page" aria-labelledby="admin-preview-loading-title">
        <header className="admin-preview-toolbar">
          <div><span>Preview</span><strong>Loading stored revision</strong></div>
        </header>
        <div className="admin-page-body">
          <h1 className="sr-only" id="admin-preview-loading-title">Loading changelog preview</h1>
          <Skeleton label="Loading stored changelog revision" lines={8} />
        </div>
      </section>
    );
  }

  if (state.kind === "not-found") {
    return (
      <section className="admin-changelog-page" aria-labelledby="admin-preview-not-found-title">
        <header className="admin-page-header">
          <div><p className="mono-label">Stored revision preview</p><h1 id="admin-preview-not-found-title">Release not found</h1></div>
        </header>
        <div className="admin-page-body">
          <InlineNotice title="Preview unavailable" tone="error"><p>The stored release was not found. No preview data was shown.</p></InlineNotice>
          <LinkButton variant="outline" to="/admin/changelog">Return to release list</LinkButton>
        </div>
      </section>
    );
  }

  if (state.kind === "degraded") {
    return (
      <section className="admin-changelog-page" aria-labelledby="admin-preview-degraded-title">
        <header className="admin-page-header">
          <div><p className="mono-label">Stored revision preview</p><h1 id="admin-preview-degraded-title">Preview unavailable</h1></div>
        </header>
        <div className="admin-page-body">
          <InlineNotice title="Stored revision not loaded" tone="error" action={<Button variant="outline" onClick={reload}>Try again</Button>}>
            <p>{state.message}</p>
          </InlineNotice>
          <LinkButton variant="quiet" to="/admin/changelog">Return to release list</LinkButton>
        </div>
      </section>
    );
  }

  const combinedDialogBlockers = dialog === null
    ? blockers
    : [...new Set([...blockers, ...dialog.serverBlockers])];

  return (
    <section className="admin-preview-page">
      <header className="admin-preview-toolbar">
        <div className="admin-preview-toolbar__state">
          <span>Preview</span>
          <strong>{previewStateLabel(state.release)}</strong>
          <small>Latest stored revision {state.release.latestRevision}. This preview is not a public page.</small>
        </div>
        {frozen === null && reloadRequired === null ? (
          <div className="admin-preview-toolbar__actions">
            <LinkButton variant="outline" to={`/admin/changelog/${state.release.releaseId}`}>Back to editor</LinkButton>
            {publishEligible ? <Button onClick={() => setDialog({ error: null, serverBlockers: [] })}>Publish</Button> : null}
          </div>
        ) : null}
      </header>

      {notice ? (
        <div
          className="admin-preview-notice admin-action-notice"
          ref={noticeRef}
          tabIndex={-1}
        >
          <InlineNotice title="Release state updated" tone="success">
            <p>{notice}</p>
          </InlineNotice>
        </div>
      ) : null}

      {frozen !== null ? (
        <div className="admin-mutation-lock admin-preview-lock" role="alert" tabIndex={-1} ref={frozenRef}>
          <p className="mono-label">Outcome unknown</p>
          <h2>Publication result is unknown</h2>
          <p>{frozen.message} Retry only the exact saved request with the same idempotency key, or return to the release list.</p>
          <div className="admin-inline-actions">
            <Button pending={pending} pendingLabel="Retrying exact request..." onClick={() => void executePublish(frozen, true)}>Retry exact request</Button>
            <LinkButton variant="outline" to="/admin/changelog">Return to release list</LinkButton>
          </div>
        </div>
      ) : null}

      {reloadRequired !== null ? (
        <div className="admin-mutation-lock admin-preview-lock" role="alert" tabIndex={-1} ref={conflictRef}>
          <p className="mono-label">Authoritative reload required</p>
          <h2>Release changed</h2>
          <p>{reloadRequired}</p>
          <div className="admin-inline-actions">
            <Button onClick={reload}>Reload authoritative release</Button>
            <LinkButton variant="outline" to="/admin/changelog">Return to release list</LinkButton>
          </div>
        </div>
      ) : null}

      <ReleasePreviewContent snapshot={state.release.latest} revision={state.release.latestRevision} />

      {!publishEligible && frozen === null && reloadRequired === null && blockers.length > 0 ? (
        <aside className="admin-preview-blockers" aria-label="Publication blockers">
          <p>Publication is unavailable for this stored revision.</p>
          <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
        </aside>
      ) : null}

      {dialog !== null ? (
        <ReleaseActionDialog
          kind="publish"
          version={state.release.latest.version}
          blockers={combinedDialogBlockers}
          requiresSecurityAcknowledgement={state.release.latest.items.some(
            (item) => item.category === "security"
          )}
          pending={pending}
          error={dialog.error}
          onClose={() => {
            if (!pending) setDialog(null);
          }}
          onConfirm={confirmPublish}
        />
      ) : null}
    </section>
  );
}
