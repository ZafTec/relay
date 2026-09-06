#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

fail() {
  echo "deploy validation failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

assert_single_env_entry() {
  local file=$1
  local key=$2
  local count
  count=$(grep -Ec "^${key}=" -- "$file" || true)
  [[ $count == 1 ]] || fail "$file must contain exactly one $key entry"
}

assert_no_env_prefix() {
  local file=$1
  local prefix=$2
  if grep -Eq "^${prefix}[A-Z0-9_]*=" -- "$file"; then
    fail "$file contains forbidden ${prefix}* variables"
  fi
}

require_command bash
require_command docker
require_command grep
require_command mktemp

bash -n \
  "$DEPLOY_DIR/scripts/lib.sh" \
  "$DEPLOY_DIR/scripts/preflight.sh" \
  "$DEPLOY_DIR/scripts/deploy-release.sh" \
  "$DEPLOY_DIR/scripts/rollback-release.sh" \
  "$SCRIPT_DIR/preflight-config-test.sh" \
  "$SCRIPT_DIR/validate-nginx-bootstrap.sh" \
  "$SCRIPT_DIR/validate-nginx-routing.sh" \
  "$SCRIPT_DIR/validate-deploy.sh"

cors_policy="$DEPLOY_DIR/minio/relay-browser-cors.xml.example"
[[ -f $cors_policy ]] || fail "MinIO browser CORS policy example is missing"
grep -Fq '<CORSConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' \
  "$cors_policy" || fail "MinIO CORS policy must use the S3 CORS XML schema"
cors_origin_count=$(grep -Fc '<AllowedOrigin>https://relay.zaftech.co</AllowedOrigin>' "$cors_policy" || true)
allowed_origin_count=$(grep -Fc '<AllowedOrigin>' "$cors_policy" || true)
[[ $cors_origin_count == 2 && $allowed_origin_count == 2 ]] ||
  fail "MinIO CORS policy must use only the exact Relay web origin"
for method in PUT GET HEAD; do
  grep -Fq "<AllowedMethod>$method</AllowedMethod>" "$cors_policy" ||
    fail "MinIO CORS policy is missing $method"
done
allowed_method_count=$(grep -Fc '<AllowedMethod>' "$cors_policy" || true)
[[ $allowed_method_count == 3 ]] ||
  fail "MinIO CORS policy contains an undocumented method"
cors_headers=(
  content-type
  content-md5
  if-none-match
  x-amz-checksum-sha256
  x-amz-meta-relay-upload-id
  x-amz-meta-relay-sha256
)
for header in "${cors_headers[@]}"; do
  count=$(grep -Fc "<AllowedHeader>$header</AllowedHeader>" "$cors_policy" || true)
  [[ $count == 1 ]] || fail "MinIO CORS policy must allow $header exactly once"
done
allowed_header_count=$(grep -Fc '<AllowedHeader>' "$cors_policy" || true)
[[ $allowed_header_count == ${#cors_headers[@]} ]] ||
  fail "MinIO CORS policy contains an undocumented allowed header"
if grep -Eqi '<Allowed(Header|Origin)>\*|<AllowedHeader>(authorization|content-length)</AllowedHeader>|<AllowedMethod>OPTIONS</AllowedMethod>' \
  "$cors_policy"; then
  fail "MinIO CORS policy must not use wildcards, Authorization, Content-Length, or OPTIONS"
fi

grep -Fq 'APP_ENV: "production"' "$DEPLOY_DIR/compose.prod.yaml" ||
  fail "Compose must force APP_ENV=production"
if grep -Eq '^[[:space:]]*env_file:' "$DEPLOY_DIR/compose.prod.yaml"; then
  fail "Compose must explicitly map settings instead of injecting the shared .env"
fi
grep -Fq 'CMD ["/app/relay-entrypoint", "healthcheck"]' \
  "$DEPLOY_DIR/../Dockerfile" ||
  fail "backend image must run the compiled role-aware healthcheck"

log_format="$DEPLOY_DIR/nginx/relay-log-format.conf"
proxy_headers="$DEPLOY_DIR/nginx/relay-proxy-headers.conf"
routes="$DEPLOY_DIR/nginx/relay-routes.conf"
if grep -Fq "\$http_referer" "$log_format"; then
  fail "Relay access logs must not record Referer"
fi
grep -Fq 'proxy_set_header Referer "";' "$proxy_headers" ||
  fail "Relay proxy headers must clear Referer"
grep -Fq 'access_log off;' "$routes" ||
  fail "share-token routes must disable access logging"
grep -Fq 'add_header Referrer-Policy "no-referrer" always;' "$routes" ||
  fail "share-token responses must set a no-referrer policy"
grep -Fq 'resolver 127.0.0.11' "$routes" ||
  fail "Relay routes must use Docker runtime DNS resolution"
grep -Fq "set \$relay_api_upstream relay-api:8000;" "$routes" ||
  fail "Relay API upstream must be a fixed configuration variable"
grep -Fq "set \$relay_web_upstream relay-web:8080;" "$routes" ||
  fail "Relay web upstream must be a fixed configuration variable"
if grep -Eq 'proxy_pass http://relay-(api|web):' "$routes"; then
  fail "literal Relay proxy_pass hosts make first-deploy nginx -t unsafe"
fi

grep -Fq "relay-backend}@\${BACKEND_DIGEST:" "$DEPLOY_DIR/compose.prod.yaml" ||
  fail "backend image must remain digest-pinned"
grep -Fq "relay-web}@\${WEB_DIGEST:" "$DEPLOY_DIR/compose.prod.yaml" ||
  fail "web image must remain digest-pinned"

temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT
release_file="$temp_dir/release.env"
while IFS= read -r line || [[ -n $line ]]; do
  case $line in
    RELEASE_VERSION=) line=RELEASE_VERSION=1.2.3 ;;
    RELEASE_TAG=) line=RELEASE_TAG=v1.2.3 ;;
    RELEASE_GIT_SHA=) line=RELEASE_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ;;
    BACKEND_DIGEST=) line=BACKEND_DIGEST=sha256:1111111111111111111111111111111111111111111111111111111111111111 ;;
    WEB_DIGEST=) line=WEB_DIGEST=sha256:2222222222222222222222222222222222222222222222222222222222222222 ;;
    DATABASE_URL=) line=DATABASE_URL=postgres://relay_app:test-only@postgresql:5432/relay ;;
    MIGRATOR_DATABASE_URL=) line=MIGRATOR_DATABASE_URL=postgres://relay_migrator:test-only@postgresql:5432/relay ;;
    REDIS_URL=) line=REDIS_URL=redis://relay:test-only@redis:6379 ;;
    SHARE_TOKEN_KEYS=) line='SHARE_TOKEN_KEYS={"1":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' ;;
    *=) line="${line}test-only-configuration-value-000000000000" ;;
  esac
  printf '%s\n' "$line"
done < "$DEPLOY_DIR/.env.example" > "$release_file"
chmod 600 "$release_file"

compose=(
  docker compose
  --project-directory "$DEPLOY_DIR"
  --project-name relay-deploy-validation
  --env-file "$release_file"
  -f "$DEPLOY_DIR/compose.prod.yaml"
)
rendered_compose="$temp_dir/compose.json"
"${compose[@]}" config --format json > "$rendered_compose"
grep -Fq '"services"' "$rendered_compose" ||
  fail "synthetic Compose JSON did not render services"
require_command jq
jq -e '
  (.networks | keys) == ["database", "proxy"] and
  .networks.database.name == "postgresql-db-n8n" and
  .networks.proxy.name == "proxy-net" and
  all(.networks[]; .external == true) and
  (.services.api.networks | keys) == ["database", "proxy"] and
  (.services.worker.networks | keys) == ["database", "proxy"] and
  (.services.migrate.networks | keys) == ["database"] and
  (.services.web.networks | keys) == ["proxy"] and
  all(.services[]; (.ports // [] | length) == 0) and
  .services.api.environment.RELAY_PROCESS_ROLE == "api" and
  .services.worker.environment.RELAY_PROCESS_ROLE == "worker" and
  (.services.migrate.environment.RELAY_PROCESS_ROLE == null) and
  (.services.migrate.healthcheck.disable == true) and
  (.services.migrate.profiles == null) and
  .services.api.depends_on.migrate.condition == "service_completed_successfully" and
  .services.worker.depends_on.migrate.condition == "service_completed_successfully" and
  .services.web.depends_on.api.condition == "service_healthy"
' "$rendered_compose" >/dev/null ||
  fail "Compose must use the existing networks and scope each process correctly"

(
  source "$DEPLOY_DIR/scripts/lib.sh"
  RELAY_ENV_FILE=$release_file
  load_release_env "$release_file"
  nginx_networks='{"proxy-net":{"IPAddress":"172.18.0.2","GlobalIPv6Address":""}}'
  validate_rendered_service_environments "$(cat "$rendered_compose")" "$nginx_networks"
  for mutation in \
    '.services.api.environment.AZURE_API_KEY="test-only-misplaced"' \
    '.services.worker.environment.BETTER_AUTH_SECRET="test-only-misplaced"' \
    '.services.migrate.environment.GOOGLE_CLIENT_SECRET="test-only-misplaced"' \
    '.services.api.environment.DATABASE_URL="postgres://relay_migrator:test-only@postgresql:5432/relay"' \
    '.services.worker.environment.OTEL_DENO="false"' \
    '.services.api.environment.AUTH_TRUSTED_PROXY_CIDRS="172.18.0.0/16"' \
    '.services.worker.environment.UNDOCUMENTED_SECRET="test-only-misplaced"'; do
    changed=$(jq "$mutation" "$rendered_compose")
    if validate_rendered_service_environments "$changed" "$nginx_networks" >/dev/null 2>&1; then
      fail "rendered configuration accepted a misplaced secret or broad proxy trust"
    fi
  done
  RELAY_CURRENT_RELEASE_LINK="$temp_dir/current-release.env"
  select_current_release "$release_file"
  selector=$(readlink "$RELAY_CURRENT_RELEASE_LINK")
  [[ $selector != "$release_file" && $(wc -l < "$selector") == 8 ]] ||
    fail "deploying from .env must archive only release selectors"
  if grep -Eq 'SECRET|DATABASE_URL|AZURE_API_KEY|GOOGLE_CLIENT|GITHUB_CLIENT|SHARE_TOKEN' "$selector"; then
    fail "release history must not contain shared secrets"
  fi
  BACKEND_DIGEST=sha256:3333333333333333333333333333333333333333333333333333333333333333
  if (select_current_release "$release_file") >/dev/null 2>&1; then
    fail "an existing release selector must remain immutable"
  fi
)
images_file="$temp_dir/images"
"${compose[@]}" config --images > "$images_file"

expected_backend='zaftec/relay-backend@sha256:1111111111111111111111111111111111111111111111111111111111111111'
expected_web='zaftec/relay-web@sha256:2222222222222222222222222222222222222222222222222222222222222222'
saw_backend=false
saw_web=false
while IFS= read -r image; do
  case $image in
    "$expected_backend") saw_backend=true ;;
    "$expected_web") saw_web=true ;;
    *) fail "rendered Compose contains an unexpected or unpinned image" ;;
  esac
done < "$images_file"
[[ $saw_backend == true && $saw_web == true ]] ||
  fail "rendered Compose is missing a pinned release image"

if command -v jq >/dev/null 2>&1; then
  bash "$SCRIPT_DIR/preflight-config-test.sh"
else
  echo "jq unavailable; skipped executable preflight-config rejection tests." >&2
fi

if [[ -n ${NGINX_TEST_IMAGE:-} ]]; then
  bash "$SCRIPT_DIR/validate-nginx-bootstrap.sh" "$NGINX_TEST_IMAGE"
else
  echo "NGINX_TEST_IMAGE unset; skipped containerized bootstrap nginx -t." >&2
fi

if [[ -n ${NGINX_TEST_IMAGE:-} && -n ${PYTHON_TEST_IMAGE:-} ]]; then
  bash "$SCRIPT_DIR/validate-nginx-routing.sh" \
    "$NGINX_TEST_IMAGE" "$PYTHON_TEST_IMAGE"
else
  echo "Pinned NGINX_TEST_IMAGE/PYTHON_TEST_IMAGE not both set; skipped routing integration." >&2
fi

echo "Deploy validation passed: Bash, env roles, Nginx privacy, and digest-pinned Compose."
