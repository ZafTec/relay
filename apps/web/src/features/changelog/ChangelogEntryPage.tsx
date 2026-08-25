import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { PublicLayout } from "../../components/layout/PublicLayout";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  CHANGELOG_CATEGORIES,
  type ChangelogAdapter,
  type ChangelogCategory,
  type ChangelogEntryLoadResult,
  type ChangelogItem,
  httpChangelogAdapter,
  isChangelogSlug,
} from "../../lib/api/changelog";
import {
  CHANGELOG_CATEGORY_LABELS,
  changelogDateLabel,
} from "./presenter";
import "./changelog.css";

type ChangelogEntryPageState =
  | { readonly kind: "loading" }
  | ChangelogEntryLoadResult;

interface ScopedChangelogEntryState {
  readonly slug: string | undefined;
  readonly result: ChangelogEntryPageState;
}

interface ChangelogEntryPageProps {
  readonly changelogAdapter?: ChangelogAdapter;
}

interface CategoryGroup {
  readonly category: ChangelogCategory;
  readonly items: readonly ChangelogItem[];
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function ReleaseMetadata({
  release,
}: {
  readonly release: Extract<ChangelogEntryPageState, { kind: "found" }>["release"];
}) {
  return (
    <dl className="changelog-entry__metadata" aria-label="Release metadata">
      {release.releasedAt !== null ? (
        <div>
          <dt>Release date</dt>
          <dd>
            <time dateTime={release.releasedAt}>
              {changelogDateLabel(release.releasedAt)}
            </time>
          </dd>
        </div>
      ) : null}
      <div>
        <dt>Published</dt>
        <dd>
          <time dateTime={release.publishedAt}>
            {changelogDateLabel(release.publishedAt)}
          </time>
        </dd>
      </div>
      {release.gitTag !== null ? (
        <div>
          <dt>Git tag</dt>
          <dd><code>{release.gitTag}</code></dd>
        </div>
      ) : null}
      {release.commitSha !== null ? (
        <div>
          <dt>Commit</dt>
          <dd><code>{release.commitSha}</code></dd>
        </div>
      ) : null}
    </dl>
  );
}

export function ChangelogEntryPage({
  changelogAdapter = httpChangelogAdapter,
}: ChangelogEntryPageProps) {
  const { slug } = useParams<{ slug: string }>();
  const [loadState, setLoadState] = useState<ScopedChangelogEntryState>({
    slug,
    result: { kind: "loading" },
  });
  const [reloadKey, setReloadKey] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const state: ChangelogEntryPageState = loadState.slug === slug
    ? loadState.result
    : { kind: "loading" };
  const pageTitle = state.kind === "found"
    ? `${state.release.version} changelog | Relay`
    : "Release notes | Relay";
  usePageMetadata(pageTitle, "#F5F4ED");

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: "auto" });
  }, [slug]);

  useEffect(() => {
    if (slug === undefined || !isChangelogSlug(slug)) {
      setLoadState({ slug, result: { kind: "not-found" } });
      return;
    }

    const controller = new AbortController();
    let active = true;
    setLoadState({ slug, result: { kind: "loading" } });

    void changelogAdapter.loadEntry(slug, controller.signal).then((result) => {
      if (active) setLoadState({ slug, result });
    }).catch((error: unknown) => {
      if (isAbortError(error)) return;
      if (active) {
        setLoadState({
          slug,
          result: {
            kind: "degraded",
            message: "Relay could not load this published release. No release information was shown.",
          },
        });
      }
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [changelogAdapter, reloadKey, slug]);

  useEffect(() => {
    if (state.kind !== "loading") headingRef.current?.focus();
  }, [slug, state.kind]);

  const groups = useMemo<readonly CategoryGroup[]>(() => {
    if (state.kind !== "found") return [];
    const orderedItems = [...state.release.items].sort(
      (left, right) => left.sortOrder - right.sortOrder,
    );
    return CHANGELOG_CATEGORIES.flatMap((category) => {
      const items = orderedItems.filter((item) => item.category === category);
      return items.length === 0 ? [] : [{ category, items }];
    });
  }, [state]);

  return (
    <PublicLayout>
      <main className="changelog-page changelog-entry-page" id="main-content">
        {state.kind === "loading" ? (
          <section
            aria-busy="true"
            aria-label="Loading published release"
            className="changelog-entry-state"
          >
            <div className="changelog-container">
              <div className="changelog-entry__topline">
                <p className="kicker"><span>// 01</span> Release</p>
                <Link className="changelog-entry__back" to="/changelog">
                  All releases
                </Link>
              </div>
              <h1 className="sr-only">Release notes</h1>
              <Skeleton label="Loading published release" lines={6} />
            </div>
          </section>
        ) : null}

        {state.kind === "not-found" ? (
          <section className="changelog-entry-state">
            <div className="changelog-container">
              <p className="kicker"><span>// 01</span> Release ledger</p>
              <h1 ref={headingRef} tabIndex={-1}>Release not found</h1>
              <p>
                This published release does not exist or is no longer public.
              </p>
              <LinkButton to="/changelog" variant="ink">Browse all releases</LinkButton>
            </div>
          </section>
        ) : null}

        {state.kind === "degraded" ? (
          <section className="changelog-entry-state">
            <div className="changelog-container">
              <p className="kicker"><span>// 01</span> Release ledger</p>
              <h1 ref={headingRef} tabIndex={-1}>Release unavailable</h1>
              <InlineNotice
                action={(
                  <Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
                    Try again
                  </Button>
                )}
                title="Release details unavailable"
                tone="error"
              >
                <p>{state.message}</p>
              </InlineNotice>
              <Link className="changelog-entry__back" to="/changelog">
                All releases
              </Link>
            </div>
          </section>
        ) : null}

        {state.kind === "found" ? (
          <>
            <header className="changelog-entry-header">
              <div className="changelog-container">
                <div className="changelog-entry__topline">
                  <p className="kicker"><span>// 01</span> Release</p>
                  <Link className="changelog-entry__back" to="/changelog">
                    All releases
                  </Link>
                </div>
                <div className="changelog-entry__heading">
                  <h1 ref={headingRef} tabIndex={-1}>{state.release.version}</h1>
                  <p className="changelog-entry__title">{state.release.title}</p>
                  {state.release.summary !== null ? (
                    <p className="changelog-entry__summary">{state.release.summary}</p>
                  ) : null}
                </div>
                <ReleaseMetadata release={state.release} />
                <ul
                  aria-label="Categories in this release"
                  className="changelog-entry__categories"
                >
                  {groups.map(({ category }) => (
                    <li className={`changelog-tag changelog-tag--${category}`} key={category}>
                      {CHANGELOG_CATEGORY_LABELS[category]}
                    </li>
                  ))}
                </ul>
              </div>
            </header>

            <div className="changelog-entry-body">
              <div className="changelog-entry-body__inner">
                {groups.map(({ category, items }) => {
                  const headingId = `release-category-${category}`;
                  return (
                    <section
                      aria-labelledby={headingId}
                      className={`changelog-entry-group changelog-entry-group--${category}`}
                      key={category}
                    >
                      <h2 id={headingId}>{CHANGELOG_CATEGORY_LABELS[category]}</h2>
                      <ol className="changelog-entry-items">
                        {items.map((item) => (
                          <li key={`${item.sortOrder}-${item.title}`}>
                            <span aria-hidden="true" className="changelog-entry-item__marker" />
                            <div>
                              <h3>{item.title}</h3>
                              <p>{item.description}</p>
                              {item.area !== null ? (
                                <p className="changelog-item__area">Area: {item.area}</p>
                              ) : null}
                            </div>
                          </li>
                        ))}
                      </ol>
                    </section>
                  );
                })}
                <Link className="changelog-entry__back changelog-entry__back--footer" to="/changelog">
                  All releases
                </Link>
              </div>
            </div>
          </>
        ) : null}
      </main>
    </PublicLayout>
  );
}
