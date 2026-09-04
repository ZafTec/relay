#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=../scripts/lib.sh
source "$SCRIPT_DIR/../scripts/lib.sh"

require_command jq
require_command mktemp
require_command sed

temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT

api_env="$temp_dir/api.env"
worker_env="$temp_dir/worker.env"
migrate_env="$temp_dir/migrate.env"
share_key=$(printf 'A%.0s' {1..43})
RELAY_PUBLIC_URL=https://relay.example.test

cat > "$api_env" <<EOF
APP_ENV=production
DATABASE_URL=postgres://api:test-only@postgres:5432/relay
REDIS_URL=redis://:test-only@redis:6379
DATABASE_POOL_MAX=10
DATABASE_CONNECT_TIMEOUT_MS=5000
DATABASE_STATEMENT_TIMEOUT_MS=30000
REDIS_CONNECT_TIMEOUT_MS=5000
BETTER_AUTH_URL=https://relay.example.test
BETTER_AUTH_SECRET=test-only-better-auth-secret-000000000000
AUTH_TRUSTED_ORIGINS=https://relay.example.test
AUTH_TRUSTED_PROXY_CIDRS=172.31.0.10/32
GOOGLE_CLIENT_ID=test-only-google-client
GOOGLE_CLIENT_SECRET=test-only-google-secret
GITHUB_CLIENT_ID=test-only-github-client
GITHUB_CLIENT_SECRET=test-only-github-secret
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=https://objects.example.test
S3_REGION=us-east-1
S3_BUCKET=relay-artifacts
S3_ACCESS_KEY_ID=test-only-api-access
S3_SECRET_ACCESS_KEY=test-only-api-secret
S3_FORCE_PATH_STYLE=true
S3_BUCKET_VERSIONING=enabled
S3_REQUEST_TIMEOUT_MS=30000
ARTIFACT_WORKSPACE_MAX_BYTES=10737418240
ARTIFACT_MAX_UPLOAD_BYTES=104857600
ARTIFACT_UPLOAD_TTL_SECONDS=900
ARTIFACT_DOWNLOAD_TTL_SECONDS=300
ARTIFACT_PURGE_DELAY_SECONDS=604800
ARTIFACT_CLEANUP_LEASE_SECONDS=60
ARTIFACT_MAINTENANCE_INTERVAL_MS=30000
ARTIFACT_MAINTENANCE_BATCH_SIZE=100
SHARE_TOKEN_ACTIVE_VERSION=1
SHARE_TOKEN_KEYS={"1":"$share_key"}
EOF

cat > "$worker_env" <<'EOF'
APP_ENV=production
DATABASE_URL=postgres://worker:test-only@postgres:5432/relay
REDIS_URL=redis://:test-only@redis:6379
DATABASE_POOL_MAX=10
DATABASE_CONNECT_TIMEOUT_MS=5000
DATABASE_STATEMENT_TIMEOUT_MS=30000
REDIS_CONNECT_TIMEOUT_MS=5000
S3_ENDPOINT=http://minio:9000
S3_REGION=us-east-1
S3_BUCKET=relay-artifacts
S3_ACCESS_KEY_ID=test-only-worker-access
S3_SECRET_ACCESS_KEY=test-only-worker-secret
S3_FORCE_PATH_STYLE=true
S3_BUCKET_VERSIONING=enabled
S3_REQUEST_TIMEOUT_MS=30000
ARTIFACT_WORKSPACE_MAX_BYTES=10737418240
ARTIFACT_MAX_UPLOAD_BYTES=104857600
ARTIFACT_UPLOAD_TTL_SECONDS=900
ARTIFACT_DOWNLOAD_TTL_SECONDS=300
ARTIFACT_PURGE_DELAY_SECONDS=604800
ARTIFACT_CLEANUP_LEASE_SECONDS=60
ARTIFACT_MAINTENANCE_INTERVAL_MS=30000
ARTIFACT_MAINTENANCE_BATCH_SIZE=100
AZURE_API_KEY=test-only-azure-key
EOF

cat > "$migrate_env" <<'EOF'
DATABASE_URL=postgres://migrator:test-only@postgres:5432/relay
DATABASE_POOL_MAX=2
DATABASE_CONNECT_TIMEOUT_MS=5000
DATABASE_STATEMENT_TIMEOUT_MS=600000
EOF

validate_files() {
  API_ENV_FILE=$1
  WORKER_ENV_FILE=$2
  MIGRATE_ENV_FILE=$3
  validate_service_environment_files
}

expect_failure() {
  local description=$1
  shift
  if ("$@") >/dev/null 2>&1; then
    echo "preflight config test failed: expected rejection for $description" >&2
    exit 1
  fi
}

validate_files "$api_env" "$worker_env" "$migrate_env"
nginx_networks='{"relay-edge":{"IPAddress":"172.31.0.10","GlobalIPv6Address":""}}'
validate_trusted_proxy_cidrs "$api_env" "$nginx_networks" relay-edge

SERVICE_ENVIRONMENTS_JSON=$(jq -n \
  --rawfile api "$api_env" \
  --rawfile worker "$worker_env" \
  --rawfile migrate "$migrate_env" '
    def environment($source):
      reduce (
        $source | split("\n")[] |
        select(length > 0) |
        capture("^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$")
      ) as $entry ({}; .[$entry.key] = $entry.value);
    {services: {
      api: {environment: environment($api)},
      worker: {environment: environment($worker)},
      migrate: {environment: environment($migrate)}
    }}
  ')
validate_files "$api_env" "$worker_env" "$migrate_env"
validate_trusted_proxy_cidrs "$api_env" "$nginx_networks" relay-edge
SERVICE_ENVIRONMENTS_JSON=

quoted_env="$temp_dir/quoted.env"
printf '%s\n' 'APP_ENV="production"' > "$quoted_env"
API_ENV_FILE=$quoted_env
SERVICE_ENVIRONMENTS_JSON='{"services":{"api":{"environment":{"APP_ENV":"production"}}}}'
read_service_env_value "$quoted_env" APP_ENV
[[ $SERVICE_ENV_VALUE == production ]] ||
  fail "rendered Compose values must override raw env-file quoting"
SERVICE_ENVIRONMENTS_JSON=
API_ENV_FILE=$api_env

missing_s3="$temp_dir/api-missing-s3.env"
sed '/^S3_ENDPOINT=/d' "$api_env" > "$missing_s3"
expect_failure "missing API S3_ENDPOINT" \
  validate_files "$missing_s3" "$worker_env" "$migrate_env"

wrong_environment="$temp_dir/api-development.env"
sed 's/^APP_ENV=production$/APP_ENV=development/' "$api_env" > "$wrong_environment"
expect_failure "non-production API APP_ENV" \
  validate_files "$wrong_environment" "$worker_env" "$migrate_env"

api_with_azure="$temp_dir/api-with-azure.env"
cat "$api_env" > "$api_with_azure"
printf '%s\n' 'AZURE_API_KEY=test-only-misplaced-key' >> "$api_with_azure"
expect_failure "API-scoped AZURE_API_KEY" \
  validate_files "$api_with_azure" "$worker_env" "$migrate_env"

api_with_unknown_secret="$temp_dir/api-with-unknown-secret.env"
cat "$api_env" > "$api_with_unknown_secret"
printf '%s\n' 'UNREVIEWED_SECRET=test-only' >> "$api_with_unknown_secret"
expect_failure "undocumented API secret" \
  validate_files "$api_with_unknown_secret" "$worker_env" "$migrate_env"

worker_with_keyring="$temp_dir/worker-with-keyring.env"
cat "$worker_env" > "$worker_with_keyring"
printf '%s\n' "SHARE_TOKEN_KEYS={\"1\":\"$share_key\"}" >> "$worker_with_keyring"
expect_failure "worker-scoped SHARE_TOKEN_KEYS" \
  validate_files "$api_env" "$worker_with_keyring" "$migrate_env"

worker_with_auth="$temp_dir/worker-with-auth.env"
cat "$worker_env" > "$worker_with_auth"
printf '%s\n' 'BETTER_AUTH_SECRET=test-only-misplaced-secret' >> "$worker_with_auth"
expect_failure "worker-scoped Better Auth secret" \
  validate_files "$api_env" "$worker_with_auth" "$migrate_env"

migrate_with_secrets="$temp_dir/migrate-with-secrets.env"
for misplaced_secret in \
  'AZURE_API_KEY=test-only-misplaced-key' \
  'SHARE_TOKEN_KEYS={"1":"test-only-misplaced-key"}' \
  'GOOGLE_CLIENT_SECRET=test-only-misplaced-secret'; do
  cat "$migrate_env" > "$migrate_with_secrets"
  printf '%s\n' "$misplaced_secret" >> "$migrate_with_secrets"
  expect_failure "migrate-scoped provider or share secret" \
    validate_files "$api_env" "$worker_env" "$migrate_with_secrets"
done

mismatched_policy="$temp_dir/worker-mismatched-policy.env"
sed 's/^ARTIFACT_PURGE_DELAY_SECONDS=.*/ARTIFACT_PURGE_DELAY_SECONDS=3600/' \
  "$worker_env" > "$mismatched_policy"
expect_failure "mismatched API/worker artifact policy" \
  validate_files "$api_env" "$mismatched_policy" "$migrate_env"

invalid_keyring="$temp_dir/api-invalid-keyring.env"
sed 's/^SHARE_TOKEN_KEYS=.*/SHARE_TOKEN_KEYS={"2":"short"}/' \
  "$api_env" > "$invalid_keyring"
expect_failure "invalid API share-token keyring" \
  validate_files "$invalid_keyring" "$worker_env" "$migrate_env"

invalid_origins="$temp_dir/api-invalid-origins.env"
for invalid_origin in \
  'http://relay.example.test' \
  'https://*.example.test' \
  'https://relay.example.test/path'; do
  sed "s#^AUTH_TRUSTED_ORIGINS=.*#AUTH_TRUSTED_ORIGINS=$invalid_origin#" \
    "$api_env" > "$invalid_origins"
  expect_failure "non-origin AUTH_TRUSTED_ORIGINS entry" \
    validate_files "$invalid_origins" "$worker_env" "$migrate_env"
done
sed 's#^AUTH_TRUSTED_ORIGINS=.*#AUTH_TRUSTED_ORIGINS=https://other.example.test#' \
  "$api_env" > "$invalid_origins"
expect_failure "trusted origins missing BETTER_AUTH_URL" \
  validate_files "$invalid_origins" "$worker_env" "$migrate_env"
sed 's#^AUTH_TRUSTED_ORIGINS=.*#AUTH_TRUSTED_ORIGINS=https://relay.example.test,https://relay.example.test#' \
  "$api_env" > "$invalid_origins"
expect_failure "duplicate trusted origin" \
  validate_files "$invalid_origins" "$worker_env" "$migrate_env"

mismatched_auth_url="$temp_dir/api-mismatched-auth-url.env"
sed 's#^BETTER_AUTH_URL=.*#BETTER_AUTH_URL=https://auth.example.test#' \
  "$api_env" > "$mismatched_auth_url"
expect_failure "BETTER_AUTH_URL differing from RELAY_PUBLIC_URL" \
  validate_files "$mismatched_auth_url" "$worker_env" "$migrate_env"

broad_proxy="$temp_dir/api-broad-proxy.env"
sed 's#^AUTH_TRUSTED_PROXY_CIDRS=.*#AUTH_TRUSTED_PROXY_CIDRS=172.31.0.0/24#' \
  "$api_env" > "$broad_proxy"
expect_failure "broad AUTH_TRUSTED_PROXY_CIDRS" \
  validate_trusted_proxy_cidrs "$broad_proxy" "$nginx_networks" relay-edge

RELEASE_VERSION=1.2.3
RELEASE_GIT_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
runnable_digest=sha256:1111111111111111111111111111111111111111111111111111111111111111
attestation_digest=sha256:2222222222222222222222222222222222222222222222222222222222222222
config_digest=sha256:3333333333333333333333333333333333333333333333333333333333333333
layer_digest=sha256:4444444444444444444444444444444444444444444444444444444444444444

attested_manifest=$(cat <<EOF
{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"$runnable_digest","size":1234,"platform":{"os":"linux","architecture":"amd64"}},{"mediaType":"application/vnd.oci.image.manifest.v1+json","digest":"$attestation_digest","size":567,"annotations":{"vnd.docker.reference.type":"attestation-manifest","vnd.docker.reference.digest":"$runnable_digest"},"platform":{"os":"unknown","architecture":"unknown"}}]}
EOF
)
direct_image=$(cat <<EOF
{"os":"linux","architecture":"amd64","config":{"Labels":{"org.opencontainers.image.version":"$RELEASE_VERSION","org.opencontainers.image.revision":"$RELEASE_GIT_SHA"}}}
EOF
)
validate_remote_image_metadata test-attested "$attested_manifest" "$direct_image"

direct_manifest=$(cat <<EOF
{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","digest":"$config_digest","size":456},"layers":[{"mediaType":"application/vnd.oci.image.layer.v1.tar+gzip","digest":"$layer_digest","size":789}]}
EOF
)
mapped_image=$(cat <<EOF
{"linux/amd64":$direct_image}
EOF
)
validate_remote_image_metadata test-direct "$direct_manifest" "$mapped_image"

unlinked_attestation=$(jq \
  'del(.manifests[1].annotations["vnd.docker.reference.type"])' \
  <<<"$attested_manifest")
expect_failure "unmarked unknown/unknown image descriptor" \
  validate_remote_image_metadata test-unmarked "$unlinked_attestation" "$direct_image"

unexpected_platform=$(jq \
  --arg digest "$config_digest" \
  '.manifests += [{
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: $digest,
    size: 123,
    platform: {os: "linux", architecture: "arm64"}
  }]' <<<"$attested_manifest")
expect_failure "unexpected runnable image descriptor" \
  validate_remote_image_metadata test-platform "$unexpected_platform" "$direct_image"

wrong_labels=$(jq \
  '.config.Labels["org.opencontainers.image.version"] = "9.9.9"' \
  <<<"$direct_image")
expect_failure "mismatched release image labels" \
  validate_remote_image_metadata test-labels "$attested_manifest" "$wrong_labels"

echo "Preflight config and image metadata tests passed."
