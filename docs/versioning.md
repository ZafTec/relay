# Versioning proposal

Status: proposal for discussion; no release policy has been approved yet

Version tracking is separated into independent dimensions. A file version, API
version, database migration, legal revision, and deployed application release
must never be treated as the same number.

## Version dimensions

| Dimension              | Purpose                                                | Proposed representation                                 |
| ---------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| Product release        | Identifies a deployed application build                | Semantic Versioning plus Git revision                   |
| HTTP API               | Preserves external HTTP contracts                      | Path prefix such as `/api/v1`                           |
| MCP tool contract      | Preserves tool input/output compatibility              | Stable tool name; suffix only for breaking replacements |
| Background job payload | Lets new workers process jobs queued by older releases | `input_schema_version` and `handler_version`            |
| Database schema        | Orders database changes                                | Monotonic migration identifiers                         |
| Asset version          | Tracks immutable user file revisions                   | Per-asset sequence plus globally unique version ID      |
| Legal document         | Records exactly what a user accepted                   | Effective version and content hash                      |
| Entitlement catalog    | Preserves historical plan behavior                     | Catalog or grant version independent of app release     |

## Proposed product SemVer policy

Use `MAJOR.MINOR.PATCH` for product releases and a `v` prefix for Git tags:

```text
v0.1.0
v0.2.0
v1.0.0
```

### Before 1.0

The recommended initial release is `0.1.0`, not `1.0.0`.

Adopt a stricter policy than SemVer requires for `0.x` releases:

- `0.MINOR.0`: externally breaking HTTP, MCP, configuration, deployment, or
  persisted-data behavior; also substantial new MVP milestones
- `0.MINOR.PATCH`: backward-compatible fixes and small internal improvements
- Breaking changes must still be documented even though the product is pre-1.0

Examples:

```text
0.1.0  Internal development foundation
0.2.0  First authenticated upload and download workflow
0.3.0  First public MCP contract
0.3.1  Fix incorrect presigned URL expiration
```

An alternative is to use patch releases for every backward-compatible feature
during `0.x`. We should choose one rule before creating the first release tag
and apply it consistently.

### Criteria for 1.0.0

Do not tie `1.0.0` merely to deployment. Promote to 1.0 when:

- The production data model and migration process are proven
- The core MCP tools are documented and considered stable
- Authentication and workspace authorization are production-ready
- Upload, download, jobs, image generation, and usage accounting are operational
- Backup and restore procedures have been tested
- Legal documents and product addendum are approved
- Monitoring, alerting, and operational runbooks exist
- Breaking changes have an announced compatibility policy

### After 1.0

- `MAJOR`: externally incompatible API, MCP, configuration, or behavior changes
- `MINOR`: backward-compatible features
- `PATCH`: backward-compatible fixes and security patches

Database migrations do not automatically require a major release when deployment
remains backward-compatible.

## Single product release version

The API and worker should normally ship from the same source revision and share
one product version. Do not create independent API and worker SemVer lines until
they have truly independent release lifecycles.

The dashboard may expose its own build revision for diagnostics, but it should
display the product release version to users.

## Canonical version source

Proposed approach:

1. An annotated Git tag is the source for official releases.
2. CI validates that the tag is valid SemVer.
3. CI embeds the version, full Git SHA, and build timestamp into the compiled
   artifact.
4. Untagged local builds report a development identifier.

Example runtime build information:

```json
{
  "version": "0.3.1",
  "revision": "8f91d2c51e...",
  "builtAt": "2026-07-28T12:00:00Z"
}
```

Possible local representation:

```text
0.0.0-dev+g8f91d2c
```

Do not infer a production version from the number of commits or mutate a version
file after deployment.

## Artifact identification

OCI/Docker tags should include both a readable release and an immutable
revision:

```text
zaftech/<project>:0.3.1
zaftech/<project>:git-8f91d2c
zaftech/<project>:latest
```

Production Compose should preferably pin `0.3.1` or `git-8f91d2c`. `latest` can
be published for convenience but is not a reliable rollback reference.

The OCI image should also contain standard labels:

```text
org.opencontainers.image.version
org.opencontainers.image.revision
org.opencontainers.image.created
org.opencontainers.image.source
```

## Runtime exposure

Expose build information through:

- `GET /version`
- `GET /health/live`
- MCP `serverInfo.version`
- Dashboard diagnostics/footer
- Structured log resource fields
- OpenTelemetry resource attributes
- A low-cardinality Prometheus build-info metric

Do not use the version as a high-cardinality metric label when arbitrary
development versions can appear.

## HTTP API versioning

Start external HTTP endpoints under `/api/v1`.

A new API path version is required only for a breaking public contract. Internal
refactors, additive optional fields, new endpoints, and bug fixes remain in the
current version.

During a breaking migration:

1. Add `/api/v2` alongside `/api/v1`.
2. Publish a deprecation date.
3. Measure remaining v1 usage.
4. Remove v1 in a later major product release.

The product SemVer major and HTTP API major are related but intentionally not
forced to have the same number.

## MCP tool contract versioning

Prefer additive evolution:

- Add optional input fields with defaults.
- Add output fields without changing existing meaning.
- Do not silently reinterpret fields.
- Do not remove enum values without a replacement period.
- Preserve structured error codes.

For an unavoidable breaking change, publish a replacement tool while retaining
the original temporarily:

```text
files.create_upload
files.create_upload_v2
```

The version suffix is a last resort, not a default naming convention.

## Background job versioning

Persist enough information to safely execute jobs across deployments:

```text
job_type
input_schema_version
handler_version
created_by_app_version
```

Workers should either:

- Support all non-expired queued payload versions, or
- Upgrade old payloads through explicit adapters before execution.

A deployment must not strand queued jobs merely because the current application
release changed.

## Asset versioning

Asset versions are immutable domain records and do not use SemVer.

Use:

- A globally unique `asset_version_id`
- A per-asset monotonic sequence
- An immutable object key
- Optional `parent_version_id`
- Optimistic concurrency against the current version

S3-native version IDs may be recorded but are not the application versioning
mechanism.

## Database migrations

Use monotonic, immutable migration identifiers. Never edit a migration after it
has been applied outside a disposable development database.

Prefer expand-and-contract migrations:

1. Add compatible schema.
2. Deploy code supporting old and new forms.
3. Backfill.
4. Switch reads and writes.
5. Remove old schema in a later release.

Record the current migration state separately from the product SemVer.

## Legal and entitlement versions

Legal documents need immutable acceptance records based on document version and
content hash.

Plan and entitlement definitions also need historical identity. A plan named
`pro` may change over time, so subscriptions or grants should reference a
catalog version or snapshot of granted entitlements rather than assuming the
current `pro` definition always applied.

## Decisions required before release automation

1. Confirm `0.1.0` as the first internal release.
2. Decide whether backward-compatible pre-1.0 features increment minor or patch.
3. Confirm Git tags as the canonical release source rather than a committed
   `VERSION` file.
4. Decide whether every merge to `main` publishes only an immutable SHA image or
   also a prerelease version.
5. Decide who or what creates official release tags.
6. Define the compatibility and deprecation window for MCP tools before public
   availability.
