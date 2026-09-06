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

api_env="$DEPLOY_DIR/env/api.env.example"
worker_env="$DEPLOY_DIR/env/worker.env.example"
migrate_env="$DEPLOY_DIR/env/migrate.env.example"

common_runtime_keys=(
  APP_ENV DATABASE_URL REDIS_URL DATABASE_POOL_MAX
  DATABASE_CONNECT_TIMEOUT_MS DATABASE_STATEMENT_TIMEOUT_MS
  REDIS_CONNECT_TIMEOUT_MS S3_ENDPOINT S3_REGION S3_BUCKET
  S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE
  S3_BUCKET_VERSIONING S3_REQUEST_TIMEOUT_MS
  ARTIFACT_WORKSPACE_MAX_BYTES ARTIFACT_MAX_UPLOAD_BYTES
  ARTIFACT_UPLOAD_TTL_SECONDS ARTIFACT_DOWNLOAD_TTL_SECONDS
  ARTIFACT_PURGE_DELAY_SECONDS ARTIFACT_CLEANUP_LEASE_SECONDS
  ARTIFACT_MAINTENANCE_INTERVAL_MS ARTIFACT_MAINTENANCE_BATCH_SIZE
)
api_only_keys=(
  BETTER_AUTH_URL BETTER_AUTH_SECRET AUTH_TRUSTED_ORIGINS
  AUTH_TRUSTED_PROXY_CIDRS GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET
  GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET S3_PUBLIC_ENDPOINT
  SHARE_TOKEN_ACTIVE_VERSION SHARE_TOKEN_KEYS
)
worker_only_keys=(AZURE_API_KEY)
migrate_keys=(
  DATABASE_URL DATABASE_POOL_MAX DATABASE_CONNECT_TIMEOUT_MS
  DATABASE_STATEMENT_TIMEOUT_MS
)

for key in "${common_runtime_keys[@]}" "${api_only_keys[@]}"; do
  assert_single_env_entry "$api_env" "$key"
done
for key in "${common_runtime_keys[@]}" "${worker_only_keys[@]}"; do
  assert_single_env_entry "$worker_env" "$key"
done
for key in "${migrate_keys[@]}"; do
  assert_single_env_entry "$migrate_env" "$key"
done

assert_no_env_prefix "$api_env" AZURE_
for prefix in BETTER_AUTH_ AUTH_ GOOGLE_ GITHUB_ SHARE_TOKEN_; do
  assert_no_env_prefix "$worker_env" "$prefix"
done
for prefix in AZURE_ SHARE_TOKEN_ GOOGLE_ GITHUB_ BETTER_AUTH_ AUTH_; do
  assert_no_env_prefix "$migrate_env" "$prefix"
done
if grep -Eq '^S3_PUBLIC_ENDPOINT=' -- "$worker_env"; then
  fail "$worker_env must not contain S3_PUBLIC_ENDPOINT"
fi

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

grep -Fxq 'APP_ENV=production' "$api_env" || fail "api example must set APP_ENV=production"
grep -Fxq 'APP_ENV=production' "$worker_env" || fail "worker example must set APP_ENV=production"
grep -Fq 'APP_ENV: "production"' "$DEPLOY_DIR/compose.prod.yaml" ||
  fail "Compose must force APP_ENV=production"
api_role_entries=$(grep -Fc 'RELAY_PROCESS_ROLE: api' "$DEPLOY_DIR/compose.prod.yaml" || true)
worker_role_entries=$(grep -Fc 'RELAY_PROCESS_ROLE: worker' "$DEPLOY_DIR/compose.prod.yaml" || true)
[[ $api_role_entries == 1 ]] ||
  fail "Compose must set exactly one API RELAY_PROCESS_ROLE"
[[ $worker_role_entries == 1 ]] ||
  fail "Compose must set exactly one worker RELAY_PROCESS_ROLE"
for env_file in "$api_env" "$worker_env" "$migrate_env"; do
  if grep -Eq '^RELAY_PROCESS_ROLE=' -- "$env_file"; then
    fail "$env_file must leave RELAY_PROCESS_ROLE under Compose control"
  fi
done
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
cat > "$release_file" <<'EOF'
RELEASE_VERSION=1.2.3
RELEASE_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
DOCKERHUB_NAMESPACE=zaftec
DOCKERHUB_BACKEND_REPOSITORY=relay-backend
DOCKERHUB_WEB_REPOSITORY=relay-web
BACKEND_DIGEST=sha256:1111111111111111111111111111111111111111111111111111111111111111
WEB_DIGEST=sha256:2222222222222222222222222222222222222222222222222222222222222222
API_ENV_FILE=./env/api.env.example
WORKER_ENV_FILE=./env/worker.env.example
MIGRATE_ENV_FILE=./env/migrate.env.example
RELAY_EDGE_NETWORK=relay-edge-validation
RELAY_DATA_NETWORK=relay-data-validation
RELAY_TELEMETRY_NETWORK=relay-telemetry-validation
EOF

compose=(
  docker compose
  --project-directory "$DEPLOY_DIR"
  --project-name relay-deploy-validation
  --env-file "$release_file"
  -f "$DEPLOY_DIR/compose.prod.yaml"
  --profile tools
)
rendered_compose="$temp_dir/compose.json"
"${compose[@]}" config --format json > "$rendered_compose"
grep -Fq '"services"' "$rendered_compose" ||
  fail "synthetic Compose JSON did not render services"
if command -v jq >/dev/null 2>&1; then
  jq -e '
    .services.api.environment.RELAY_PROCESS_ROLE == "api" and
    .services.worker.environment.RELAY_PROCESS_ROLE == "worker" and
    (.services.migrate.environment.RELAY_PROCESS_ROLE == null) and
    (.services.migrate.healthcheck.disable == true)
  ' "$rendered_compose" >/dev/null ||
    fail "rendered Compose must scope healthcheck roles to API/worker and disable migrate healthchecking"
else
  echo "jq unavailable; skipped rendered healthcheck role assertions." >&2
fi
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
