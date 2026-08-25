import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button, LinkButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import type { AdminChangelogSummary } from "../../lib/api/admin-changelog";
import {
  isBoundaryAccessFailure,
  useAdminChangelog,
} from "./AdminChangelogContext";
import { formatUtcTimestamp, isAbortError, releaseStatusPresentation } from "./model";

const PAGE_SIZE = 20;

type ListState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly releases: readonly AdminChangelogSummary[]; readonly hasMore: boolean }
  | { readonly kind: "degraded"; readonly message: string };

function ReleaseStatus({ status }: Pick<AdminChangelogSummary, "status">) {
  const presentation = releaseStatusPresentation(status);
  return (
    <span className={`admin-release-status admin-release-status--${status}`}>
      <span aria-hidden="true">{presentation.glyph}</span>
      <span>{presentation.label}</span>
    </span>
  );
}

function ReleaseTable({ releases }: { readonly releases: readonly AdminChangelogSummary[] }) {
  return (
    <div
      className="admin-changelog-table-region"
      role="region"
      aria-label="Scrollable admin changelog releases"
      tabIndex={0}
    >
      <table className="admin-changelog-table">
        <caption className="sr-only">Admin changelog releases, newest first</caption>
        <thead>
          <tr>
            <th scope="col">Version</th>
            <th scope="col">Status</th>
            <th scope="col">Latest revision</th>
            <th scope="col">Published revision</th>
            <th scope="col">Unpublished changes</th>
            <th scope="col">Updated</th>
            <th scope="col">Action</th>
          </tr>
        </thead>
        <tbody>
          {releases.map((release) => (
            <tr key={release.releaseId}>
              <th scope="row"><code>{release.version}</code></th>
              <td><ReleaseStatus status={release.status} /></td>
              <td><code>{release.latestRevision}</code></td>
              <td>{release.publishedRevision === null ? "Not published" : <code>{release.publishedRevision}</code>}</td>
              <td>{release.hasUnpublishedChanges ? "Yes" : "No"}</td>
              <td>
                <time dateTime={release.updatedAt}>{formatUtcTimestamp(release.updatedAt)}</time>
              </td>
              <td>
                <div className="admin-table-actions">
                  <Link to={`/admin/changelog/${release.releaseId}`}>
                    {release.status === "archived" ? "View" : "Edit"}
                  </Link>
                  <Link to={`/admin/changelog/${release.releaseId}/preview`}>Preview</Link>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminChangelogListPage() {
  usePageMetadata("Admin changelog | Relay", "#141A16");
  const { adapter, reportAccessFailure } = useAdminChangelog();
  const { session } = useAuth();
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const sessionIdRef = useRef(sessionId);
  const activeRef = useRef(true);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [state, setState] = useState<ListState>({ kind: "loading" });
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  sessionIdRef.current = sessionId;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (sessionId === undefined) return;
    const expectedSessionId = sessionId;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setState({ kind: "loading" });
    setLoadingMore(false);
    setPaginationError(null);

    void adapter.list({ limit: PAGE_SIZE }, controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        reportAccessFailure(result, expectedSessionId);
        return;
      }
      if (
        !activeRef.current
        || controller.signal.aborted
        || generation !== generationRef.current
        || sessionIdRef.current !== expectedSessionId
      ) return;
      if (isBoundaryAccessFailure(result)) {
        reportAccessFailure(result, expectedSessionId);
        return;
      }

      if (result.kind === "ok") {
        setState({
          kind: "ready",
          releases: result.releases,
          hasMore: result.releases.length === PAGE_SIZE,
        });
      } else {
        setState({
          kind: "degraded",
          message: result.kind === "degraded"
            ? result.message
            : "Relay could not find the admin changelog collection.",
        });
      }
    }).catch((error: unknown) => {
      if (
        isAbortError(error)
        || !activeRef.current
        || controller.signal.aborted
        || generation !== generationRef.current
        || sessionIdRef.current !== expectedSessionId
      ) return;
      setState({
        kind: "degraded",
        message: "Relay could not load changelog releases. No release data was shown.",
      });
    }).finally(() => {
      if (controllerRef.current === controller) controllerRef.current = null;
    });

    return () => controller.abort();
  }, [adapter, reloadGeneration, reportAccessFailure, sessionId]);

  async function loadMore() {
    if (sessionId === undefined || state.kind !== "ready" || !state.hasMore || loadingMore) return;
    const lastRelease = state.releases[state.releases.length - 1];
    if (lastRelease === undefined) return;
    const expectedSessionId = sessionId;
    const generation = ++generationRef.current;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setLoadingMore(true);
    setPaginationError(null);

    try {
      const result = await adapter.list({
        limit: PAGE_SIZE,
        beforeReleaseId: lastRelease.releaseId,
      }, controller.signal);
      if (result.kind === "auth-expired") {
        reportAccessFailure(result, expectedSessionId);
        return;
      }
      if (
        !activeRef.current
        || controller.signal.aborted
        || generation !== generationRef.current
        || sessionIdRef.current !== expectedSessionId
      ) return;
      if (isBoundaryAccessFailure(result)) {
        reportAccessFailure(result, expectedSessionId);
        return;
      }
      if (result.kind !== "ok") {
        setPaginationError(result.kind === "degraded"
          ? result.message
          : "Relay could not find the next release page.");
        return;
      }

      setState((current) => {
        if (current.kind !== "ready") return current;
        const knownIds = new Set(current.releases.map((release) => release.releaseId));
        const additional = result.releases.filter((release) => !knownIds.has(release.releaseId));
        return {
          kind: "ready",
          releases: [...current.releases, ...additional],
          hasMore: result.releases.length === PAGE_SIZE,
        };
      });
    } catch (error) {
      if (
        isAbortError(error)
        || !activeRef.current
        || controller.signal.aborted
        || generation !== generationRef.current
        || sessionIdRef.current !== expectedSessionId
      ) return;
      setPaginationError("Relay could not load the next release page. Existing rows were not changed.");
    } finally {
      if (
        activeRef.current
        && generation === generationRef.current
        && sessionIdRef.current === expectedSessionId
      ) setLoadingMore(false);
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }

  return (
    <section className="admin-changelog-page" aria-labelledby="admin-changelog-list-title">
      <header className="admin-page-header">
        <div>
          <p className="mono-label">Platform changelog</p>
          <h1 id="admin-changelog-list-title">Releases</h1>
        </div>
        <LinkButton to="/admin/changelog/new">New draft</LinkButton>
      </header>

      <div className="admin-page-body" aria-busy={state.kind === "loading" || loadingMore || undefined}>
        {state.kind === "loading" ? <Skeleton label="Loading changelog releases" lines={7} /> : null}
        {state.kind === "degraded" ? (
          <InlineNotice
            title="Releases unavailable"
            tone="error"
            action={<Button variant="outline" onClick={() => setReloadGeneration((value) => value + 1)}>Try again</Button>}
          >
            <p>{state.message}</p>
          </InlineNotice>
        ) : null}
        {state.kind === "ready" && state.releases.length === 0 ? (
          <EmptyState
            label="Release ledger"
            title="No changelog releases yet"
            actions={<LinkButton to="/admin/changelog/new">Create a draft</LinkButton>}
          >
            <p>Create the first stored release snapshot when release notes are ready.</p>
          </EmptyState>
        ) : null}
        {state.kind === "ready" && state.releases.length > 0 ? (
          <>
            <ReleaseTable releases={state.releases} />
            {paginationError ? (
              <InlineNotice
                title="Next page unavailable"
                tone="error"
                action={<Button variant="outline" onClick={() => void loadMore()}>Try next page again</Button>}
              >
                <p>{paginationError}</p>
              </InlineNotice>
            ) : null}
            {state.hasMore && paginationError === null ? (
              <div className="admin-pagination">
                <Button
                  variant="outline"
                  pending={loadingMore}
                  pendingLabel="Loading releases..."
                  onClick={() => void loadMore()}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
