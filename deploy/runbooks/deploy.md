# Manual production deployment

GitHub Actions does not SSH to production. Run this procedure from an authorized
operator session on the host during a change window.

## Before the window

1. Confirm the GitHub release is published, not draft.
2. Download `release-manifest.json`, `SHA256SUMS`, both SPDX SBOMs, both
   provenance bundles, and both Trivy reports from that release.
3. Verify `sha256sum --check SHA256SUMS` in the asset directory.
4. Verify the manifest's `tag`, `revision`, `platform`, repositories, and both
   digests against the intended release. The platform must be `linux/amd64`.
   Preflight permits linked `unknown/unknown` attestation descriptors but no
   additional runnable platform descriptors.
5. Copy `deploy/releases/release.env.example` to an immutable file named for the
   tag under `/opt/relay/releases/`. Fill both digests from the same manifest;
   never combine backend and web from different releases.
6. Copy all three `deploy/env/*.env.example` templates to
   `/opt/relay/env/`, populate every mandatory blank through the host secret
   process, retain the fail-closed role key sets documented in
   `deploy/README.md`, set ownership to the deployment account, and set mode
   `0600`. Confirm `BETTER_AUTH_URL` equals `RELAY_PUBLIC_URL` and every trusted
   origin is a path-free HTTPS origin.
7. Confirm the S3/MinIO bucket exists, versioning is enabled, the internal
   endpoint is reachable from the data network, and API/worker credentials have
   only their required bucket access. Confirm `S3_PUBLIC_ENDPOINT` is the HTTPS
   S3 API endpoint (not the MinIO Console), resolves with a browser-trusted
   certificate from outside the host network, and reaches the same bucket.
   Apply `deploy/minio/relay-browser-cors.xml.example` with the exact Relay web
   origin and verify the PUT preflight accepts all six documented signed headers;
   retain its GET/HEAD rule only when browser-direct reads are enabled.
8. Give Nginx a stable edge-network address and set
   `AUTH_TRUSTED_PROXY_CIDRS` to only that exact address (bare, `/32`, or
   `/128`). Do not enter a Docker subnet, private-address range, Cloudflare
   range, or catch-all CIDR.
9. Authenticate Docker with a separate read-only production pull token. Pass the
   token through standard input; do not place it in a release file or shell
   history.
10. Confirm the backup system has recently completed a restore verification and
    updated `BACKUP_VERIFIED_AT_FILE`. Do not edit the marker merely to satisfy
    preflight.
11. Confirm the Nginx, data, and telemetry services are healthy on the three
    external networks. Relay containers do not need to exist yet: fixed
    upstream variables defer their Docker DNS lookup until a request. Reconcile
    the existing observability deployment per `deploy/observability/README.md`
    before enabling OTLP.

## Preflight

Run the non-mutating gate first:

```sh
/opt/relay/scripts/preflight.sh \
  /opt/relay/releases/v0.1.0.env \
  /opt/relay/docker-compose.yml
```

Do not continue after any failure. Fix the underlying credential, backup,
network, disk, image, label, architecture, permission, or configuration issue.
The script intentionally does not create or repair infrastructure. It validates
Compose-interpreted values, rejects keys outside each role's documented
allowlist, and runs bootstrap-safe `nginx -t`. In particular, do not run
`migrate` directly to bypass a missing API/worker value: the deployment script
always completes this gate before invoking migration.

## Deploy

```sh
/opt/relay/scripts/deploy-release.sh \
  /opt/relay/releases/v0.1.0.env \
  /opt/relay/docker-compose.yml
```

The script, under one non-blocking host lock:

1. repeats preflight;
2. pulls the exact backend and web digests;
3. runs the one-shot `migrate up` service with the dedicated migrator env;
4. recreates API, worker, and web and waits for image health checks;
5. validates and gracefully reloads the independently managed Nginx service;
6. verifies public version, readiness, web health, OAuth metadata, and each
   container health state; and
7. updates `current-release.env` only after successful verification.

A failure does not run an automatic rollback or a down-migration. Inspect the
still-running services and logs, preserve evidence, then choose a forward fix or
the reviewed rollback procedure.

## Post-deployment checks

- Confirm `/version` returns the selected version and full revision.
- Confirm `/health/ready`, sign-in metadata, API, MCP, SSE, and a non-billable
  staging job where one is approved.
- Confirm the worker is processing heartbeats/jobs as expected.
- Complete one disposable browser upload through the presigned
  `S3_PUBLIC_ENDPOINT`; confirm OPTIONS and PUT succeed without cookies or an
  Authorization header, and that the uploaded size/checksums verify.
- Confirm one canary trace, metric, and log reaches the reconciled telemetry
  backends without duplicate log ingestion or sensitive fields.
- Exercise a disposable share link and confirm its `/s/:token` request is absent
  from Nginx access logs and no token-bearing Referer reaches downstream logs.
- Keep the prior release env file and both prior digests available for rollback.
- Import customer changelog content only as a draft; publication remains a
  separate audited superadmin action.

Never run `docker compose down -v` in production.
