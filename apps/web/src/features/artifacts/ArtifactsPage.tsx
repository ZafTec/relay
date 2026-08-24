import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import {
  type ArtifactSummary,
  type ArtifactsAdapter,
  type ListArtifactsAdapterResult,
  type ListArtifactsRequest,
  httpArtifactsAdapter,
} from "../../lib/api/artifacts";
import { ArtifactPlate, VerificationBadge, formatBytes, formatTimestamp } from "./artifact-display";
import "./artifacts.css";

interface ArtifactFilters {
  readonly search: string;
  readonly mediaKind: string;
  readonly sharing: "all" | "shared" | "private";
}

interface FilterErrors {
  readonly search?: string;
  readonly mediaKind?: string;
}

type GalleryState = { readonly kind: "loading" } | ListArtifactsAdapterResult;

const EMPTY_FILTERS: ArtifactFilters = {
  search: "",
  mediaKind: "",
  sharing: "all",
};
const MEDIA_KIND_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;
const PAGE_SIZE = 25;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function requestFor(filters: ArtifactFilters, cursor?: string): ListArtifactsRequest {
  const search = filters.search.trim();
  const mediaKind = filters.mediaKind.trim();
  return {
    limit: PAGE_SIZE,
    ...(cursor === undefined ? {} : { cursor }),
    ...(search.length === 0 ? {} : { search }),
    ...(mediaKind.length === 0 ? {} : { mediaKind }),
    ...(filters.sharing === "all" ? {} : { shared: filters.sharing === "shared" }),
  };
}

function validateFilters(filters: ArtifactFilters): FilterErrors {
  const search = filters.search.trim();
  const mediaKind = filters.mediaKind.trim();
  return {
    ...(search.length > 100 ? { search: "Search must be 100 characters or fewer." } : {}),
    ...(mediaKind.length > 0 && !MEDIA_KIND_PATTERN.test(mediaKind)
      ? { mediaKind: "Use a lowercase media kind with letters, numbers, dots, underscores, or hyphens." }
      : {}),
  };
}

function hasFilters(filters: ArtifactFilters): boolean {
  return filters.search.length > 0 || filters.mediaKind.length > 0 || filters.sharing !== "all";
}

function appendUnique(
  current: readonly ArtifactSummary[],
  incoming: readonly ArtifactSummary[],
): readonly ArtifactSummary[] {
  const byId = new Map(current.map((artifact) => [artifact.id, artifact]));
  for (const artifact of incoming) byId.set(artifact.id, artifact);
  return Array.from(byId.values());
}

function ArtifactCard({ artifact }: { artifact: ArtifactSummary }) {
  return (
    <Link
      className="artifact-card"
      to={`/dashboard/artifacts/${encodeURIComponent(artifact.id)}`}
      aria-label={`Open artifact ${artifact.name}`}
    >
      <ArtifactPlate artifact={artifact} />
      <div className="artifact-card__body">
        <div className="artifact-card__heading">
          <h2>{artifact.name}</h2>
          {artifact.shared ? <StatusBadge>Shared</StatusBadge> : null}
        </div>
        <code>{artifact.id}</code>
        <dl className="artifact-card__facts">
          <div>
            <dt>Current</dt>
            <dd>
              {artifact.currentVersion === null
                ? "No version"
                : `v${artifact.currentVersion.sequence}`}
            </dd>
          </div>
          <div>
            <dt>Size</dt>
            <dd>
              {artifact.currentVersion === null
                ? "Not available"
                : formatBytes(artifact.currentVersion.sizeBytes)}
            </dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd><time dateTime={artifact.createdAt}>{formatTimestamp(artifact.createdAt)}</time></dd>
          </div>
        </dl>
        {artifact.currentVersion !== null ? (
          <VerificationBadge status={artifact.currentVersion.verificationStatus} />
        ) : (
          <StatusBadge tone="muted">No current version</StatusBadge>
        )}
      </div>
    </Link>
  );
}

export interface ArtifactsPageProps {
  readonly adapter?: ArtifactsAdapter;
}

export function ArtifactsPage({ adapter = httpArtifactsAdapter }: ArtifactsPageProps) {
  usePageMetadata("Artifacts | Relay", "#141A16");
  const { session, workspace, expireSession } = useAuth();
  const sessionId = session.status === "authenticated" ? session.identity.session.id : undefined;
  const [draftFilters, setDraftFilters] = useState<ArtifactFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<ArtifactFilters>(EMPTY_FILTERS);
  const [filterErrors, setFilterErrors] = useState<FilterErrors>({});
  const [state, setState] = useState<GalleryState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const activeRef = useRef(false);
  const listGenerationRef = useRef(0);
  const loadMoreController = useRef<AbortController | null>(null);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      listGenerationRef.current += 1;
      loadMoreController.current?.abort();
    };
  }, []);

  useEffect(() => {
    const generation = ++listGenerationRef.current;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    setState({ kind: "loading" });
    setLoadingMore(false);
    setPaginationError(null);

    void adapter.list(requestFor(appliedFilters), controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (!activeRef.current || generation !== listGenerationRef.current) return;
      setState(result);
    }).catch((error: unknown) => {
      if (
        isAbortError(error)
        || !activeRef.current
        || generation !== listGenerationRef.current
      ) return;
      setState({
        kind: "degraded",
        message: "Relay could not load artifacts. No artifact data was changed.",
      });
    });

    return () => controller.abort();
  }, [adapter, appliedFilters, expireSession, reloadKey, sessionId]);

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const next: ArtifactFilters = {
      search: draftFilters.search.trim(),
      mediaKind: draftFilters.mediaKind.trim(),
      sharing: draftFilters.sharing,
    };
    const errors = validateFilters(next);
    setFilterErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setAppliedFilters(next);
  }

  function clearFilters() {
    setDraftFilters(EMPTY_FILTERS);
    setAppliedFilters(EMPTY_FILTERS);
    setFilterErrors({});
  }

  async function loadMore() {
    if (state.kind !== "ok" || state.nextCursor === null || loadingMore) return;
    const generation = ++listGenerationRef.current;
    const cursor = state.nextCursor;
    const controller = new AbortController();
    loadMoreController.current?.abort();
    loadMoreController.current = controller;
    setLoadingMore(true);
    setPaginationError(null);

    try {
      const result = await adapter.list(requestFor(appliedFilters, cursor), controller.signal);
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (!activeRef.current || generation !== listGenerationRef.current) return;
      if (result.kind === "ok") {
        setState((current) => current.kind === "ok" && current.nextCursor === cursor
          ? {
              kind: "ok",
              items: appendUnique(current.items, result.items),
              nextCursor: result.nextCursor,
            }
          : current);
        return;
      }
      setPaginationError(result.kind === "degraded"
        ? result.message
        : "Relay could not find the next artifact page. Existing results remain available.");
    } catch (error) {
      if (
        !isAbortError(error)
        && activeRef.current
        && generation === listGenerationRef.current
      ) {
        setPaginationError("Relay could not load more artifacts. Existing results remain available.");
      }
    } finally {
      if (activeRef.current && generation === listGenerationRef.current) {
        setLoadingMore(false);
        if (loadMoreController.current === controller) loadMoreController.current = null;
      }
    }
  }

  const workspaceId = workspace.status === "ready" ? workspace.workspace.id : null;
  const filtered = hasFilters(appliedFilters);

  return (
    <div className="artifacts-page product-surface">
      <header className="artifact-page-header">
        <div>
          <p className="mono-label">
            {workspaceId === null ? "Workspace context" : `Workspace ${workspaceId}`}
          </p>
          <h1>Artifacts</h1>
        </div>
        <Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
          Refresh
        </Button>
      </header>

      <form className="artifact-filters" role="search" aria-label="Filter artifacts" onSubmit={applyFilters}>
        <div className="artifact-filter artifact-filter--search">
          <label htmlFor="artifact-search">Search</label>
          <input
            id="artifact-search"
            type="search"
            value={draftFilters.search}
            onChange={(event) => {
              const search = event.currentTarget.value;
              setDraftFilters((current) => ({ ...current, search }));
            }}
            aria-invalid={filterErrors.search ? true : undefined}
            aria-describedby={filterErrors.search ? "artifact-search-error" : undefined}
            placeholder="Name or artifact ID"
          />
          {filterErrors.search ? (
            <span id="artifact-search-error" className="artifact-filter__error" role="alert">
              {filterErrors.search}
            </span>
          ) : null}
        </div>

        <div className="artifact-filter">
          <label htmlFor="artifact-media-kind">Media kind</label>
          <input
            id="artifact-media-kind"
            value={draftFilters.mediaKind}
            onChange={(event) => {
              const mediaKind = event.currentTarget.value;
              setDraftFilters((current) => ({ ...current, mediaKind }));
            }}
            aria-invalid={filterErrors.mediaKind ? true : undefined}
            aria-describedby={filterErrors.mediaKind ? "artifact-media-kind-error" : undefined}
            placeholder="All kinds"
          />
          {filterErrors.mediaKind ? (
            <span id="artifact-media-kind-error" className="artifact-filter__error" role="alert">
              {filterErrors.mediaKind}
            </span>
          ) : null}
        </div>

        <div className="artifact-filter">
          <label htmlFor="artifact-sharing">Sharing</label>
          <select
            id="artifact-sharing"
            value={draftFilters.sharing}
            onChange={(event) => {
              const sharing = event.currentTarget.value as ArtifactFilters["sharing"];
              setDraftFilters((current) => ({ ...current, sharing }));
            }}
          >
            <option value="all">All artifacts</option>
            <option value="shared">Shared</option>
            <option value="private">Not shared</option>
          </select>
        </div>

        <div className="artifact-filter-actions">
          <Button type="submit">Apply filters</Button>
          <Button variant="quiet" onClick={clearFilters} disabled={!hasFilters(draftFilters) && !filtered}>
            Clear
          </Button>
        </div>
      </form>

      <section className="artifact-gallery-region" aria-labelledby="artifact-gallery-heading" aria-busy={state.kind === "loading" || undefined}>
        <div className="artifact-gallery-region__heading">
          <div>
            <p className="mono-label">Durable workspace outputs</p>
            <h2 id="artifact-gallery-heading">Artifact registry</h2>
          </div>
          {state.kind === "ok" && state.items.length > 0 ? (
            <p className="artifact-result-count" role="status">
              {state.items.length} {state.items.length === 1 ? "artifact" : "artifacts"} loaded
            </p>
          ) : null}
        </div>

        {state.kind === "loading" ? <Skeleton label="Loading artifacts" lines={6} /> : null}

        {state.kind === "degraded" ? (
          <InlineNotice
            title="Artifact registry unavailable"
            tone="error"
            action={<Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>Try again</Button>}
          >
            <p>{state.message}</p>
          </InlineNotice>
        ) : null}

        {state.kind === "not_found" ? (
          <EmptyState
            label="Artifact registry"
            title="Artifact collection not found"
            actions={<Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>Check again</Button>}
          >
            <p>The active workspace no longer exposes this artifact collection. Refresh the workspace context, then try again.</p>
          </EmptyState>
        ) : null}

        {state.kind === "ok" && state.items.length === 0 && !filtered ? (
          <EmptyState label="Artifact registry" title="No artifacts yet">
            <p>This workspace has no artifacts returned by the API. Run a tool or create an upload through a supported client to add one.</p>
          </EmptyState>
        ) : null}

        {state.kind === "ok" && state.items.length === 0 && filtered ? (
          <EmptyState
            label="Filtered artifact registry"
            title="No matching artifacts"
            actions={<Button variant="outline" onClick={clearFilters}>Clear filters</Button>}
          >
            <p>No artifacts match the applied search, media kind, and sharing filters.</p>
          </EmptyState>
        ) : null}

        {state.kind === "ok" && state.items.length > 0 ? (
          <>
            <div className="artifact-grid">
              {state.items.map((artifact) => <ArtifactCard artifact={artifact} key={artifact.id} />)}
            </div>
            {paginationError ? (
              <div className="artifact-pagination-error" role="alert">
                <span aria-hidden="true">▲</span>
                <p>{paginationError}</p>
              </div>
            ) : null}
            {state.nextCursor !== null ? (
              <div className="artifact-pagination">
                <Button
                  variant="outline"
                  pending={loadingMore}
                  pendingLabel="Loading more"
                  onClick={() => void loadMore()}
                >
                  Load more
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
    </div>
  );
}
