# Manual production rollback

Rollback always selects a previously verified backend/web digest pair. It never
uses `latest`, rebuilds an image, or runs a database down-migration.

## Decision gate

Before proceeding, confirm all of the following:

- The incident owner approved rollback rather than a forward fix.
- The previous backend is compatible with the current database schema and all
  migrations since that release were expand-only.
- The previous `releases/vMAJOR.MINOR.PATCH.env` still matches its published
  `release-manifest.json` and contains both original digests.
- The current restore-verified backup is within the configured freshness bound.
- Any jobs created by the newer version remain processable by the older worker.

If schema or queued-job compatibility is unknown, stop. Escalate to a forward
fix or an explicitly approved point-in-time restore plan.

## Preflight and rollback

Run preflight against the previous release first:

```sh
/opt/relay/scripts/preflight.sh \
  /opt/relay/releases/v0.1.0.env \
  /opt/relay/docker-compose.yml
```

Then acknowledge the schema decision explicitly:

```sh
/opt/relay/scripts/rollback-release.sh --confirm-schema-compatible \
  /opt/relay/releases/v0.1.0.env \
  /opt/relay/docker-compose.yml
```

The rollback script acquires the same deployment lock, pulls both old digests,
recreates API/worker/web as a pair, validates and reloads Nginx, verifies the
public version and health routes, and updates `current-release.env` only after
success. It does not invoke the migration service.

## After rollback

- Verify `/version` reports the previous tag's version and full revision.
- Verify API, MCP, SSE, sign-in, worker behavior, and telemetry.
- Preserve the failed release's env file and diagnostics.
- Record the incident and compatibility decision.
- Prefer an additive forward fix. Do not edit applied migration files, run an
  automatic down-migration, or use `docker compose down -v`.
