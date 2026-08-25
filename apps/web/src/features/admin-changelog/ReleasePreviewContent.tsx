import type { AdminChangelogReleaseSnapshot } from "../../lib/api/admin-changelog";
import { formatUtcTimestamp } from "./model";

interface ReleasePreviewContentProps {
  readonly snapshot: AdminChangelogReleaseSnapshot;
  readonly revision: number;
}

export function ReleasePreviewContent({ snapshot, revision }: ReleasePreviewContentProps) {
  return (
    <article className="admin-preview-paper public-surface" aria-labelledby="admin-preview-release-title">
      <div className="admin-preview-paper__inner">
        <p className="admin-preview-paper__kicker">Stored revision {revision}</p>
        <h1 id="admin-preview-release-title">{snapshot.version}</h1>
        <h2>{snapshot.title}</h2>
        {snapshot.summary !== null ? <p className="admin-preview-paper__summary">{snapshot.summary}</p> : null}
        <dl className="admin-preview-paper__metadata">
          <div>
            <dt>Release timestamp</dt>
            <dd>{snapshot.releasedAt === null ? "Not set" : <time dateTime={snapshot.releasedAt}>{formatUtcTimestamp(snapshot.releasedAt)}</time>}</dd>
          </div>
          <div>
            <dt>Git tag</dt>
            <dd><code>{snapshot.gitTag ?? "Not set"}</code></dd>
          </div>
          <div>
            <dt>Commit SHA</dt>
            <dd><code>{snapshot.commitSha ?? "Not set"}</code></dd>
          </div>
        </dl>

        {snapshot.items.length === 0 ? (
          <p className="admin-preview-paper__empty">No release items are stored in this revision.</p>
        ) : (
          <ol className="admin-preview-items">
            {[...snapshot.items]
              .sort((left, right) => left.sortOrder - right.sortOrder)
              .map((item) => (
                <li className="admin-preview-item" key={`${item.sortOrder}-${item.category}-${item.title}`}>
                  <span className={`admin-preview-category admin-preview-category--${item.category}`}>
                    {item.category}
                  </span>
                  <div>
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                    {item.area !== null ? <p className="admin-preview-item__area">Area: {item.area}</p> : null}
                  </div>
                </li>
              ))}
          </ol>
        )}
      </div>
    </article>
  );
}
