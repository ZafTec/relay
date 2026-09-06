# CI, release, and deployment

Phase: Wave 1 CI foundation and Wave 6 production release\
Primary owners: CI/release worktree and deployment worktree\
Depends on: stable quality commands, backend/web images, migration command,
approved versioning policy

## Target flow

```text
feature branch
  -> pull request to protected main
  -> required CI
  -> squash merge
  -> Release Please updates a release PR
  -> owner merges release PR
  -> release automation creates vMAJOR.MINOR.PATCH tag and draft GitHub release
  -> tag workflow builds/scans/pushes images from that exact SHA
  -> release manifest records immutable digests
  -> automation publishes the draft release only after all evidence succeeds
  -> operator deploys manually from /opt/relay
  -> customer changelog draft is reviewed and published
```

No workflow deploys to the VPS by SSH.

## Protected main

Configure a repository ruleset for `main`:

- Pull request required
- Required aggregate check such as `CI / required`
- Conversation resolution
- Stale approvals dismissed when applicable
- Force pushes and deletion blocked
- Linear history
- Squash merge preferred
- Explicitly documented emergency bypass only
- Merge queue if the GitHub plan supports it; otherwise require up-to-date
  branch

For a single eligible maintainer, do not make the repository impossible to
merge. Keep the PR and CI requirement even if approval count must initially be
zero.

Protect `v*` tags so only the release automation identity and emergency role can
create/delete them.

## Commit and release convention

Release Please expects Conventional Commit semantics. The repository may retain
short imperative commits inside feature branches if the squash-merged PR title
is validated as:

```text
feat: Add ...
fix: Correct ...
perf: Improve ...
deps: Update ...
docs: Document ...
chore: Maintain ...
```

The merged commit seen by Release Please must carry the conventional prefix.

Version policy remains blocked until [`../versioning.md`](../versioning.md) is
approved. Recommended researched choices:

- First release `0.1.0`
- Tag `vMAJOR.MINOR.PATCH`
- Pre-1.0 `feat` increments minor; `fix` increments patch
- One product version for backend and web
- Git tag is canonical release identity

## PR CI

Add `.github/workflows/ci.yml` with `pull_request`, `push` to main, and
`merge_group` when merge queue is enabled. Use read-only default permissions and
no production/Docker Hub secrets in pull-request jobs.

Parallel jobs:

### Source

```text
deno fmt --check maintained source/docs paths
deno lint maintained source paths
deno check --frozen entry points
deno test --frozen with minimum permissions
```

Raw design exports are validated separately and excluded deliberately from Deno
formatting.

### Web

After `apps/web` exists:

```text
frozen install
lint
type check
unit tests
production Vite build
```

### Integration

Disposable PostgreSQL 18, tested Redis version, and MinIO on an isolated Compose
network. Prefer no host-published ports; run test containers on that network.

### Migrations

- Fresh
- Repeat/no-op
- Checksum mismatch
- Concurrent advisory lock
- Failure rollback
- Upgrade from previous release fixture
- Runtime-role permission denial

### Backend containers

- API startup/live/ready
- Worker startup/SIGTERM
- Migration/status commands
- Source-free compiled execution
- Non-root/read-only behavior

### Web container

- Health endpoint
- Static assets
- SPA fallback
- API/MCP paths do not fall through to `index.html`

### Browser

- Landing
- Google/GitHub sign-in UI using test auth/session fixtures
- Protected dashboard
- Sign-out/session expiry
- Accessibility and responsive checks

### Security

- Dependency review
- Secret scan/push protection
- Repository/config scan
- Final-image vulnerability scan
- SARIF upload where supported

Expose one stable required aggregate job that depends on all applicable jobs.
Pin third-party Actions to reviewed full commit SHAs. Dependency updates are
reported in a recurring issue for review; automatic dependency PRs are disabled.
See [dependency update reporting](../dependency-updates.md).

## Release Please

Recommended files after versioning approval:

```text
release-please-config.json
.release-please-manifest.json
version.txt
CHANGELOG.md
.github/workflows/release-please.yml
.github/workflows/release-images.yml
```

Use the `simple` release type for the repository-level product version. Treat
`version.txt` as release bookkeeping; the tag and embedded build metadata remain
runtime authority.

Configure Release Please to create a tag plus **draft** GitHub release. Its
default `GITHUB_TOKEN` generally cannot trigger subsequent tag workflows from
resources it creates. Use a narrowly scoped repository GitHub App installation
token so the tag triggers the image workflow. The App is the permitted actor in
the protected `v*` tag ruleset.

The tag workflow builds from that exact tag SHA, attaches digest manifest/SBOM/
provenance, and publishes the existing draft release only after every image and
scan succeeds. A failed build leaves a draft release and no approved production
manifest; retry must use the same SHA. Do not give release automation production
database/changelog publish access.

## Image workflow

The owner's desired policy is release-only publication. Pull requests build but
do not push. Normal merges update the release PR but do not publish production
images.

On a valid release tag, build:

```text
DOCKERHUB_NAMESPACE/relay-backend
DOCKERHUB_NAMESPACE/relay-web
```

Backend commands:

```text
api
worker
migrate
healthcheck
```

Both images share version and Git SHA. A release fails if either image fails.

Required immutable tags:

```text
<semver without v>
git-<full-sha>
```

A moving `latest` tag may be published only if the owner chooses it to mean the
latest stable release. Production should deploy SemVer or digest, not `latest`.

OCI labels:

```text
org.opencontainers.image.title
org.opencontainers.image.description
org.opencontainers.image.source
org.opencontainers.image.documentation
org.opencontainers.image.vendor
org.opencontainers.image.version
org.opencontainers.image.revision
org.opencontainers.image.created
org.opencontainers.image.licenses
```

Generate:

- SBOM
- Build provenance
- Final-image vulnerability result
- `release-manifest.json` with version, tag, revision, and both image digests

Build both images once and preserve their OCI artifacts/digests. Scan and attest
those exact artifacts before promotion. Push them first under run-specific
candidate references, then promote the two final SemVer/SHA tags to the already
verified digests. Promotion is idempotent: if one repository succeeds and the
other fails, retry promotes the missing tag to the same preserved digest rather
than rebuilding. Publish the draft GitHub release only after both final tags and
the manifest verify.

Use workflow concurrency keyed by release tag. Declare minimal job-level
permissions; image-build jobs never receive the Release App private key.

Docker Hub repository names and namespace remain owner inputs. Use a protected
release environment with a push-only CI token and, for private repositories, a
separate read-only VPS pull token. Enforce no-overwrite/immutability for SemVer
and SHA tags and deploy by digest.

## Changelog separation

Release Please manages repository `CHANGELOG.md` and GitHub release notes. These
are engineering candidate notes.

Relay public changelog remains:

- PostgreSQL-backed
- Draft/published/archived
- Linked to exact tag/SHA
- Superadmin-reviewed
- Audited
- Public only after publication

Recommended production flow:

1. Release workflow creates GitHub notes and images.
2. Operator deploys and verifies.
3. Operator or a narrow command imports a draft linked to tag/SHA.
4. Superadmin edits and publishes.
5. Landing/changelog/feed read only published entries.

Do not expose raw Git history or auto-publish release notes to customers.

## Production Compose

Repository should provide `deploy/compose.prod.yaml` as a reviewed pull-only
template. `/opt/relay/docker-compose.yml` is its operator-controlled deployed
copy. Set top-level Compose project name `relay` (or always pass
`--project-name relay`) so orphan removal and service names cannot drift with
the directory name.

Services:

```text
api       backend image, command api
worker    backend image, command worker
migrate   backend image, one-shot `tools` profile, command ["migrate", "up"]
web       web image
```

No production `build:` sections and no app host ports. Use external networks for
Nginx, PostgreSQL, Redis, MinIO, and telemetry.

Suggested `/opt/relay` layout:

```text
/opt/relay/
  docker-compose.yml
  .env                         secret runtime configuration, mode 0600
  current-release.env          selected version/digests and network names
  releases/
    v0.1.0.env
  runbooks/
```

Compose interpolation values such as image digests and network names belong in
the file passed with `--env-file`. Service `env_file` does not control Compose
interpolation.

## Nginx routes

Use actual Nginx prefix/exact locations, not wildcard notation. Required route
order is:

```text
exact approved OAuth/OIDC and protected-resource metadata paths -> relay-api
/mcp and chosen /mcp/ behavior                                  -> relay-api
/api/v1/events                                                   -> relay-api, SSE settings
/api/                                                            -> relay-api
approved /s/ or /share/ prefix                                  -> relay-api
/health/ready and /version for the public status page           -> relay-api
/health/live only if intentionally public                       -> relay-api
/                                                               -> relay-web
```

At minimum route `/.well-known/oauth-protected-resource/mcp` explicitly. Route
only the exact additional metadata aliases emitted by the pinned Better Auth
configuration; do not proxy all `/.well-known/` traffic because ACME and
unrelated well-known resources belong elsewhere.

Relay's factual public `/status` page is the deliberate operational need for
exposing `/health/ready` and `/version`. Keep both responses sanitized and free
of secrets, internal addresses, and raw dependency errors. Compose healthchecks
continue to use the backend command internally; do not expose liveness merely
because readiness is public.

Common proxy requirements:

- Preserve Host
- Set controlled forwarded scheme/host/client IP
- Do not trust caller-supplied Cloudflare headers unless the origin accepts only
  verified Cloudflare addresses
- A mandatory tested upstream-refresh strategy: Docker DNS re-resolution
  supported by the pinned Nginx version, or `nginx -t` plus graceful reload
  after Relay container replacement
- Unique aliases such as `relay-api` and `relay-web`
- No WebSocket upgrade for MCP Streamable HTTP
- OAuth callback access logging based on `$uri`, not query-bearing `$request` or
  `$request_uri`; error-log and Cloudflare logging are included in canary review
- Clear untrusted `traceparent`, `tracestate`, and `baggage` before proxying
  public traffic unless an explicit trusted-propagation policy applies

For `/mcp` and dashboard SSE:

```text
proxy_http_version 1.1
proxy_set_header Connection ""
proxy_buffering off
proxy_cache off
gzip off
proxy_read_timeout longer than heartbeat interval
proxy_send_timeout explicitly bounded
send_timeout explicitly bounded
proxy_next_upstream off
```

Preserve Authorization, Origin, MCP protocol headers, `Last-Event-ID`, and
content negotiation headers.

## Manual deployment

Define the migration service command as `["migrate", "up"]`; do not append an
ambiguous `up` override. Use one selected release file (`current-release.env`,
symlinked or copied from `releases/`) and a host deployment lock.

Preferred sequence:

```sh
cd /opt/relay
flock --exclusive /opt/relay/.deploy.lock -c './runbooks/deploy-current.sh'
```

Pre-create `/opt/relay/.deploy.lock` with deployment-account ownership. The
reviewed script starts with fail-fast shell options and an error trap, then
performs, in order:

```sh
docker compose --project-name relay --env-file current-release.env config --quiet
docker network inspect <each-required-external-network>
docker compose --project-name relay --env-file current-release.env pull
docker compose --project-name relay --env-file current-release.env run --rm migrate
docker compose --project-name relay --env-file current-release.env up -d --wait --wait-timeout <bounded-seconds> --remove-orphans
docker compose -f /opt/nginx/docker-compose.yml exec -T nginx nginx -t
docker compose -f /opt/nginx/docker-compose.yml exec -T nginx nginx -s reload
# The two Nginx commands are required when dynamic upstream resolution is not proven.
```

Before mutation it also verifies Compose version, host architecture, registry
access, image digests, free disk, and backup/PITR freshness.

Then verify internal and public health/version/auth routes, worker heartbeat,
and telemetry before marking deployment complete. Execute job and rollback
rehearsals in isolated staging. A production job smoke requires a separately
approved non-billable synthetic tool/workspace, bounded cleanup, and a change
window.

Do not use `docker compose down -v` in production. Even though current durable
infrastructure is external, it creates downtime and can delete future
application-owned/anonymous volumes.

## Rollback

Application rollback is valid when migrations were expand-only and the previous
backend supports the current schema:

1. Acquire the same `/opt/relay/.deploy.lock`.
2. Select an explicit previous release digest file.
3. Repeat architecture/disk/digest/network preflight.
4. Pull with project name `relay`.
5. Run bounded `up -d --wait --remove-orphans` with that explicit env file.
6. Run the same Nginx DNS/reload path.
7. Verify API/web/worker/version.
8. Keep additive schema.

Do not automatically run production down-migrations. For destructive data
events, prefer a forward fix or tested point-in-time restore with explicit
approval.

Backend and web normally roll back as a version pair unless mixed compatibility
was explicitly tested.

## Expected tests

### CI governance

- Direct push/failed required checks cannot merge.
- PR jobs receive no production/Docker secrets.
- Required aggregate fails when any required lane fails.
- Merge-queue event runs CI if merge queue is enabled.

### Release

- Conventional `feat` and `fix` produce expected proposal.
- Invalid/mismatched tag fails.
- Tag commit must be reachable from main.
- `version.txt`, tag, runtime `/version`, OCI labels, and manifest agree.
- Tag event really triggers image workflow with selected release identity.
- Both images are built from same SHA.
- Injected failure after the first final image tag is promoted does not rebuild;
  retry verifies the existing tag matches the preserved digest, promotes only
  the missing tag, fails on conflicting digest, and publishes a manifest
  matching both final tags.
- SBOM/provenance/scans are attached and verifiable.

### Deployment

- Compose renders with selected release env and the migration service resolves
  to the complete `migrate up` command.
- External network absence, wrong architecture, missing digest, low disk, stale
  backup, or concurrent deployment lock fails before mutation.
- API container recreation either re-resolves automatically or is followed by a
  tested graceful Nginx reload.
- Migration failure leaves old services available where sequence permits.
- Healthchecks gate successful `--wait`.
- Nginx web/API/MCP/well-known/share/SSE routing works.
- No application or database port is unintentionally published.
- Previous image rollback succeeds after additive migration.
- Public changelog draft remains private until superadmin publish.

## Completion gate

Release/deployment is ready when a protected PR produces a reviewed SemVer tag,
both immutable images and their evidence, a digest-pinned manual deployment,
verified migration/rollback behavior, and a separate unpublished customer
changelog draft.
