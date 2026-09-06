#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT

# Use an isolated project directory so tests never load a real .env or change
# the checkout. These checks render config only; they do not start Relay.
cp "$DEPLOY_DIR/compose.prod.yaml" "$temp_dir/docker-compose.yml"
while IFS= read -r line || [[ -n $line ]]; do
  case $line in
    DATABASE_URL=) line='DATABASE_URL=postgresql://relay_app:test-only@postgresql:5432/relay' ;;
    MIGRATOR_DATABASE_URL=) line='MIGRATOR_DATABASE_URL=postgresql://relay_migrator:test-only@postgresql:5432/relay' ;;
    REDIS_URL=) line='REDIS_URL=redis://relay:test-only@redis:6379/0' ;;
    SHARE_TOKEN_KEYS=) line='SHARE_TOKEN_KEYS={"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' ;;
    *=) line="${line}test-only-configuration-value" ;;
  esac
  printf '%s\n' "$line"
done < "$DEPLOY_DIR/.env.example" > "$temp_dir/.env"
chmod 600 "$temp_dir/.env"
docker compose --project-name relay --project-directory "$temp_dir" \
  --env-file "$temp_dir/.env" -f "$temp_dir/docker-compose.yml" \
  config --format json > "$temp_dir/compose.json"

jq -e '
  .services as $s |
  (.networks | keys) == ["postgresql-db-n8n", "proxy-net"] and
  all(.networks[]; .external == true) and
  all($s[]; (.ports // [] | length) == 0 and .build == null) and
  ($s["relay-migrate"].networks | keys) == ["postgresql-db-n8n"] and
  ($s["relay-api"].networks | keys) == ["postgresql-db-n8n", "proxy-net"] and
  ($s["relay-worker"].networks | keys) == ["postgresql-db-n8n", "proxy-net"] and
  ($s["relay-web"].networks | keys) == ["proxy-net"] and
  $s["relay-migrate"].command == ["migrate", "up"] and
  $s["relay-api"].command == ["api"] and
  $s["relay-worker"].command == ["worker"] and
  $s["relay-migrate"].healthcheck.disable == true and
  $s["relay-migrate"].environment.OTEL_DENO == "false" and
  $s["relay-api"].depends_on["relay-migrate"].condition == "service_completed_successfully" and
  $s["relay-worker"].depends_on["relay-migrate"].condition == "service_completed_successfully" and
  $s["relay-web"].depends_on["relay-api"].condition == "service_healthy" and
  ($s["relay-migrate"].environment.DATABASE_URL | startswith("postgresql://relay_migrator:")) and
  all(["relay-api", "relay-worker"][];
    $s[.].environment as $env |
    ($env.DATABASE_URL | startswith("postgresql://relay_app:")) and
    $env.APP_ENV == "production" and
    $env.OTEL_DENO == "true" and
    $env.OTEL_EXPORTER_OTLP_ENDPOINT == "http://alloy:4318" and
    $env.BETTER_AUTH_URL == "https://relay.zaftech.co" and
    $env.AUTH_TRUSTED_PROXY_CIDRS == "172.18.0.0/16" and
    $env.S3_PUBLIC_ENDPOINT == "https://storage.zaftech.co" and
    $env.S3_BUCKET_VERSIONING == "enabled") and
  $s["relay-api"].environment.RELAY_PROCESS_ROLE == "api" and
  $s["relay-worker"].environment.RELAY_PROCESS_ROLE == "worker" and
  $s["relay-api"].environment.S3_ACCESS_KEY_ID == "relay-api" and
  $s["relay-worker"].environment.S3_ACCESS_KEY_ID == "relay-worker" and
  ($s["relay-web"].environment // {} | length) == 0 and
  $s["relay-api"].image == $s["relay-worker"].image and
  $s["relay-api"].image == $s["relay-migrate"].image
' "$temp_dir/compose.json" >/dev/null

# Missing migration/worker credentials must fail before any service can start.
for key in MIGRATOR_DATABASE_URL S3_WORKER_ACCESS_KEY_ID S3_WORKER_SECRET_ACCESS_KEY; do
  sed "s/^$key=.*/$key=/" "$temp_dir/.env" > "$temp_dir/missing.env"
  if docker compose --project-directory "$temp_dir" --env-file "$temp_dir/missing.env" \
    -f "$temp_dir/docker-compose.yml" config --quiet >/dev/null 2>&1; then
    echo "Compose accepted missing $key" >&2
    exit 1
  fi
done

if [[ -n ${NGINX_TEST_IMAGE:-} ]]; then
  bash "$SCRIPT_DIR/validate-nginx-bootstrap.sh" "$NGINX_TEST_IMAGE"
fi
if [[ -n ${NGINX_TEST_IMAGE:-} && -n ${PYTHON_TEST_IMAGE:-} ]]; then
  bash "$SCRIPT_DIR/validate-nginx-routing.sh" "$NGINX_TEST_IMAGE" "$PYTHON_TEST_IMAGE"
fi
echo "Deployment checks passed: shared env, role overrides, startup ordering and existing networks."
