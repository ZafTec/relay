# Relay production deployment assets

These files are reviewed templates for an operator-driven deployment. GitHub
Actions builds and publishes release artifacts but never connects to a host and
never runs these scripts remotely.

The application stack is pull-only and digest-pinned. PostgreSQL, Redis, object
storage, Nginx, and telemetry remain independently managed. The existing
[`observability`](observability/README.md) templates must be reconciled with the
live services; this release work does not modify or activate them.

## Host requirements

- Linux on `amd64`.
- Docker Engine, Docker Buildx, and Docker Compose 2.24 or newer.
- Bash, `curl`, GNU `date`, `flock`, `jq`, and standard GNU utilities.
- A Docker Hub credential with read-only access to both image repositories,
  configured ahead of time with `docker login --password-stdin`.
- Three pre-existing, distinct external Docker networks:
  - edge: shared only with the existing Nginx service;
  - data: shared only with PostgreSQL, Redis, and required object storage;
  - telemetry: shared only with the reconciled Alloy collector.
- A stable Nginx container address on the edge network. The API trusts only
  this exact address as its forwarding proxy, never the entire Docker subnet.
- S3-compatible MinIO reachable from the data network, with the configured
  bucket created, versioning enabled, and separate least-privilege runtime
  credentials provisioned for API and worker where supported.
- A restore-verified backup process that updates the timestamp file named by
  `BACKUP_VERIFIED_AT_FILE` only after a successful restore test.

`deploy/scripts/preflight.sh` creates no networks, files, images, containers, or
registry tags. Before a deployment can run its migration, preflight validates
all role-specific environment entries and policy bounds from Compose's
interpreted values, checks the API's exact Nginx proxy allowlist against the
running container, runs `nginx -t`, reads Docker/network state and the backup
marker, and inspects remote OCI metadata. A missing or misplaced secret,
undocumented env-file key, invalid production setting, failed
registry login, missing network, stale backup, wrong architecture, low disk,
permissive secret-file mode, version-label mismatch, or digest mismatch stops
the operation.

## Recommended `/opt/relay` layout

```text
/opt/relay/
  docker-compose.yml
  current-release.env -> releases/v0.1.0.env
  .deploy.lock
  env/
    api.env
    worker.env
    migrate.env
  minio/
    relay-browser-cors.xml
  releases/
    v0.1.0.env
  scripts/
    lib.sh
    preflight.sh
    deploy-release.sh
    rollback-release.sh
```

Copy `compose.prod.yaml` to `/opt/relay/docker-compose.yml`, the scripts to
`/opt/relay/scripts`, and the examples under `env/`, `minio/`, and `releases/`
to the corresponding host directories. The three service environment files contain
secrets after provisioning and must be mode `0600`. The release file contains
selectors and digests, not credentials.

The web image has no runtime environment file: it is immutable static content.
API, worker, and migration credentials are intentionally separate. In
particular, never place the migrator database URL in `api.env` or `worker.env`.

## Production environment contract

Copy each `env/*.env.example` file rather than composing an ad hoc subset. The
API and worker files both require `APP_ENV=production`, runtime database/Redis
settings, the complete S3/MinIO contract, and all eight explicit artifact quota,
TTL, purge, lease, interval, and batch values. Their shared non-secret S3 and
artifact values must match.

Role-only secrets are enforced by preflight:

- `api.env` owns Better Auth/OAuth credentials and the versioned
  `SHARE_TOKEN_ACTIVE_VERSION`/`SHARE_TOKEN_KEYS` keyring. It must not contain
  any `AZURE_*` variable.
- `worker.env` owns `AZURE_API_KEY`. Better Auth, trusted-origin/proxy, Google,
  GitHub, share-token, and `S3_PUBLIC_ENDPOINT` entries are prohibited.
- `migrate.env` owns only the dedicated migrator database connection and its
  bounded pool/timeouts. Azure, Better Auth, Google, GitHub, trusted-origin,
  trusted-proxy, and share-token entries are prohibited.

Each role file is fail-closed against the keys in its checked-in template;
undocumented variables are rejected rather than silently injected into a
container. Add a legitimate new setting to the relevant template, preflight
allowlist, and tests together. Preflight validates the environment values after
Compose has applied env-file quoting and interpolation, while still rejecting
malformed or duplicate raw entries.

`SHARE_TOKEN_KEYS` is a one-line JSON object from positive integer versions to
base64/base64url secrets that decode to at least 32 bytes. Keep old key versions
while links signed by them remain valid, and select the writing key with
`SHARE_TOKEN_ACTIVE_VERSION`. Provision keyring, auth, OAuth, S3, database,
Redis, and Azure values through the host secret manager; the examples contain
no usable secrets. `RELAY_PUBLIC_URL` and `BETTER_AUTH_URL` must be the same
HTTPS DNS origin. Every comma-separated `AUTH_TRUSTED_ORIGINS` entry must be a
unique HTTPS DNS origin without credentials, path, query, fragment, or wildcard,
and the list must include `BETTER_AUTH_URL`.

The S3 declarations require path-style requests and bucket versioning. Preflight
checks their presence, bounds, HTTPS public endpoint, and API/worker agreement;
the operator must separately verify the remote bucket exists, versioning is
actually enabled, and each credential has only the required bucket permissions.

## Browser direct-upload contract

`S3_ENDPOINT` is the private API/worker endpoint. `S3_PUBLIC_ENDPOINT` is the
S3-compatible API origin embedded in presigned URLs returned to the web client;
it must use HTTPS, have a browser-trusted certificate, resolve from customer
browsers, and reach the same bucket as `S3_ENDPOINT`. It must not point at the
MinIO Console. Any reverse proxy in front of it must pass the original path,
query string, method, and signed request headers without adding authentication
or rewriting the presigned request.

Configure CORS on the artifact bucket for the exact Relay web origin (the
browser page's origin, not `S3_PUBLIC_ENDPOINT`). The upload rule requires
`PUT` and these exact non-safelisted/signed headers:

```text
content-type
content-md5
if-none-match
x-amz-checksum-sha256
x-amz-meta-relay-upload-id
x-amz-meta-relay-sha256
```

Do not replace the origin or header list with `*`, and do not add
`Authorization`: browser uploads use query-authenticated presigned URLs with
`credentials: omit`. S3 handles the preflight `OPTIONS` request internally, so
`OPTIONS` is not an S3 `AllowedMethod`. Add `GET` and `HEAD` only when browsers
also follow presigned downloads or inspect objects directly. The checked-in
[`minio/relay-browser-cors.xml.example`](minio/relay-browser-cors.xml.example)
contains a separate removable read rule so upload permissions stay explicit.

`content-length` is part of Relay's signed upload contract. The web client
checks that its signed value exactly equals `Blob.size`, but JavaScript must not
set the `Content-Length` header: Fetch/browser networking emits it from the body.
Consequently, `content-length` must not be listed as a CORS `AllowedHeader` and
will not appear in `Access-Control-Request-Headers`; MinIO still validates the
wire value against the presigned request.

Copy the example to `/opt/relay/minio/relay-browser-cors.xml`, replace its
`AllowedOrigin` values with the exact production web origin, then apply and read
back the policy using an already configured operator-local MinIO alias. These
commands contain no credentials:

```sh
mc cors set relay-production/relay-artifacts \
  /opt/relay/minio/relay-browser-cors.xml
mc cors get relay-production/relay-artifacts
```

Do not put `mc alias set` credentials in this file or shell history. Verify the
browser-facing endpoint itself with a non-mutating preflight request, replacing
the example URL with the path-style public bucket URL:

```sh
curl --include --request OPTIONS \
  --header 'Origin: https://relay.zaftech.co' \
  --header 'Access-Control-Request-Method: PUT' \
  --header 'Access-Control-Request-Headers: content-type,content-md5,if-none-match,x-amz-checksum-sha256,x-amz-meta-relay-upload-id,x-amz-meta-relay-sha256' \
  'https://objects.example.com/relay-artifacts/cors-preflight-probe'
```

The response must allow exactly the Relay origin, include `PUT`, and accept all
six requested headers. Repeat from a browser-representative network; a successful
check from the server alone does not prove public DNS, TLS, or edge routing.

## Nginx integration

Install `nginx/relay-log-format.conf` in the existing Nginx `http` context,
`nginx/relay-proxy-headers.conf` as
`/etc/nginx/snippets/relay-proxy-headers.conf`, and include
`nginx/relay-routes.conf` inside the existing `relay.zaftech.co` TLS server.
Reconcile paths with the host layout and do not replace unrelated Nginx config.
Set `NGINX_SERVICE` to the service name in that independently managed Compose
project (the template default is `nginx`).

The Nginx container must join the selected edge network with a stable address.
Set `AUTH_TRUSTED_PROXY_CIDRS` in `api.env` to that address alone, either bare or
as `/32` for IPv4 or `/128` for IPv6. Preflight compares every configured entry
to the running Nginx container. Never trust `0.0.0.0/0`, `::/0`, an RFC 1918
range, the edge subnet, or Cloudflare address ranges here. If Cloudflare fronts
the origin, its published ranges belong only in Nginx's separately audited
`set_real_ip_from` policy so the normalized `$remote_addr` is forwarded.

The route fragment uses fixed `relay-api` and `relay-web` variables with Docker's
embedded resolver at `127.0.0.11`. Resolution happens at request time, so
`nginx -t` succeeds during the first deployment before either Relay container
exists; missing upstreams still fail requests with a gateway error and never
fall back to caller-controlled hosts. Deployment and rollback retain their
post-replacement validation and graceful reload, while preflight runs
`nginx -t` before any migration.

The access-log format uses `$uri`, never query-bearing `$request` or
`$request_uri`, and never records Referer. Access logging is disabled entirely
for `/s/:token`; incoming Referer is not forwarded upstream, and share responses
force the `Referrer-Policy: no-referrer` header.

This deploy-layer control cannot remove the bearer token from the URL received
by the API itself. Relay's structured logs must continue to use the route
template, and the reconciled Alloy policy must continue dropping `url.full`,
`url.path`, and `url.query`. Eliminating token-bearing paths at the source would
require an application/protocol change outside this directory.

## Release files and paired digests

Download `release-manifest.json` and `SHA256SUMS` from the published GitHub
release, verify the checksums, and create one immutable release file from
`releases/release.env.example`. Copy the exact version, tag, full Git SHA,
backend digest, and web digest from the manifest. Backend and web are always
selected, deployed, and rolled back as one pair.

Production references are always:

```text
zaftec/relay-backend@sha256:...
zaftec/relay-web@sha256:...
```

Changing `latest`, a SemVer tag, or a full-SHA tag cannot change what an existing
release file deploys. Remote preflight accepts Buildx `.Image` metadata either as
a direct single-platform image object or a `linux/amd64` platform map. For an
OCI index, it requires exactly one runnable `linux/amd64` descriptor and permits
only standard `unknown/unknown` attestation manifests linked to that runnable
digest; extra runnable platforms or unmarked unknown descriptors fail closed.

## Commands

From a source checkout, validate the deploy assets without real secrets or a
running production stack:

```sh
deploy/tests/validate-deploy.sh
```

This checks Bash syntax, env-role completeness, Nginx privacy/runtime-DNS
invariants, and a synthetic `docker compose config --format json` render with
fake digests. When `jq` is available it also exercises interpreted-value,
trusted-origin, role-isolation, and image metadata acceptance/rejection cases.
It does not pull or start application containers.

To prove bootstrap validation and routing against locally cached, reviewed test
images, provide digest-pinned image references:

```sh
NGINX_TEST_IMAGE='nginxinc/nginx-unprivileged@sha256:<verified-digest>' \
PYTHON_TEST_IMAGE='python@sha256:<verified-digest>' \
  deploy/tests/validate-deploy.sh
```

The bootstrap test intentionally provides no `relay-api` or `relay-web` DNS
records. The routing test then uses isolated mock upstreams to verify API/web
selection, URI/query preservation, Referer removal, the share response policy,
and absence of share tokens from Nginx access logs.

Run the full non-mutating host preflight at any time:

```sh
/opt/relay/scripts/preflight.sh /opt/relay/releases/v0.1.0.env \
  /opt/relay/docker-compose.yml
```

Deploy and rollback only from an interactive, authorized operator session:

```sh
/opt/relay/scripts/deploy-release.sh /opt/relay/releases/v0.1.0.env \
  /opt/relay/docker-compose.yml

/opt/relay/scripts/rollback-release.sh --confirm-schema-compatible \
  /opt/relay/releases/v0.1.0.env /opt/relay/docker-compose.yml
```

The scripts acquire `/opt/relay/.deploy.lock` themselves. Pre-create it with the
deployment account as owner. Set `RELAY_DEPLOY_LOCK_FILE` only when the reviewed
host layout intentionally uses another path.

See [`runbooks/deploy.md`](runbooks/deploy.md) and
[`runbooks/rollback.md`](runbooks/rollback.md) before operating production.
