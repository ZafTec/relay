# Deploy with the existing alias

GitHub Actions publishes release images. Deploy from the VPS using
`/opt/relay/docker-compose.yml` and `/opt/relay/.env`.

## Select the release

1. Confirm the GitHub release is published and its image/security checks passed.
2. Download `release-manifest.json` and `SHA256SUMS` from that release and
   verify the downloaded assets with `sha256sum --check SHA256SUMS`.
3. Update `RELEASE_VERSION`, `RELEASE_TAG`, `RELEASE_GIT_SHA`, `BACKEND_DIGEST`,
   and `WEB_DIGEST` in `.env` from that same manifest. Keep both digests paired.
   Record the previous nonsecret selectors for rollback.
4. Confirm a recent database backup can be restored before a schema change.
   Check free disk space and the health of the shared dependencies.

## Deploy

The existing alias should use the installed Compose plugin:

```sh
alias deploy='docker compose down && docker compose pull && docker compose up -d'
cd /opt/relay
docker compose config --quiet
deploy
docker compose ps -a
curl --fail https://relay.zaftech.co/health/ready
curl --fail https://relay.zaftech.co/version
```

Migration runs automatically and gates API/worker startup. A failed migration
prevents startup; inspect `docker compose logs migrate` and resolve the failure.
Do not bypass the migration dependency to force the app up. The web container
waits for API health. Public readiness and version checks must succeed through
Cloudflare, not just from inside Docker.

If only the images or `.env` changed, no Nginx reload is needed: Docker DNS
resolves the fixed Relay aliases at request time. After editing `relay.conf`:

```sh
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```

Check worker heartbeats, backend logs/traces, and browser Faro events in the
imported dashboard. Test sign-in and a small artifact upload/download. Do not
run paid tools without an explicit allowance.

## Roll back application images

Confirm the previous binaries support the current database schema. Restore the
previous paired version/SHA/digests in `.env`, then:

```sh
docker compose pull api worker web
docker compose up -d --no-deps --wait api worker web
```

`--no-deps` deliberately avoids running an older migration image against the
newer schema. Never run automatic down-migrations. If schema compatibility is
uncertain, stop and use the database recovery procedure.

## Optional stricter release scripts

The repository also includes `scripts/preflight.sh`, `deploy-release.sh`, and
`rollback-release.sh`. They validate release labels/platform/digests, service
credential separation, proxy trust, dependency configuration, disk space and
restore-verification evidence. Their additional host requirements are Bash,
Buildx, jq, curl, GNU date and flock. These are optional tools for operators who
want that workflow; the normal `deploy` alias does not require them.

If using them, keep `/opt/relay/.deploy.lock` owned by the deployment account
and pass `.env` (or an optional immutable release selector) plus the Compose
path. The scripts write only nonsecret selectors to release history. A missing
backup marker must be fixed by completing a restore test, never by fabricating
evidence.
