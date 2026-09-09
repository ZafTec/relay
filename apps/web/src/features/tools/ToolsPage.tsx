import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import {
  httpToolsCatalogAdapter,
  type ToolCatalogLoadResult,
  type ToolCatalogRequest,
  type ToolsCatalogAdapter,
  type ToolSummary,
} from "../../lib/api/tools";
import "./tools.css";

type CatalogPageState =
  | Exclude<ToolCatalogLoadResult, { readonly kind: "auth-expired" }>
  | { readonly kind: "loading" };

interface CatalogFilters {
  readonly search: string;
  readonly category: string;
}

const EMPTY_FILTERS: CatalogFilters = Object.freeze({
  search: "",
  category: "",
});

export interface ToolsPageProps {
  readonly toolsAdapter?: ToolsCatalogAdapter;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException &&
      error.name === "AbortError") ||
    (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    )
  );
}

function normalizedFilters(search: string, category: string): CatalogFilters {
  return {
    search: search.trim(),
    category: category.trim(),
  };
}

function sameFilters(left: CatalogFilters, right: CatalogFilters): boolean {
  return left.search === right.search && left.category === right.category;
}

function catalogRequest(
  filters: CatalogFilters,
  cursor?: string,
): ToolCatalogRequest {
  return {
    limit: 100,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.category.length === 0 ? {} : { category: filters.category }),
    ...(filters.search.length === 0 ? {} : { search: filters.search }),
  };
}

function mergeTools(
  current: readonly ToolSummary[],
  incoming: readonly ToolSummary[],
): readonly ToolSummary[] {
  const tools = new Map(current.map((tool) => [tool.id, tool]));
  for (const tool of incoming) tools.set(tool.id, tool);
  return [...tools.values()];
}

function mergeCategories(
  current: readonly string[],
  tools: readonly ToolSummary[],
): readonly string[] {
  const categories = new Set(current);
  for (const tool of tools) {
    if (tool.category !== null) categories.add(tool.category);
  }
  return [...categories].sort((left, right) => left.localeCompare(right));
}

function matchesFilters(tool: ToolSummary, filters: CatalogFilters): boolean {
  if (filters.category.length > 0 && tool.category !== filters.category) {
    return false;
  }
  if (filters.search.length === 0) return true;

  const query = filters.search.toLocaleLowerCase();
  return [tool.key, tool.name, tool.category, tool.summary]
    .filter((value): value is string => value !== null)
    .some((value) => value.toLocaleLowerCase().includes(query));
}

function lifecycleBadge(tool: ToolSummary) {
  return tool.lifecycle === "published"
    ? <StatusBadge tone="ready">Published</StatusBadge>
    : <StatusBadge tone="warning">Deprecated</StatusBadge>;
}

function resultSummary(
  state: CatalogPageState,
  visibleCount: number,
): string {
  if (state.kind === "loading") return "Loading catalog";
  if (state.kind === "degraded" || state.kind === "not-found") {
    return "Catalog unavailable";
  }
  if (visibleCount === 0) return "0 tools";
  const hasMore = state.nextCursor !== null;
  return `${visibleCount}${hasMore ? "+" : ""} ${
    visibleCount === 1 ? "tool" : "tools"
  } shown`;
}

function catalogCaption(count: number): string {
  return `Tools, ${count} ${count === 1 ? "result" : "results"}`;
}

export function ToolsPage({
  toolsAdapter = httpToolsCatalogAdapter,
}: ToolsPageProps) {
  usePageMetadata("Tools | Relay", "#141A16");
  const { expireSession, session, workspace } = useAuth();
  const sessionId = session.status === "authenticated" ? session.identity.session.id : undefined;
  const [state, setState] = useState<CatalogPageState>({ kind: "loading" });
  const [searchDraft, setSearchDraft] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [knownCategories, setKnownCategories] = useState<readonly string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [paginationError, setPaginationError] = useState<string | null>(null);
  const paginationController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    paginationController.current?.abort();
    setLoadingMore(false);
    setPaginationError(null);
    setState({ kind: "loading" });

    void toolsAdapter.list(catalogRequest(filters), controller.signal).then(
      (result) => {
        if (result.kind === "auth-expired") {
          expireSession(sessionId);
          return;
        }
        if (!active) return;
        if (result.kind === "populated") {
          setKnownCategories((current) =>
            mergeCategories(current, result.tools)
          );
        }
        setState(result);
      },
    ).catch((error: unknown) => {
      if (!active || isAbortError(error)) return;
      setState({
        kind: "degraded",
        message:
          "Relay could not load the tool catalog. No tool data was shown.",
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [expireSession, filters, reloadKey, sessionId, toolsAdapter]);

  useEffect(() => () => paginationController.current?.abort(), []);

  const loadedTools = state.kind === "populated" ? state.tools : [];
  const visibleTools = useMemo(
    () => loadedTools.filter((tool) => matchesFilters(tool, filters)),
    [filters, loadedTools],
  );
  const hasFilters = filters.search.length > 0 || filters.category.length > 0;
  const categoryOptions = useMemo(() => {
    const options = new Set(knownCategories);
    if (categoryDraft.length > 0) options.add(categoryDraft);
    return [...options].sort((left, right) => left.localeCompare(right));
  }, [categoryDraft, knownCategories]);
  const workspaceLabel = workspace.status === "ready"
    ? workspace.workspace.name
    : "Workspace catalog";

  function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextFilters = normalizedFilters(searchDraft, categoryDraft);
    if (sameFilters(filters, nextFilters)) {
      setReloadKey((value) => value + 1);
      return;
    }
    setFilters(nextFilters);
  }

  function clearFilters() {
    setSearchDraft("");
    setCategoryDraft("");
    if (sameFilters(filters, EMPTY_FILTERS)) {
      setReloadKey((value) => value + 1);
    } else {
      setFilters(EMPTY_FILTERS);
    }
  }

  async function loadMore() {
    if (
      state.kind !== "populated" || state.nextCursor === null || loadingMore
    ) return;

    paginationController.current?.abort();
    const controller = new AbortController();
    paginationController.current = controller;
    setLoadingMore(true);
    setPaginationError(null);

    try {
      const result = await toolsAdapter.list(
        catalogRequest(filters, state.nextCursor),
        controller.signal,
      );
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (controller.signal.aborted) return;
      if (result.kind === "degraded") {
        setPaginationError(result.message);
        return;
      }
      if (result.kind === "not-found") {
        setPaginationError(
          "Relay could not find the next catalog page. The tools already shown were kept.",
        );
        return;
      }
      if (result.kind === "populated") {
        setKnownCategories((current) => mergeCategories(current, result.tools));
        setState((current) =>
          current.kind === "populated"
            ? {
              kind: "populated",
              tools: mergeTools(current.tools, result.tools),
              nextCursor: result.nextCursor,
            }
            : current
        );
        return;
      }
      setState((current) =>
        current.kind === "populated"
          ? { ...current, nextCursor: result.nextCursor }
          : current
      );
    } catch (error) {
      if (!isAbortError(error)) {
        setPaginationError(
          "Relay could not load more tools. The tools already shown were kept.",
        );
      }
    } finally {
      if (paginationController.current === controller) {
        paginationController.current = null;
        setLoadingMore(false);
      }
    }
  }

  const noMatches = hasFilters &&
    (state.kind === "empty" ||
      (state.kind === "populated" && visibleTools.length === 0));

  return (
    <div className="tools-page">
      <header className="tools-page__header">
        <div>
          <p className="mono-label">{workspaceLabel}</p>
          <h1>Tools</h1>
        </div>
        <p className="tools-page__summary" aria-live="polite">
          {resultSummary(state, visibleTools.length)}
        </p>
      </header>

      <form
        className="tools-filterbar"
        role="search"
        aria-label="Search and filter the tool catalog"
        onSubmit={applyFilters}
      >
        <div className="tools-field tools-field--search">
          <label htmlFor="tool-search">Search tools</label>
          <input
            className="tools-control"
            id="tool-search"
            maxLength={100}
            name="search"
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
            placeholder="Name, key, category, or summary"
            spellCheck="false"
            type="search"
            value={searchDraft}
          />
        </div>
        <div className="tools-field">
          <label htmlFor="tool-category">Category</label>
          <select
            className="tools-control"
            id="tool-category"
            name="category"
            onChange={(event) => setCategoryDraft(event.currentTarget.value)}
            value={categoryDraft}
          >
            <option value="">All categories</option>
            {categoryOptions.map((category) => (
              <option key={category} value={category}>{category}</option>
            ))}
          </select>
        </div>
        <div className="tools-filterbar__actions">
          <Button type="submit">Apply filters</Button>
          {hasFilters || searchDraft.length > 0 || categoryDraft.length > 0
            ? (
              <Button type="button" variant="quiet" onClick={clearFilters}>
                Clear filters
              </Button>
            )
            : null}
        </div>
      </form>

      <section
        className="tools-results"
        aria-labelledby="tools-results-title"
        aria-busy={state.kind === "loading" || undefined}
      >
        <h2 className="sr-only" id="tools-results-title">
          Tool catalog results
        </h2>

        {state.kind === "loading"
          ? <Skeleton label="Loading tool catalog" lines={5} />
          : null}

        {state.kind === "degraded"
          ? (
            <InlineNotice
              title="Tool catalog unavailable"
              tone="error"
              action={
                <Button
                  variant="outline"
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  Try again
                </Button>
              }
            >
              <p>{state.message}</p>
            </InlineNotice>
          )
          : null}

        {state.kind === "not-found"
          ? (
            <InlineNotice
              title="Tool catalog not found"
              action={
                <Button
                  variant="outline"
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  Try again
                </Button>
              }
            >
              <p>
                Relay could not find a tool catalog for the active workspace. No
                tool data was shown.
              </p>
            </InlineNotice>
          )
          : null}

        {state.kind === "empty" && !hasFilters
          ? (
            <EmptyState
              label="Tool catalog"
              title="No tools are available"
              actions={
                <Button
                  variant="outline"
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  Check again
                </Button>
              }
            >
              <p>
                This workspace has no published or deprecated tools to inspect.
                Only tools returned by the catalog API are shown.
              </p>
            </EmptyState>
          )
          : null}

        {noMatches
          ? (
            <div className="tools-no-match" role="status">
              <h2>No tools match the current filters</h2>
              <p>
                Change the search term or category to review the available
                catalog.
              </p>
              <Button variant="outline" onClick={clearFilters}>
                Clear filters
              </Button>
            </div>
          )
          : null}

        {state.kind === "populated" && visibleTools.length > 0
          ? (
            <>
              <div
                className="tools-table-scroll"
                role="region"
                aria-label="Scrollable tool catalog"
                tabIndex={0}
              >
                <table className="tools-table">
                  <caption>{catalogCaption(visibleTools.length)}</caption>
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col">Category</th>
                      <th scope="col">Lifecycle</th>
                      <th scope="col">Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTools.map((tool) => (
                      <tr
                        className={tool.lifecycle === "deprecated"
                          ? "is-deprecated"
                          : undefined}
                        key={tool.id}
                      >
                        <th scope="row">
                          <Link
                            aria-label={`${tool.name}, ${tool.key}. ${
                              tool.summary ?? "No summary provided"
                            }`}
                            className="tools-table__tool-link"
                            to={`/dashboard/tools/${
                              encodeURIComponent(tool.key)
                            }`}
                          >
                            <strong>{tool.name}</strong>
                            <code>{tool.key}</code>
                            <span>{tool.summary ?? "No summary provided"}</span>
                          </Link>
                        </th>
                        <td>{tool.category ?? "Not categorized"}</td>
                        <td>{lifecycleBadge(tool)}</td>
                        <td>
                          <code>v{tool.version}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {paginationError !== null
                ? (
                  <InlineNotice title="More tools unavailable" tone="error">
                    <p>{paginationError}</p>
                  </InlineNotice>
                )
                : null}

              {state.nextCursor !== null
                ? (
                  <div className="tools-pagination">
                    <Button
                      variant="outline"
                      pending={loadingMore}
                      pendingLabel="Loading more tools"
                      onClick={() => void loadMore()}
                    >
                      Load more tools
                    </Button>
                  </div>
                )
                : null}
            </>
          )
          : null}
      </section>
    </div>
  );
}

export const ToolCatalogPage = ToolsPage;
