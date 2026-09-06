# Roll back

Confirm the previous release supports the current database schema and queued
jobs. Edit the backend image anchor and web image in `docker-compose.yml` from
`latest` to the same previous published SemVer tag, for example `0.1.1`.
Published manifests contain immutable digests if exact digest selection is
needed.

```sh
cd /opt/relay
docker compose pull relay-api relay-worker relay-web
docker compose up -d --no-deps --wait relay-api relay-worker relay-web
curl --fail https://relay.zaftech.co/health/ready
curl --fail https://relay.zaftech.co/version
```

`--no-deps` avoids running an older migration image against the newer schema. Do
not use the normal down/pull/up alias for this rollback or run automatic
down-migrations. Verify API/MCP, sign-in, worker behavior and telemetry
afterward. Keep the failing release's configuration and relevant database
backups for diagnosis.
