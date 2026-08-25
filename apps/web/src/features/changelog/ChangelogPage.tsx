import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { PublicLayout } from "../../components/layout/PublicLayout";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  CHANGELOG_CATEGORIES,
  type ChangelogAdapter,
  type ChangelogCategory,
  type ChangelogItem,
  type ChangelogLoadResult,
  type ChangelogRelease,
  httpChangelogAdapter,
} from "../../lib/api/changelog";
import {
  CHANGELOG_CATEGORY_LABELS,
  changelogDateLabel,
} from "./presenter";
import "./changelog.css";

type ChangelogFilter = "all" | ChangelogCategory;
type ChangelogPageState = ChangelogLoadResult | { readonly kind: "loading" };

const FILTERS: readonly ChangelogFilter[] = ["all", ...CHANGELOG_CATEGORIES];
const FILTER_LABELS: Record<ChangelogFilter, string> = {
  all: "All",
  ...CHANGELOG_CATEGORY_LABELS,
};

interface ChangelogPageProps {
  changelogAdapter?: ChangelogAdapter;
}

interface VisibleRelease {
  readonly release: ChangelogRelease;
  readonly items: readonly ChangelogItem[];
}


function sourceMetadata(release: ChangelogRelease) {
  if (release.gitTag === null && release.commitSha === null) return null;

  return (
    <dl className="changelog-release__source" aria-label="Release source">
      {release.gitTag !== null ? (
        <div>
          <dt className="sr-only">Git tag</dt>
          <dd>{release.gitTag}</dd>
        </div>
      ) : null}
      {release.commitSha !== null ? (
        <div>
          <dt className="sr-only">Commit SHA</dt>
          <dd>{release.commitSha}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function ReleaseItem({ item }: { item: ChangelogItem }) {
  return (
    <li className="changelog-item">
      <span className={`changelog-tag changelog-tag--${item.category}`}>
        {FILTER_LABELS[item.category]}
      </span>
      <div className="changelog-item__copy">
        <h3>{item.title}</h3>
        <p>{item.description}</p>
        {item.area !== null ? <p className="changelog-item__area">Area: {item.area}</p> : null}
      </div>
    </li>
  );
}

function ReleaseArticle({ release, items }: VisibleRelease) {
  const headingId = `changelog-release-${release.slug}`;

  return (
    <article className="changelog-release" aria-labelledby={headingId}>
      <header className="changelog-release__metadata">
        <h2 id={headingId}>
          <Link className="changelog-release__link" to={`/changelog/${release.slug}`}>
            {release.version}
          </Link>
        </h2>
        <p className="changelog-release__title">{release.title}</p>
        {release.releasedAt !== null ? (
          <time dateTime={release.releasedAt}>{changelogDateLabel(release.releasedAt)}</time>
        ) : null}
        {sourceMetadata(release)}
      </header>
      <div className="changelog-release__body">
        {release.summary !== null ? <p className="changelog-release__summary">{release.summary}</p> : null}
        <ul className="changelog-items">
          {items.map((item, itemIndex) => (
            <ReleaseItem
              item={item}
              key={`${release.slug}-${item.sortOrder}-${itemIndex}`}
            />
          ))}
        </ul>
      </div>
    </article>
  );
}

export function ChangelogPage({
  changelogAdapter = httpChangelogAdapter,
}: ChangelogPageProps) {
  usePageMetadata("Changelog | Relay", "#F5F4ED");
  const [state, setState] = useState<ChangelogPageState>({ kind: "loading" });
  const [filter, setFilter] = useState<ChangelogFilter>("all");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ kind: "loading" });

    void changelogAdapter.load(controller.signal).then((result) => {
      if (active) setState(result);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (active) {
        setState({
          kind: "degraded",
          message: "Relay could not load published release notes. No release information was shown.",
        });
      }
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [changelogAdapter, reloadKey]);

  const visibleReleases = useMemo<readonly VisibleRelease[]>(() => {
    if (state.kind !== "populated") return [];

    return state.releases.flatMap((release) => {
      const items = [...release.items]
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .filter((item) => filter === "all" || item.category === filter);
      return items.length === 0 ? [] : [{ release, items }];
    });
  }, [filter, state]);

  return (
    <PublicLayout>
      <main className="changelog-page" id="main-content">
        <header className="changelog-intro">
          <div className="changelog-container">
            <p className="kicker"><span>// 01</span> Releases</p>
            <div className="changelog-intro__row">
              <div>
                <h1>Changelog</h1>
                <p>Reviewed release notes with available publication and source metadata.</p>
              </div>
            </div>

            {state.kind === "populated" ? (
              <div className="changelog-filters" role="group" aria-label="Filter release notes">
                {FILTERS.map((value) => (
                  <Button
                    aria-pressed={filter === value}
                    className="changelog-filter"
                    key={value}
                    onClick={() => setFilter(value)}
                    variant={filter === value ? "ink" : "outline"}
                  >
                    {FILTER_LABELS[value]}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        </header>

        <section
          aria-label="Published releases"
          aria-busy={state.kind === "loading" || undefined}
          className={`changelog-results changelog-results--${state.kind}`}
        >
          <div className="changelog-container">
            {state.kind === "loading" ? (
              <Skeleton label="Loading published release notes" lines={4} />
            ) : null}

            {state.kind === "empty" ? (
              <EmptyState
                label="Release ledger"
                title="No releases published yet"
              >
                <p>
                  No public release notes are available yet. Reviewed releases will appear
                  here after publication.
                </p>
              </EmptyState>
            ) : null}

            {state.kind === "degraded" ? (
              <InlineNotice
                action={(
                  <Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>
                    Try again
                  </Button>
                )}
                title="Changelog unavailable"
                tone="error"
              >
                <p>{state.message}</p>
              </InlineNotice>
            ) : null}

            {state.kind === "populated" && visibleReleases.length === 0 ? (
              <div className="changelog-no-match" role="status">
                <h2>No releases match this filter</h2>
                <p>Choose another category to see published release notes.</p>
              </div>
            ) : null}

            {state.kind === "populated" && visibleReleases.length > 0 ? (
              <div className="changelog-release-list">
                {visibleReleases.map(({ release, items }) => (
                  <ReleaseArticle
                    items={items}
                    key={release.slug}
                    release={release}
                  />
                ))}
              </div>
            ) : null}
          </div>
        </section>
      </main>
    </PublicLayout>
  );
}
