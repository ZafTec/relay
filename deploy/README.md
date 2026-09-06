# Relay production deployment

Relay follows the existing Convia deployment pattern: one Compose file and one
private environment file, using the VPS's existing services.

```text
/opt/relay/
  docker-compose.yml       # deploy/compose.prod.yaml
  .env                     # deploy/.env.example, mode 0600
/opt/nginx/conf.d/
  relay.conf               # deploy/nginx/relay.conf
```

## Everyday deployment

Use the installed Docker Compose plugin. The deployment account already belongs
to the Docker group, so its existing `deploy` alias can use:

```sh
alias deploy='docker compose down && docker compose pull && docker compose up -d'
cd /opt/relay
deploy
docker compose ps -a
curl --fail https://relay.zaftech.co/health/ready
```

Update both image digests and the matching release version/SHA in `.env` from
one published release manifest before running `deploy`. The one-shot migration
must succeed before API and worker start. The web service starts after the API
is healthy. `down` causes a brief outage, matching the existing alias. For an
update without stopping the whole project first, use
`docker compose pull &&
docker compose up -d --wait`.

The optional scripts under `scripts/` provide stricter release/backup checks and
an explicit rollback procedure. They are not required host infrastructure or
part of the normal alias workflow. See
[the deployment runbook](runbooks/deploy.md).

## Existing services and networks

| Process        | Networks                         |
| -------------- | -------------------------------- |
| API and worker | `proxy-net`, `postgresql-db-n8n` |
| Migration      | `postgresql-db-n8n`              |
| Web            | `proxy-net`                      |

Both networks are external; Relay creates no networks and publishes no host
ports. Reuse the existing PostgreSQL, Redis, MinIO, Nginx, Alloy, Prometheus,
Loki, and Tempo. No Redis, MinIO, Certbot, or telemetry container belongs in the
Relay Compose project.

Fill the required blanks in `.env`. Compose explicitly maps settings into each
service so OAuth/auth/share secrets reach only API, the Azure credential reaches
only worker, and the migrator credential reaches only migration. Do not inject
the entire file using `env_file`, or print rendered Compose configuration with
real credentials. Use `docker compose config --quiet` for syntax validation.

Runtime database connections use `relay_app`; migrations use `relay_migrator`,
which may assume `relay_owner`. Redis uses a Relay-specific ACL user restricted
to `relay:production:*`, with persistence and `noeviction` on the existing
server. Preserve the other applications' database grants and Redis ACLs.

MinIO stores artifacts in the versioned `relay-artifacts` bucket, with separate
bucket-scoped API and worker credentials. The internal endpoint is
`http://minio:9000`, and the public endpoint is `https://relay.zaftech.co`.
Initial limits are 50 MiB per upload and 1 GiB per workspace. Review available
storage before increasing them.

## Nginx, Cloudflare, and OAuth

Install the single [`nginx/relay.conf`](nginx/relay.conf) into the existing
Nginx configuration directory. It serves `/api`, `/mcp`, the approved OAuth
discovery routes, `/s/`, `/health/ready`, `/version`, the web app, and signed
artifact transfers at `/relay-artifacts/`. Docker DNS resolves upstreams at
request time, so Nginx can validate before Relay containers exist. No extra
rate-limit file is needed; Relay already enforces auth and execution admission
limits.

The Nginx file includes the bucket's browser CORS fallback because the installed
MinIO does not implement `PutBucketCors`. It preserves signed methods, paths,
queries and upload headers, and does not modify the shared MinIO server block.
The older route/header/CORS examples remain references for other installations;
do not install them alongside this complete file.

Use the existing host Certbot installation, webroot, timer, and renewal hook.
Nginx trusts Cloudflare's published IP ranges; the API's
`AUTH_TRUSTED_PROXY_CIDRS` must contain only Nginx's stable `proxy-net` address
(currently `172.18.0.2/32`), never the shared network subnet.

Cloudflare must permit API, MCP, OAuth discovery/callbacks, health checks,
signed artifact transfers, and the existing Faro collector without an
interactive challenge. Use **Full (strict)** TLS. Register these provider
callbacks:

- `https://relay.zaftech.co/api/auth/callback/google`
- `https://relay.zaftech.co/api/auth/callback/github`

Verify a real browser sign-in and a small signed artifact upload/download after
deployment. Superadmin bootstrap follows legitimate sign-in; never create a fake
verified identity. Paid provider execution requires an explicit allowance.

## Telemetry and local Grafana files

Backend signals travel over `proxy-net` through the existing Alloy collector to
the existing Prometheus, Loki and Tempo. Frontend errors and web vitals use
`https://zaftech.co/collect`. See [observability](observability/README.md) for
the small additions to the existing collector configuration.

- [Importable dashboard](observability/grafana/relay-dashboard.json): prompts
  for Prometheus, Loki and Tempo during import.
- [Import guide](observability/grafana/IMPORT.md).
- [Alerts to copy into Grafana](observability/grafana/ALERTS.md).

No dashboard, alert rule, datasource or notification policy is provisioned on
the server by these files.
