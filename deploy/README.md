# Relay deployment

Use the same layout and deployment pattern as Convia:

```text
/opt/relay/
  docker-compose.yml
  .env
  backups/                 # When a backup is needed
/opt/nginx/conf.d/
  relay.conf
```

Copy [`compose.prod.yaml`](compose.prod.yaml) as `docker-compose.yml` and fill
the single [`.env`](.env.example), mode `0600`. API, worker and migration use
`env_file: .env`. Migration overrides `DATABASE_URL` with the migrator account;
worker overrides the storage account. The backend services share the environment
file, like Convia. The static web container does not need it.

The Compose project contains only `relay-migrate`, `relay-api`, `relay-worker`
and `relay-web`. It reuses `postgresql-db-n8n` and `proxy-net`. Storage, Redis,
Nginx and telemetry use the existing services. Relay requires no application
bind mounts: artifacts are stored in the existing MinIO bucket.

## Deploy

Wait for the matching backend/web release to finish publishing, then:

```sh
cd /opt/relay
deploy
docker compose ps -a
curl --fail https://relay.zaftech.co/health/ready
curl --fail https://relay.zaftech.co/version
```

The existing alias performs down, pull and up. The Compose file uses `latest`,
matching Convia. Migration runs before API/worker startup; web waits for API
health. Version and revision are baked into each release image, so `.env` needs
no image digests or release selectors. For rollback, use the previous matching
SemVer tags as described in [the rollback guide](runbooks/rollback.md).

## Existing services

The runtime database user is `relay_app`; migration uses `relay_migrator`. Redis
uses its existing Relay ACL account. MinIO uses the versioned `relay-artifacts`
bucket, internally at `http://minio:9000`; signed browser transfers use
`https://relay.zaftech.co/relay-artifacts/`. Initial limits are 50 MiB per
upload and 1 GiB per workspace.

Install the single [`nginx/relay.conf`](nginx/relay.conf). It routes the web
app, API, MCP, OAuth discovery, share links and artifact transfers on the same
origin. It includes the bucket CORS policy and sandboxes inline HTML/SVG files.
Keep the existing host Certbot renewal setup. No new rate-limit file is needed.

Register the Google/GitHub callbacks at:

- `https://relay.zaftech.co/api/auth/callback/google`
- `https://relay.zaftech.co/api/auth/callback/github`

Cloudflare must allow machine requests to API/MCP, signed uploads, health checks
and the Faro collector without an interactive challenge. API proxy trust is
restricted to Nginx's existing stable address, `172.18.0.2/32`.

Backend telemetry uses the existing Alloy → Prometheus/Loki/Tempo path on
`proxy-net`. Browser Faro uses `https://zaftech.co/collect`. Import the local
[dashboard](observability/grafana/relay-dashboard.json) with
[these instructions](observability/grafana/IMPORT.md); copy the
[alert expressions](observability/grafana/ALERTS.md) into Grafana. No Grafana
provisioning directory or telemetry files belong under `/opt/relay`.

After deployment, verify sign-in, a small artifact transfer, and telemetry.
`contact@zaftech.co` must sign in normally before superadmin bootstrap. Paid
provider execution requires an explicit allowance.
