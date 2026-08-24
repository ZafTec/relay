/**
 * Canonical public vocabulary for every transport and UI. The resource is a
 * `run` (never a public `job` or `tool-run`), its HTTP collection is
 * `/api/v1/runs`, and public shares resolve at `/s/:token`. MCP operation names
 * deliberately do not live here: method naming and protocol framing remain an
 * MCP transport concern, while MCP payloads reuse these resource contracts.
 */
export const PUBLIC_NOUNS: Readonly<{ run: "run" }> = Object.freeze({
  run: "run",
});

export const HTTP_PATHS: Readonly<{
  tools: "/api/v1/tools";
  runs: "/api/v1/runs";
  run: "/api/v1/runs/:runId";
  runCancel: "/api/v1/runs/:runId/cancel";
  artifacts: "/api/v1/artifacts";
  artifact: "/api/v1/artifacts/:artifactId";
  artifactUploads: "/api/v1/artifacts/uploads";
  artifactUploadComplete: "/api/v1/artifacts/uploads/:uploadId/complete";
  artifactShareLinks: "/api/v1/artifacts/:artifactId/share-links";
  artifactShareLink: "/api/v1/artifacts/:artifactId/share-links/:shareLinkId";
  usage: "/api/v1/usage";
  events: "/api/v1/events";
  changelog: "/api/v1/changelog";
  changelogEntry: "/api/v1/changelog/:slug";
  adminChangelog: "/api/v1/admin/changelog";
  adminChangelogRelease: "/api/v1/admin/changelog/:releaseId";
  adminChangelogPublish: "/api/v1/admin/changelog/:releaseId/publish";
  adminChangelogUnpublish: "/api/v1/admin/changelog/:releaseId/unpublish";
  publicShareTemplate: "/s/:token";
}> = Object.freeze({
  tools: "/api/v1/tools",
  runs: "/api/v1/runs",
  run: "/api/v1/runs/:runId",
  runCancel: "/api/v1/runs/:runId/cancel",
  artifacts: "/api/v1/artifacts",
  artifact: "/api/v1/artifacts/:artifactId",
  artifactUploads: "/api/v1/artifacts/uploads",
  artifactUploadComplete: "/api/v1/artifacts/uploads/:uploadId/complete",
  artifactShareLinks: "/api/v1/artifacts/:artifactId/share-links",
  artifactShareLink: "/api/v1/artifacts/:artifactId/share-links/:shareLinkId",
  usage: "/api/v1/usage",
  events: "/api/v1/events",
  changelog: "/api/v1/changelog",
  changelogEntry: "/api/v1/changelog/:slug",
  adminChangelog: "/api/v1/admin/changelog",
  adminChangelogRelease: "/api/v1/admin/changelog/:releaseId",
  adminChangelogPublish: "/api/v1/admin/changelog/:releaseId/publish",
  adminChangelogUnpublish: "/api/v1/admin/changelog/:releaseId/unpublish",
  publicShareTemplate: "/s/:token",
});

export function runPath(runId: string): string {
  return `${HTTP_PATHS.runs}/${encodeURIComponent(runId)}`;
}

export function changelogEntryPath(slug: string): string {
  return `${HTTP_PATHS.changelog}/${encodeURIComponent(slug)}`;
}

export function adminChangelogReleasePath(releaseId: string): string {
  return `${HTTP_PATHS.adminChangelog}/${encodeURIComponent(releaseId)}`;
}

export function publicSharePath(token: string): string {
  return `/s/${encodeURIComponent(token)}`;
}
