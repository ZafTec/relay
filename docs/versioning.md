# Release and versioning policy

Status: approved 2026-08-25\
Product model authority: [`product-and-roadmap.md`](product-and-roadmap.md)

Relay uses one product release version for the backend API, worker, migration
command, and web application. Product releases are independent from HTTP API,
MCP tool, database migration, artifact, legal-document, provider-policy, and
entitlement versions.

## Product SemVer

The first product baseline is `0.1.0`. Official Git tags use the exact stable
form `vMAJOR.MINOR.PATCH`; prerelease and build suffixes are not release tags.
The tag and its full commit SHA are the canonical release identity.

Conventional Commit types drive Release Please:

- `feat`: minor release, including before `1.0.0`;
- `fix`: patch release;
- `perf`: patch release;
- a documented breaking change: minor before `1.0.0`, major from `1.0.0`;
- `docs`, `deps`, and `chore`: no version bump unless combined with a release
  trigger understood by Release Please.

Every squash-merged PR title must therefore carry the intended conventional
prefix. Breaking changes must be explicit even during `0.x`. This mapping
resolves the earlier pre-1.0 alternative: backward-compatible features increment
the minor version, while fixes and performance improvements increment the patch
version.

Promote to `1.0.0` only after the public contracts, authorization model,
migration and restore process, core MCP tools, queue compatibility, durable
artifacts, metering, legal documents, monitoring, alerting, and operational
runbooks have been proven in production.

After `1.0.0`, incompatible public API, MCP, configuration, deployment, or
persisted-data behavior requires a major release; backward-compatible features
use minor releases; backward-compatible fixes, performance improvements, and
security patches use patch releases. A database migration does not itself
require a major release when the rollout remains backward-compatible.

## Release automation

For first-time repository configuration, follow the
[Google Release Please setup guide](release-please-setup.md).

`release-please-config.json` configures one repository-level `simple` release.
`.release-please-manifest.json` and `version.txt` are bookkeeping files managed
by the Release Please PR; they are not deployment selectors. The manifest is
empty at bootstrap so `initial-version: 0.1.0` produces the first release, then
the merged release PR records `0.1.0` in it. Release Please updates
`CHANGELOG.md`, creates the protected `vMAJOR.MINOR.PATCH` tag, and creates a
draft GitHub release.

A repository-scoped GitHub App installation token is mandatory because tags
created by the default `GITHUB_TOKEN` do not trigger the image workflow. The
`release-please.yml` workflow requests only repository contents, pull-request,
and issue permissions for the current repository. Configure:

- repository or organization secrets `RELEASE_APP_ID` and
  `RELEASE_APP_PRIVATE_KEY`;
- a GitHub App installed only on this repository, with Contents read/write, Pull
  requests read/write, Issues read/write, and Metadata read;
- a `v*` tag ruleset that permits this App, and the documented emergency role,
  to create tags while blocking deletion and force updates;
- protected `main` with the existing required CI aggregate.

The image workflow receives neither App credential. A release tag must resolve
to the `version.txt` value, use a full lowercase 40-character revision, be
reachable from `main`, and have a matching non-prerelease draft. Any mismatch
fails before registry writes.

## Docker Hub publication

The image namespace and registry login both use the repository secret
`DOCKERHUB_USERNAME`. There is no separate namespace override or default account.
Repository names default to:

```text
DOCKERHUB_BACKEND_REPOSITORY=relay-backend
DOCKERHUB_WEB_REPOSITORY=relay-web
```

Override repository names with repository variables of those names. Provide these
repository Actions secrets so publication also works for private repositories:

- `DOCKERHUB_TOKEN`: required repository secret containing a Docker Hub token
  with Read & Write permissions for both repositories and no Delete permission;
  reads are required for conflict detection, verification, and rerun recovery;
- `DOCKERHUB_USERNAME`: the Docker Hub account that owns the image repositories.

Both repositories must support OCI attestations. Public GitHub repositories also
publish GitHub-signed provenance. Private repositories retain native BuildKit
provenance; set `RELAY_GITHUB_ATTESTATIONS_ENABLED=true` only when Enterprise Cloud
provides private-repository GitHub attestations. Native provenance is build
metadata tied to the image digest, not a GitHub-signed identity claim.

The workflow fails closed when credentials are absent or registry inspection
cannot distinguish a missing tag from an authentication/network failure. Create
both Docker Hub repositories before the first tag. Configure Docker Hub tag
immutability for stable SemVer tags, `git-<40 lowercase hex>` tags, and
`candidate-<run-id>` tags; leave only `latest` mutable. Registry-side
immutability is required in addition to the workflow's conflict checks.

Each tag workflow builds exactly one `linux/amd64` backend image and one
`linux/amd64` web image from the tagged SHA. Each is first pushed to the stable
run-specific candidate tag `candidate-<github.run_id>`. A rerun reuses an
existing candidate digest instead of rebuilding it. The exact candidate digest
receives:

- native BuildKit maximum-mode provenance and SBOM attestations;
- a GitHub build-provenance attestation where supported by the repository plan;
- an SPDX JSON SBOM release asset; and
- a blocking HIGH/CRITICAL fixed-vulnerability Trivy JSON report.

The required failure-safe sequence starts only after all candidate evidence
succeeds: automation must first promote the same OCI digest to the immutable
destinations:

```text
<semver without v>
git-<full-40-character-sha>
```

Before writing any immutable destination, promotion inspects all backend and web
SemVer and revision tags. A missing tag is created, an identical tag is a no-op,
and a different digest aborts the release before any destination is overwritten.

The GitHub release must remain a draft while automation creates and validates
the canonical `release-manifest.json`, verifies immutable tag/digest agreement,
and uploads the manifest, checksums, SBOMs, provenance bundles, and scan
reports. If the release is the highest stable version known to the serialized
workflow, the
same verified backend and web digests are then promoted to their mutable
`latest` tags while the GitHub release is still a draft.

The registry cannot update `latest` atomically across the two Docker Hub
repositories. Both destinations are inspected before either write, but an
interruption can still move one repository before the other. A rerun reuses the
preserved candidate digests, accepts already-correct immutable or `latest` tags
as no-ops, and completes the remaining promotion. Conflicting immutable tags or
unclassifiable registry errors continue to fail closed.

Only after immutable publication, evidence upload, and any eligible `latest`
promotion have all been verified may automation publish the GitHub draft. GitHub
publication is the final release operation. Any earlier failure leaves the draft
unpublished and preserves the candidates and uploaded evidence for investigation
and idempotent rerun recovery.

## Published image identity

`release-manifest.json` records the paired backend and web image digests. Release
builds embed the application version and full revision as OCI labels and runtime
inputs. Version-bearing runtime and telemetry surfaces use that build identity.

Release Please creates the protected version tag through the repository-scoped
GitHub App. The image workflow publishes SemVer, `git-<full-40-character-sha>`, and
eligible `latest` tags. Digests identify immutable image contents; `latest` is a
mutable pointer to the newest verified stable release.

Image publication ends at the registry and GitHub release. Host configuration
and deployment procedures are managed outside this repository.

## Independent version dimensions

Version tracking remains separated into independent dimensions. An API version,
tool contract, job payload, database migration, artifact revision, legal
revision, policy snapshot, and deployed product release must never be assumed to
share a number merely because they shipped together.

| Dimension              | Purpose                                                       | Representation                                                    |
| ---------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| Product release        | Identifies one approved product release                       | SemVer, protected Git tag, and full Git revision                   |
| Deployment artifact    | Selects the exact paired backend and web images               | Two OCI digests in `release-manifest.json`                         |
| HTTP API               | Preserves external HTTP contracts                             | Path prefix such as `/api/v1`                                     |
| MCP tool contract      | Preserves public tool input/output compatibility              | Stable tool name; suffix only for breaking replacements           |
| Tool publication       | Identifies an immutable registry contract and handler binding | Per-tool version independent of the product release                |
| Provider/model policy  | Explains capability, routing, and pricing used by a run       | Immutable provider/model identities and policy snapshots           |
| Background job payload | Lets new workers process jobs queued by older releases        | Input schema and handler identities                                |
| Database schema        | Orders durable schema changes                                 | Immutable monotonic migration identifiers                          |
| Artifact version       | Tracks immutable stored input and output revisions            | Per-artifact sequence plus globally unique version ID              |
| Legal document         | Records exactly what a user accepted                          | Effective document version and content hash                        |
| Entitlement catalog    | Preserves historical plan behavior                            | Catalog/grant version or immutable entitlement snapshot            |

A compatibility change in one dimension can require a product SemVer bump, but
it does not replace that dimension's own identifier. Product, HTTP API, MCP, and
database major numbers are intentionally not required to match.

## Single product release version

The backend API, worker, migration command, and web application ship from the
same source revision and share one product version. The backend and web are
separate OCI images for deployment, but they form one paired release. Do not
create independent API, worker, or web SemVer lines until those components have
truly independent release lifecycles.

The dashboard may expose component revision details for diagnostics, but the
user-facing release remains the shared product version.

## Canonical build identity and observability

For an official release, the protected tag and its full commit SHA identify the
product release; the paired OCI digests in `release-manifest.json` identify what
is deployed. `version.txt` and `.release-please-manifest.json` are Release Please
bookkeeping, not operator-selected deployment versions. Do not derive a release
version from commit count, mutate a version file after release, or let an
untagged development build masquerade as an official release.

Release images carry these standard identity labels:

```text
org.opencontainers.image.version
org.opencontainers.image.revision
org.opencontainers.image.created
org.opencontainers.image.source
```

`org.opencontainers.image.created` is OCI image metadata. The runtime build-info
contract currently contains `version` and `revision`; this policy does not claim
or require a runtime `builtAt` field.

Version and revision should be available through the surfaces that support build
identity:

- `GET /version` and liveness output;
- MCP `serverInfo.version`;
- dashboard diagnostics or footer;
- structured log fields;
- OpenTelemetry resource attributes; and
- a low-cardinality Prometheus build-info metric.

This list is compatibility and observability guidance, not a declaration that
every surface is already implemented; current implementation state remains in
[`implementation-status.md`](implementation-status.md). Use the bounded product
version for `service.version`. Keep the full revision available in release
manifests, logs, traces, or resource metadata, but out of metric labels. Do not
allow arbitrary development identifiers to create unbounded metric cardinality.

## HTTP API compatibility

External HTTP endpoints start under `/api/v1`. A new path version is required
only for a breaking public contract. Internal refactors, additive optional
fields, new endpoints, and compatible bug fixes remain in the current version.

During a breaking migration:

1. Add the replacement path, such as `/api/v2`, alongside the existing path.
2. Publish a deprecation date and migration guidance.
3. Measure remaining use of the old path.
4. Remove the old path only after the announced window, in a product release
   carrying the required breaking-change SemVer signal.

The HTTP API major and product SemVer major remain related compatibility signals,
not the same counter.

## MCP tool compatibility

Prefer additive MCP evolution:

- add optional input fields with safe defaults;
- add output fields without changing existing meaning;
- do not silently reinterpret fields;
- do not remove enum values without a replacement period; and
- preserve structured error codes and their meaning.

For an unavoidable breaking contract, publish a replacement tool while retaining
the original temporarily, for example:

```text
image.generate
image.generate_v2
```

A suffix is a last resort, not the default naming convention. Tool publication
versions remain immutable registry identities independent of both the stable MCP
tool name and product SemVer.

**Open decision:** the exact public MCP/tool compatibility and deprecation window,
including notice, usage-measurement, and removal criteria, is not yet approved.
That decision does not reopen or block the approved `0.1.0` release automation,
but it must be resolved before Relay makes a public MCP compatibility promise.

## Tool publication and provider-policy compatibility

A published tool version identifies an immutable public contract and handler
binding. Compatible product releases may continue to serve it without changing
that tool version. A behavior-changing contract needs a new tool publication
version even when the stable MCP name can remain additive-compatible.

Provider/model identities, routing policy revisions, capability declarations,
and pricing or meter inputs must be retained as immutable snapshots or durable
references. Historical runs must remain explainable after the active provider or
routing policy changes; product SemVer alone is not sufficient provenance.

## Background job compatibility

Jobs that can survive a deployment boundary must persist enough identity for a
new worker to interpret them safely, including the equivalent of:

```text
job_type
input_schema_version
handler_version
created_by_app_version
```

Workers must either support all non-expired queued payload versions or upgrade
older payloads through explicit, tested adapters before execution. A deployment
must not strand, silently reinterpret, or corrupt queued work merely because the
product release changed.

## Artifact compatibility

Artifact versions are immutable domain records and do not use SemVer. The
artifact versioning model should retain:

- a globally unique `artifact_version_id`;
- a per-artifact monotonic sequence;
- an immutable object key;
- an optional `parent_version_id`;
- source-run and output-set provenance; and
- optimistic concurrency against the current version.

S3-native version IDs may be recorded as storage evidence, but they are not the
application's artifact-versioning mechanism and never substitute for Relay's
domain identity.

## Database compatibility

Use monotonic, immutable migration identifiers. Before the first production
deployment, the implementation baseline may be consolidated as documented in
[`implementation-status.md`](implementation-status.md). Once a migration has
been applied to production or another non-disposable environment, never edit or
reuse its identifier.

Prefer expand-and-contract migrations:

1. Add compatible schema.
2. Deploy code that supports the old and new forms.
3. Backfill with resumable, observable work.
4. Switch reads and writes.
5. Remove the old schema in a later compatible deployment sequence.

Record migration state and the release identity that applied it separately from
product SemVer. A migration does not force a product major bump when rolling
deployments and rollback remain compatible.

## Legal, entitlement, and policy compatibility

Legal documents require immutable acceptance records containing the effective
document version and content hash. Editing text in place must never alter what a
historical acceptance means.

Plan and entitlement definitions also require historical identity. A plan named
`pro` may change over time, so subscriptions and grants must reference a catalog
version or immutable snapshot of granted entitlements rather than assuming the
current definition always applied. Provider, routing, pricing, and meter policies
follow the same historical-explainability rule.
