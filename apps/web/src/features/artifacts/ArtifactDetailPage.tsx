import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import {
  type ArtifactDetail,
  type ArtifactsAdapter,
  type GetArtifactAdapterResult,
  type ShareLinkResource,
  httpArtifactsAdapter,
  isArtifactId,
} from "../../lib/api/artifacts";
import { ArtifactUploadDialog } from "./ArtifactUploadDialog";
import {
  ArtifactPlate,
  ShareStatusBadge,
  VerificationBadge,
  formatBytes,
  formatDimensions,
  formatTimestamp,
  formatVersionSource,
  shareDisplayStatus,
} from "./artifact-display";
import { createArtifactIdempotencyKey } from "./artifact-idempotency";
import { CreateShareLinkDialog } from "./CreateShareLinkDialog";
import "./artifacts.css";

type DetailState = { readonly kind: "loading" } | GetArtifactAdapterResult;
type ShareMutationBusy = "create" | "revoke" | "upload" | null;

interface FrozenRevokeRequest {
  readonly artifactId: string;
  readonly shareLinkId: string;
  readonly idempotencyKey: string;
}

type RevokeState =
  | { readonly operation: FrozenRevokeRequest; readonly kind: "confirming" }
  | { readonly operation: FrozenRevokeRequest; readonly kind: "pending" }
  | {
      readonly operation: FrozenRevokeRequest;
      readonly kind: "error";
      readonly message: string;
      readonly exactRetry: boolean;
    }
  | { readonly operation: FrozenRevokeRequest; readonly kind: "success"; readonly message: string };

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function DetailFacts({ artifact }: { artifact: ArtifactDetail }) {
  const current = artifact.currentVersion;
  return (
    <dl className="artifact-detail-facts">
      <div>
        <dt>Artifact ID</dt>
        <dd><code>{artifact.id}</code></dd>
      </div>
      <div>
        <dt>Media kind</dt>
        <dd>{artifact.mediaKind}</dd>
      </div>
      <div>
        <dt>Created</dt>
        <dd><time dateTime={artifact.createdAt}>{formatTimestamp(artifact.createdAt)}</time></dd>
      </div>
      <div>
        <dt>Source run</dt>
        <dd>
          {artifact.sourceRunId === null
            ? "Not provided"
            : (
              <Link
                className="artifact-source-link"
                to={`/dashboard/runs/${encodeURIComponent(artifact.sourceRunId)}`}
              >
                <code>{artifact.sourceRunId}</code>
              </Link>
            )}
        </dd>
      </div>
      <div>
        <dt>Current version</dt>
        <dd>{current === null ? "Not available" : `Version ${current.sequence}`}</dd>
      </div>
      <div>
        <dt>Sharing</dt>
        <dd>{artifact.shared ? "At least one active share" : "No active shares"}</dd>
      </div>
    </dl>
  );
}

function VersionTable({ artifact }: { artifact: ArtifactDetail }) {
  const versions = [...artifact.versions].sort((left, right) => right.sequence - left.sequence);
  return (
    <div className="artifact-table-scroll" tabIndex={0} aria-label="Scrollable artifact version history">
      <table className="artifact-table">
        <caption>Immutable versions for {artifact.name}</caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Representation</th>
            <th scope="col">Size</th>
            <th scope="col">Source</th>
            <th scope="col">Verification</th>
            <th scope="col">Created</th>
            <th scope="col">SHA-256</th>
          </tr>
        </thead>
        <tbody>
          {versions.length === 0 ? (
            <tr>
              <td colSpan={7} className="artifact-table__empty">No artifact versions were returned.</td>
            </tr>
          ) : versions.map((version) => (
            <tr key={version.id}>
              <th scope="row">
                <span className="artifact-version-cell">
                  <strong>v{version.sequence}</strong>
                  <code>{version.id}</code>
                  {artifact.currentVersion?.id === version.id ? <StatusBadge>Current</StatusBadge> : null}
                </span>
              </th>
              <td>
                <span>{version.mimeType}</span>
                <small>{formatDimensions(version)}</small>
              </td>
              <td>{formatBytes(version.sizeBytes)}</td>
              <td>
                <span>{formatVersionSource(version.source)}</span>
                <small>
                  {version.sourceRunId === null
                    ? "No source run"
                    : (
                      <Link
                        className="artifact-source-link"
                        to={`/dashboard/runs/${encodeURIComponent(version.sourceRunId)}`}
                      >
                        {version.sourceRunId}
                      </Link>
                    )}
                </small>
              </td>
              <td><VerificationBadge status={version.verificationStatus} /></td>
              <td><time dateTime={version.createdAt}>{formatTimestamp(version.createdAt)}</time></td>
              <td><code className="artifact-checksum">{version.sha256}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ShareTableProps {
  readonly artifact: ArtifactDetail;
  readonly adapter: ArtifactsAdapter;
  readonly mutationBusy: ShareMutationBusy;
  readonly onAuthExpired: () => void;
  readonly onMutationBusyChange: (busy: ShareMutationBusy) => void;
  readonly onShareRevoked: (artifactId: string, shareLinkId: string) => void;
}

function ShareTable({
  artifact,
  adapter,
  mutationBusy,
  onAuthExpired,
  onMutationBusyChange,
  onShareRevoked,
}: ShareTableProps) {
  const [revokeState, setRevokeState] = useState<RevokeState | null>(null);
  const activeRef = useRef(false);
  const revokeGenerationRef = useRef(0);
  const artifactIdRef = useRef(artifact.id);
  const revokeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const revokeRowRef = useRef<HTMLElement | null>(null);
  const mutationStatusRef = useRef<HTMLDivElement | null>(null);
  artifactIdRef.current = artifact.id;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      revokeGenerationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    revokeGenerationRef.current += 1;
    setRevokeState(null);
    revokeTriggerRef.current = null;
    revokeRowRef.current = null;
  }, [artifact.id]);

  useEffect(() => {
    if (
      revokeState?.kind === "pending"
      || revokeState?.kind === "error"
      || revokeState?.kind === "success"
    ) {
      mutationStatusRef.current?.focus();
    }
  }, [revokeState]);

  function beginConfirmation(shareLinkId: string, trigger: HTMLButtonElement) {
    if (mutationBusy !== null || revokeState !== null) return;
    const operation = Object.freeze({
      artifactId: artifact.id,
      shareLinkId,
      idempotencyKey: createArtifactIdempotencyKey("share-revoke"),
    });
    revokeTriggerRef.current = trigger;
    revokeRowRef.current = trigger.closest("tr")?.querySelector("th") ?? null;
    onMutationBusyChange("revoke");
    setRevokeState({ operation, kind: "confirming" });
  }

  function dismissRevoke() {
    revokeGenerationRef.current += 1;
    setRevokeState(null);
    onMutationBusyChange(null);
    const trigger = revokeTriggerRef.current;
    const row = revokeRowRef.current;
    window.setTimeout(() => {
      if (!activeRef.current) return;
      if (trigger?.isConnected && !trigger.disabled) trigger.focus();
      else if (row?.isConnected) row.focus();
    }, 0);
  }

  async function revoke() {
    if (revokeState === null || revokeState.kind === "pending" || mutationBusy !== "revoke") return;
    const operation = revokeState.operation;
    const generation = ++revokeGenerationRef.current;
    setRevokeState({ operation, kind: "pending" });
    try {
      const result = await adapter.revokeShareLink(
        operation.artifactId,
        operation.shareLinkId,
        operation.idempotencyKey,
      );
      if (result.kind === "auth-expired") {
        if (activeRef.current && generation === revokeGenerationRef.current) {
          onMutationBusyChange(null);
        }
        onAuthExpired();
        return;
      }
      if (
        !activeRef.current
        || generation !== revokeGenerationRef.current
        || artifactIdRef.current !== operation.artifactId
      ) return;
      if (result.kind === "revoked" || result.kind === "already_revoked") {
        onShareRevoked(operation.artifactId, operation.shareLinkId);
        onMutationBusyChange(null);
        setRevokeState({
          operation,
          kind: "success",
          message: result.kind === "already_revoked"
            ? "Relay confirmed this share link was already revoked."
            : result.replayed
              ? "Share link revoked. Relay replayed the stored result; no second revocation was created."
              : "Share link revoked. Future Relay resolutions are blocked.",
        });
        return;
      }
      if (result.kind === "unknown_outcome") {
        setRevokeState({
          operation,
          kind: "error",
          message: result.message,
          exactRetry: true,
        });
        return;
      }
      setRevokeState({
        operation,
        kind: "error",
        message: result.kind === "not_found"
          ? "Relay could not find this share link."
          : result.kind === "idempotency-conflict"
            ? "The revocation idempotency key conflicts with a different request. This frozen request cannot be retried."
            : result.message,
        exactRetry: false,
      });
    } catch {
      if (
        !activeRef.current
        || generation !== revokeGenerationRef.current
        || artifactIdRef.current !== operation.artifactId
      ) return;
      setRevokeState({
        operation,
        kind: "error",
        message: "Relay could not confirm the revocation result. Retry only this exact frozen request with the same idempotency key.",
        exactRetry: true,
      });
    }
  }

  return (
    <div className="artifact-table-scroll" tabIndex={0} aria-label="Scrollable artifact share records">
      <table className="artifact-table artifact-share-table">
        <caption>Share records for {artifact.name}. Existing records do not expose the token value shown at creation.</caption>
        <thead>
          <tr>
            <th scope="col">Share record</th>
            <th scope="col">Status</th>
            <th scope="col">Version policy</th>
            <th scope="col">Expiry</th>
            <th scope="col">Resolutions</th>
            <th scope="col">Access and delivery</th>
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {artifact.shares.length === 0 ? (
            <tr>
              <td colSpan={7} className="artifact-table__empty">
                No share records exist for this artifact.
              </td>
            </tr>
          ) : artifact.shares.map((share) => {
            const displayStatus = shareDisplayStatus(share);
            const mutation = revokeState?.operation.shareLinkId === share.id ? revokeState : null;
            return (
              <ShareRows
                key={share.id}
                share={share}
                displayStatus={displayStatus}
                mutation={mutation}
                mutationBusy={mutationBusy}
                anotherRevokeOpen={revokeState !== null && mutation === null}
                onConfirm={(trigger) => beginConfirmation(share.id, trigger)}
                onCancel={dismissRevoke}
                onRevoke={() => void revoke()}
                setStatusElement={(element) => {
                  mutationStatusRef.current = element;
                }}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface ShareRowsProps {
  readonly share: ShareLinkResource;
  readonly displayStatus: ReturnType<typeof shareDisplayStatus>;
  readonly mutation: RevokeState | null;
  readonly mutationBusy: ShareMutationBusy;
  readonly anotherRevokeOpen: boolean;
  readonly onConfirm: (trigger: HTMLButtonElement) => void;
  readonly onCancel: () => void;
  readonly onRevoke: () => void;
  readonly setStatusElement: (element: HTMLDivElement | null) => void;
}

function ShareRows({
  share,
  displayStatus,
  mutation,
  mutationBusy,
  anotherRevokeOpen,
  onConfirm,
  onCancel,
  onRevoke,
  setStatusElement,
}: ShareRowsProps) {
  const canRevoke = share.status === "active";
  return (
    <>
      <tr className={displayStatus.inactive ? "artifact-share-row is-inactive" : "artifact-share-row"}>
        <th scope="row" tabIndex={-1}><code>{share.id}</code></th>
        <td><ShareStatusBadge share={share} /></td>
        <td>
          {share.followCurrent
            ? "Follows current"
            : <span>Version <code>{share.artifactVersionId}</code></span>}
        </td>
        <td>
          {share.expiresAt === null
            ? "No expiry"
            : <time dateTime={share.expiresAt}>{formatTimestamp(share.expiresAt)}</time>}
        </td>
        <td>
          {share.resolutionCount} / {share.maxResolutions === null ? "unlimited" : share.maxResolutions}
        </td>
        <td>
          <span>{share.requireAuth ? "Current workspace membership required" : "Anyone with the link"}</span>
          <small>{share.contentDisposition === "inline" ? "Open inline" : "Download attachment"}</small>
        </td>
        <td className="artifact-table__action">
          {canRevoke ? (
            <Button
              variant="outline"
              disabled={mutationBusy !== null || anotherRevokeOpen || mutation !== null}
              onClick={(event) => onConfirm(event.currentTarget)}
              aria-label={`Revoke share ${share.id}`}
            >
              Revoke
            </Button>
          ) : (
            <span className="artifact-table__settled">No action</span>
          )}
        </td>
      </tr>
      {mutation !== null ? (
        <tr className="artifact-share-mutation-row">
          <td colSpan={7}>
            {mutation.kind === "confirming" ? (
              <div className="artifact-share-confirm" role="group" aria-label={`Confirm revoke for ${share.id}`}>
                <p>
                  Revoke this share? Future Relay resolutions will be blocked, but an authorization already issued may remain valid until it expires.
                </p>
                <div>
                  <Button autoFocus variant="outline" onClick={onRevoke}>Confirm revoke</Button>
                  <Button variant="quiet" onClick={onCancel}>Keep share</Button>
                </div>
              </div>
            ) : (
              <div
                ref={setStatusElement}
                className={`artifact-share-mutation-status share-mutation-message${
                  mutation.kind === "error"
                    ? " share-mutation-message--error"
                    : mutation.kind === "success"
                      ? " share-mutation-message--success"
                      : ""
                }`}
                role={mutation.kind === "error" ? "alert" : "status"}
                aria-live={mutation.kind === "error" ? "assertive" : "polite"}
                tabIndex={-1}
              >
                <span aria-hidden="true">
                  {mutation.kind === "pending" ? "□" : mutation.kind === "error" ? "▲" : "■"}
                </span>
                <div>
                  <p>
                    {mutation.kind === "pending"
                      ? "Revoking share link with the frozen request and stable idempotency key."
                      : mutation.message}
                  </p>
                  {mutation.kind === "error" ? (
                    <div className="artifact-share-mutation-status__actions">
                      {mutation.exactRetry ? (
                        <Button variant="outline" onClick={onRevoke}>Retry exact request</Button>
                      ) : null}
                      <Button variant="quiet" onClick={onCancel}>Dismiss</Button>
                    </div>
                  ) : mutation.kind === "success" ? (
                    <div className="artifact-share-mutation-status__actions">
                      <Button variant="quiet" onClick={onCancel}>Dismiss</Button>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}

export interface ArtifactDetailPageProps {
  readonly adapter?: ArtifactsAdapter;
  readonly artifactId?: string;
}

export function ArtifactDetailPage({
  adapter = httpArtifactsAdapter,
  artifactId: artifactIdProp,
}: ArtifactDetailPageProps) {
  usePageMetadata("Artifact details | Relay", "#141A16");
  const params = useParams<{ artifactId: string }>();
  const artifactId = artifactIdProp ?? params.artifactId;
  const { session, workspace, expireSession } = useAuth();
  const sessionId = session.status === "authenticated" ? session.identity.session.id : undefined;
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null);
  const [mutationBusy, setMutationBusy] = useState<ShareMutationBusy>(null);
  const activeRef = useRef(false);
  const detailGenerationRef = useRef(0);
  const detailControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      detailGenerationRef.current += 1;
      detailControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const generation = ++detailGenerationRef.current;
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    setShareDialogOpen(false);
    setUploadDialogOpen(false);
    setMutationBusy(null);
    setRefreshMessage(null);

    if (!isArtifactId(artifactId)) {
      setState({ kind: "not_found" });
      return;
    }

    const controller = new AbortController();
    detailControllerRef.current = controller;
    setState({ kind: "loading" });
    void adapter.get(artifactId, controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (!activeRef.current || generation !== detailGenerationRef.current) return;
      setState(result);
    }).catch((error: unknown) => {
      if (
        isAbortError(error)
        || !activeRef.current
        || generation !== detailGenerationRef.current
      ) return;
      setState({
        kind: "degraded",
        message: "Relay could not load this artifact. No artifact data was changed.",
      });
    }).finally(() => {
      if (detailControllerRef.current === controller) detailControllerRef.current = null;
    });
    return () => controller.abort();
  }, [adapter, artifactId, expireSession, reloadKey, sessionId]);

  async function refreshDetailInPlace() {
    if (!isArtifactId(artifactId)) return;
    const generation = ++detailGenerationRef.current;
    const controller = new AbortController();
    detailControllerRef.current?.abort();
    detailControllerRef.current = controller;
    setRefreshMessage(null);
    try {
      const result = await adapter.get(artifactId, controller.signal);
      if (result.kind === "auth-expired") {
        if (activeRef.current && generation === detailGenerationRef.current) {
          setMutationBusy(null);
        }
        expireSession(sessionId);
        return true;
      }
      if (!activeRef.current || generation !== detailGenerationRef.current) return false;
      if (result.kind === "found" || result.kind === "not_found") {
        setState(result);
        setMutationBusy(null);
      } else {
        setRefreshMessage(mutationBusy === "create"
          ? "Relay could not confirm the current share records. Share mutations remain paused until an authoritative refresh succeeds."
          : result.message);
      }
    } catch (error) {
      if (
        isAbortError(error)
        || !activeRef.current
        || generation !== detailGenerationRef.current
      ) return;
      setRefreshMessage(mutationBusy === "create"
        ? "Relay could not confirm the current share records. Share mutations remain paused until an authoritative refresh succeeds."
        : "Relay could not refresh the share table.");
    } finally {
      if (detailControllerRef.current === controller) detailControllerRef.current = null;
    }
  }

  function reconcileRevokedShare(requestArtifactId: string, shareLinkId: string) {
    detailGenerationRef.current += 1;
    detailControllerRef.current?.abort();
    detailControllerRef.current = null;
    setState((current) => {
      if (current.kind !== "found" || current.artifact.id !== requestArtifactId) return current;
      const shares = current.artifact.shares.map((share) => share.id === shareLinkId
        ? { ...share, status: "revoked" as const }
        : share);
      return {
        kind: "found",
        artifact: {
          ...current.artifact,
          shares,
          shared: shares.some((share) => share.status === "active"),
        },
      };
    });
  }

  function openShareDialog() {
    if (mutationBusy === null) setShareDialogOpen(true);
  }

  function openUploadDialog() {
    if (mutationBusy !== null) return;
    setMutationBusy("upload");
    setUploadDialogOpen(true);
  }

  const artifact = state.kind === "found" && state.artifact.id === artifactId
    ? state.artifact
    : null;
  const workspaceId = workspace.status === "ready" ? workspace.workspace.id : null;

  return (
    <div className="artifact-detail-page product-surface">
      <header className="artifact-page-header artifact-detail-header">
        <div className="artifact-detail-header__title">
          <Link className="artifact-back-link" to="/dashboard/artifacts">Back to artifacts</Link>
          <div>
            <p className="mono-label">
              {workspaceId === null ? "Artifact registry" : `Workspace ${workspaceId}`}
            </p>
            <h1>{artifact === null ? "Artifact detail" : artifact.name}</h1>
          </div>
        </div>
        {artifact !== null ? (
          <div className="artifact-page-header__actions">
            <Button
              variant="outline"
              aria-disabled={mutationBusy !== null ? true : undefined}
              onClick={openUploadDialog}
            >
              Upload new version
            </Button>
            <Button
              disabled={artifact.versions.length === 0}
              aria-disabled={artifact.versions.length > 0 && mutationBusy !== null ? true : undefined}
              onClick={openShareDialog}
            >
              Create share link
            </Button>
          </div>
        ) : null}
      </header>

      <div className="artifact-detail-body" aria-busy={state.kind === "loading" || undefined}>
        {state.kind === "loading" ? <Skeleton label="Loading artifact details" lines={7} /> : null}

        {state.kind === "degraded" ? (
          <InlineNotice
            title="Artifact unavailable"
            tone="error"
            action={<Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>Try again</Button>}
          >
            <p>{state.message}</p>
          </InlineNotice>
        ) : null}

        {state.kind === "not_found" ? (
          <section className="artifact-not-found" aria-labelledby="artifact-not-found-title">
            <p className="mono-label">Artifact registry</p>
            <h2 id="artifact-not-found-title">Artifact not found</h2>
            <p>The artifact does not exist in the active workspace, or it is no longer available.</p>
            <LinkButton variant="outline" to="/dashboard/artifacts">Return to artifacts</LinkButton>
          </section>
        ) : null}

        {refreshMessage ? (
          <InlineNotice
            title="Artifact refresh unavailable"
            tone="warning"
            action={(
              <Button
                variant="outline"
                disabled={mutationBusy === "revoke"}
                onClick={() => void refreshDetailInPlace()}
              >
                {mutationBusy === "create" ? "Inspect share records again" : "Try refresh again"}
              </Button>
            )}
          >
            <p>{refreshMessage}</p>
          </InlineNotice>
        ) : null}

        {artifact !== null ? (
          <>
            <section className="artifact-detail-overview" aria-labelledby="artifact-overview-title">
              <div className="artifact-detail-overview__visual">
                <ArtifactPlate artifact={artifact} compact />
              </div>
              <div className="artifact-detail-overview__content">
                <div className="artifact-section-heading">
                  <div>
                    <p className="mono-label">Registry record</p>
                    <h2 id="artifact-overview-title">Artifact facts</h2>
                  </div>
                  {artifact.currentVersion === null ? (
                    <StatusBadge tone="muted">No current version</StatusBadge>
                  ) : (
                    <VerificationBadge status={artifact.currentVersion.verificationStatus} />
                  )}
                </div>
                <DetailFacts artifact={artifact} />
                {artifact.versions.length === 0 ? (
                  <InlineNotice title="No versions available" tone="warning">
                    <p>A share link cannot be created until this artifact has an immutable version.</p>
                  </InlineNotice>
                ) : null}
              </div>
            </section>

            <section className="artifact-ledger-section" aria-labelledby="artifact-versions-title">
              <div className="artifact-section-heading">
                <div>
                  <p className="mono-label">Newest first</p>
                  <h2 id="artifact-versions-title">Version history</h2>
                </div>
                <span className="artifact-section-count">
                  {artifact.versions.length} {artifact.versions.length === 1 ? "version" : "versions"}
                </span>
              </div>
              <VersionTable artifact={artifact} />
            </section>

            <section className="artifact-ledger-section" aria-labelledby="artifact-shares-title">
              <div className="artifact-section-heading">
                <div>
                  <p className="mono-label">Governed access</p>
                  <h2 id="artifact-shares-title">Share links</h2>
                </div>
                <Button
                  variant="outline"
                  disabled={artifact.versions.length === 0}
                  aria-disabled={artifact.versions.length > 0 && mutationBusy !== null ? true : undefined}
                  onClick={openShareDialog}
                >
                  Create share link
                </Button>
              </div>
              <p className="artifact-section-copy">
                Existing records expose policy and status only. Relay does not return their original public path or token.
              </p>
              <ShareTable
                artifact={artifact}
                adapter={adapter}
                mutationBusy={mutationBusy}
                onAuthExpired={() => expireSession(sessionId)}
                onMutationBusyChange={setMutationBusy}
                onShareRevoked={reconcileRevokedShare}
              />
            </section>
          </>
        ) : null}
      </div>

      {artifact !== null && uploadDialogOpen ? (
        <ArtifactUploadDialog
          adapter={adapter}
          artifact={artifact}
          onAuthExpired={() => expireSession(sessionId)}
          onClose={() => {
            setUploadDialogOpen(false);
            setMutationBusy(null);
          }}
          onCompleted={() => {
            void refreshDetailInPlace();
          }}
        />
      ) : null}

      {artifact !== null && shareDialogOpen ? (
        <CreateShareLinkDialog
          artifact={artifact}
          createShareLink={(request, idempotencyKey) => adapter.createShareLink(request, idempotencyKey)}
          onAuthExpired={() => expireSession(sessionId)}
          onMutationBusyChange={(busy) => setMutationBusy(busy ? "create" : null)}
          onClose={() => setShareDialogOpen(false)}
          onDone={() => {
            setShareDialogOpen(false);
            void refreshDetailInPlace();
          }}
        />
      ) : null}
    </div>
  );
}
