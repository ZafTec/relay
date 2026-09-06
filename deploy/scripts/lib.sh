#!/usr/bin/env bash

fail() {
  echo "release operation failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

read_required_env() {
  local file=$1
  local key=$2
  local -a matches=()
  mapfile -t matches < <(grep -E "^${key}=" -- "$file" || true)
  if ((${#matches[@]} != 1)); then
    fail "$file must contain exactly one $key entry"
  fi
  local value=${matches[0]#*=}
  [[ -n $value && $value != *$'\r'* ]] || fail "$key must be non-empty and use LF line endings"
  printf -v "$key" '%s' "$value"
}

SERVICE_ENV_VALUE=
SERVICE_ENVIRONMENTS_JSON=

read_service_env_value() {
  local file=$1
  local key=$2
  local -a matches=()
  mapfile -t matches < <(grep -E "^${key}=" -- "$file" || true)
  if ((${#matches[@]} != 1)); then
    fail "$file must contain exactly one $key entry"
  fi

  local value=${matches[0]#*=}
  [[ $value != *$'\r'* ]] || fail "$file must use LF line endings for $key"

  if [[ -n ${SERVICE_ENVIRONMENTS_JSON:-} ]]; then
    local service
    case $file in
      "$API_ENV_FILE") service=api ;;
      "$WORKER_ENV_FILE") service=worker ;;
      "$MIGRATE_ENV_FILE") service=migrate ;;
      *) fail "cannot map service environment file to rendered Compose: $file" ;;
    esac

    value=$(jq -er --arg service "$service" --arg key "$key" '
      .services[$service].environment as $environment |
      if ($environment | type) != "object" then
        error("missing environment")
      elif ($environment | has($key) | not) then
        error("missing key")
      elif ($environment[$key] | type) != "string" then
        error("non-string value")
      elif ($environment[$key] | test("[\\r\\n]")) then
        error("multiline value")
      else
        $environment[$key]
      end
    ' <<<"$SERVICE_ENVIRONMENTS_JSON" 2>/dev/null) ||
      fail "rendered Compose must contain one single-line $key value for $service"
  fi

  SERVICE_ENV_VALUE=$value
}

require_nonempty_service_env() {
  local file=$1
  shift
  local key
  for key in "$@"; do
    read_service_env_value "$file" "$key"
    [[ $SERVICE_ENV_VALUE =~ [^[:space:]] ]] ||
      fail "$file must contain a non-empty $key value"
  done
}

require_exact_service_env() {
  local file=$1
  local key=$2
  local expected=$3
  read_service_env_value "$file" "$key"
  [[ $SERVICE_ENV_VALUE == "$expected" ]] ||
    fail "$file requires $key=$expected"
}

require_absent_service_env() {
  local file=$1
  shift
  local key
  for key in "$@"; do
    if grep -Eq "^${key}=" -- "$file"; then
      fail "$file must not contain role-inappropriate $key"
    fi
  done
}

require_no_service_env_prefix() {
  local file=$1
  local prefix=$2
  if grep -Eq "^${prefix}[A-Z0-9_]*=" -- "$file"; then
    fail "$file must not contain role-inappropriate ${prefix}* variables"
  fi
}

require_only_service_env_keys() {
  local file=$1
  shift
  local line key allowed_key allowed line_number=0
  while IFS= read -r line || [[ -n $line ]]; do
    ((line_number += 1))
    [[ $line != *$'\r'* ]] || fail "$file must use LF line endings"
    [[ $line =~ ^[[:space:]]*$ || $line =~ ^[[:space:]]*# ]] && continue
    [[ $line =~ ^([A-Z][A-Z0-9_]*)= ]] ||
      fail "$file has an invalid entry at line $line_number"
    key=${BASH_REMATCH[1]}
    allowed=false
    for allowed_key in "$@"; do
      if [[ $key == "$allowed_key" ]]; then
        allowed=true
        break
      fi
    done
    [[ $allowed == true ]] ||
      fail "$file contains undocumented or role-inappropriate variable $key"
  done < "$file"
}

positive_decimal_lte() {
  local value=$1
  local maximum=$2
  local LC_ALL=C
  [[ $value =~ ^[1-9][0-9]*$ ]] || return 1
  ((${#value} < ${#maximum})) && return 0
  ((${#value} > ${#maximum})) && return 1
  [[ $value < $maximum || $value == "$maximum" ]]
}

require_bounded_service_env_integer() {
  local file=$1
  local key=$2
  local maximum=$3
  read_service_env_value "$file" "$key"
  positive_decimal_lte "$SERVICE_ENV_VALUE" "$maximum" ||
    fail "$file requires $key to be a positive integer no greater than $maximum"
}

require_service_env_min_length() {
  local file=$1
  local key=$2
  local minimum=$3
  read_service_env_value "$file" "$key"
  ((${#SERVICE_ENV_VALUE} >= minimum)) ||
    fail "$file requires $key to contain at least $minimum characters"
}

require_service_env_max_length() {
  local file=$1
  local key=$2
  local maximum=$3
  read_service_env_value "$file" "$key"
  ((${#SERVICE_ENV_VALUE} <= maximum)) ||
    fail "$file requires $key to contain no more than $maximum characters"
}

require_service_env_url() {
  local file=$1
  local key=$2
  local kind=$3
  read_service_env_value "$file" "$key"
  local value=$SERVICE_ENV_VALUE
  [[ $value != *[[:space:]]* ]] || fail "$file contains an invalid $key URL"

  case $kind in
    https)
      [[ $value == https://* ]] || fail "$file requires $key to use HTTPS"
      ;;
    http)
      [[ $value == http://* || $value == https://* ]] ||
        fail "$file requires $key to use HTTP or HTTPS"
      ;;
    postgres)
      [[ $value == postgres://* || $value == postgresql://* ]] ||
        fail "$file requires $key to use PostgreSQL"
      ;;
    redis)
      [[ $value == redis://* || $value == rediss://* ]] ||
        fail "$file requires $key to use Redis"
      ;;
    *)
      fail "unsupported URL validation kind: $kind"
      ;;
  esac

  local authority=${value#*://}
  authority=${authority%%/*}
  [[ -n $authority ]] || fail "$file contains an invalid $key URL"
  if [[ $kind == http || $kind == https ]]; then
    [[ $value != *\?* && $value != *\#* ]] ||
      fail "$file must not put a query or fragment in $key"
    [[ $authority != *@* ]] || fail "$file must not embed credentials in $key"
  fi
}

validate_https_origin_value() {
  local name=$1
  local origin=$2
  [[ $origin == https://* ]] ||
    fail "$name must be an HTTPS origin without credentials, path, query, or fragment"

  local authority=${origin#https://}
  [[ -n $authority && $authority != *[[:space:]/?#@]* ]] ||
    fail "$name must be an HTTPS origin without credentials, path, query, or fragment"
  local host=$authority
  local port=
  if [[ $authority == *:* ]]; then
    [[ $authority != *:*:* ]] || fail "$name must use a DNS hostname"
    host=${authority%:*}
    port=${authority##*:}
    positive_decimal_lte "$port" 65535 ||
      fail "$name contains an invalid port"
  fi

  ((${#host} <= 253)) || fail "$name contains an invalid DNS hostname"
  [[ $host != .* && $host != *. && $host != *..* && $host =~ [A-Za-z] ]] ||
    fail "$name contains an invalid DNS hostname"
  local -a labels=()
  IFS='.' read -r -a labels <<<"$host"
  ((${#labels[@]} >= 2)) || fail "$name must use a fully qualified DNS hostname"
  local label
  for label in "${labels[@]}"; do
    [[ $label =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] ||
      fail "$name contains an invalid DNS hostname"
  done
}

validate_auth_service_env() {
  local file=$1
  read_service_env_value "$file" BETTER_AUTH_URL
  local auth_url=$SERVICE_ENV_VALUE
  validate_https_origin_value BETTER_AUTH_URL "$auth_url"
  [[ $auth_url == "$RELAY_PUBLIC_URL" ]] ||
    fail "BETTER_AUTH_URL must equal RELAY_PUBLIC_URL"

  read_service_env_value "$file" AUTH_TRUSTED_ORIGINS
  local configured=$SERVICE_ENV_VALUE
  [[ $configured != ,* && $configured != *, && $configured != *,,* ]] ||
    fail "AUTH_TRUSTED_ORIGINS must be a comma-separated HTTPS origin allowlist"

  local -a origins=()
  local -A seen=()
  IFS=',' read -r -a origins <<<"$configured"
  local origin leading_trimmed found_auth_url=false
  for origin in "${origins[@]}"; do
    leading_trimmed=${origin#"${origin%%[![:space:]]*}"}
    origin=${leading_trimmed%"${leading_trimmed##*[![:space:]]}"}
    [[ -n $origin ]] || fail "AUTH_TRUSTED_ORIGINS must not contain empty entries"
    validate_https_origin_value AUTH_TRUSTED_ORIGINS "$origin"
    [[ ! -v "seen[$origin]" ]] ||
      fail "AUTH_TRUSTED_ORIGINS must not contain duplicate origins"
    seen[$origin]=1
    [[ $origin == "$auth_url" ]] && found_auth_url=true
  done
  [[ $found_auth_url == true ]] ||
    fail "AUTH_TRUSTED_ORIGINS must include BETTER_AUTH_URL"
}

require_matching_service_env() {
  local first_file=$1
  local second_file=$2
  shift 2
  local key first_value second_value
  for key in "$@"; do
    read_service_env_value "$first_file" "$key"
    first_value=$SERVICE_ENV_VALUE
    read_service_env_value "$second_file" "$key"
    second_value=$SERVICE_ENV_VALUE
    [[ $first_value == "$second_value" ]] ||
      fail "$key must match between api.env and worker.env"
  done
}

validate_s3_service_env() {
  local file=$1
  local scope=$2
  require_nonempty_service_env "$file" \
    S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY \
    S3_FORCE_PATH_STYLE S3_BUCKET_VERSIONING S3_REQUEST_TIMEOUT_MS
  require_service_env_url "$file" S3_ENDPOINT http
  require_exact_service_env "$file" S3_FORCE_PATH_STYLE true
  require_exact_service_env "$file" S3_BUCKET_VERSIONING enabled
  require_bounded_service_env_integer "$file" S3_REQUEST_TIMEOUT_MS 120000

  if [[ $scope == api ]]; then
    require_nonempty_service_env "$file" S3_PUBLIC_ENDPOINT
    require_service_env_url "$file" S3_PUBLIC_ENDPOINT https
  else
    require_absent_service_env "$file" S3_PUBLIC_ENDPOINT
  fi
}

validate_artifact_service_env() {
  local file=$1
  require_nonempty_service_env "$file" \
    ARTIFACT_WORKSPACE_MAX_BYTES ARTIFACT_MAX_UPLOAD_BYTES \
    ARTIFACT_UPLOAD_TTL_SECONDS ARTIFACT_DOWNLOAD_TTL_SECONDS \
    ARTIFACT_PURGE_DELAY_SECONDS ARTIFACT_CLEANUP_LEASE_SECONDS \
    ARTIFACT_MAINTENANCE_INTERVAL_MS ARTIFACT_MAINTENANCE_BATCH_SIZE
  require_bounded_service_env_integer "$file" ARTIFACT_WORKSPACE_MAX_BYTES 9007199254740991
  require_bounded_service_env_integer "$file" ARTIFACT_MAX_UPLOAD_BYTES 5368709120
  require_bounded_service_env_integer "$file" ARTIFACT_UPLOAD_TTL_SECONDS 604800
  require_bounded_service_env_integer "$file" ARTIFACT_DOWNLOAD_TTL_SECONDS 604800
  require_bounded_service_env_integer "$file" ARTIFACT_PURGE_DELAY_SECONDS 31536000
  require_bounded_service_env_integer "$file" ARTIFACT_CLEANUP_LEASE_SECONDS 86400
  require_bounded_service_env_integer "$file" ARTIFACT_MAINTENANCE_INTERVAL_MS 86400000
  require_bounded_service_env_integer "$file" ARTIFACT_MAINTENANCE_BATCH_SIZE 100

  local workspace_max upload_max
  read_service_env_value "$file" ARTIFACT_WORKSPACE_MAX_BYTES
  workspace_max=$SERVICE_ENV_VALUE
  read_service_env_value "$file" ARTIFACT_MAX_UPLOAD_BYTES
  upload_max=$SERVICE_ENV_VALUE
  positive_decimal_lte "$upload_max" "$workspace_max" ||
    fail "$file requires ARTIFACT_MAX_UPLOAD_BYTES not to exceed ARTIFACT_WORKSPACE_MAX_BYTES"
}

validate_share_token_keyring_env() {
  local file=$1
  require_bounded_service_env_integer "$file" SHARE_TOKEN_ACTIVE_VERSION 2147483647
  local active_version
  active_version=$SERVICE_ENV_VALUE
  require_nonempty_service_env "$file" SHARE_TOKEN_KEYS
  local encoded_keys=$SERVICE_ENV_VALUE

  jq -e --arg active "$active_version" '
    type == "object" and
    length > 0 and
    has($active) and
    all(keys[];
      test("^[1-9][0-9]{0,9}$") and
      (tonumber <= 2147483647)) and
    all(.[];
      type == "string" and
      length >= 43 and length <= 8192 and
      test("^(?:[A-Za-z0-9+/]+={0,2}|[A-Za-z0-9_-]+={0,2})$") and
      (length % 4 != 1) and
      ((contains("=") | not) or (length % 4 == 0)))
  ' <<<"$encoded_keys" >/dev/null 2>&1 ||
    fail "$file contains an invalid SHARE_TOKEN_ACTIVE_VERSION/SHARE_TOKEN_KEYS keyring"
}

validate_service_environment_files() {
  local -a api_allowed_keys=(
    APP_ENV DATABASE_URL REDIS_URL DATABASE_POOL_MAX
    DATABASE_CONNECT_TIMEOUT_MS DATABASE_STATEMENT_TIMEOUT_MS
    REDIS_CONNECT_TIMEOUT_MS BETTER_AUTH_URL BETTER_AUTH_SECRET
    AUTH_TRUSTED_ORIGINS AUTH_TRUSTED_PROXY_CIDRS
    GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
    S3_ENDPOINT S3_PUBLIC_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY_ID
    S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE S3_BUCKET_VERSIONING
    S3_REQUEST_TIMEOUT_MS ARTIFACT_WORKSPACE_MAX_BYTES
    ARTIFACT_MAX_UPLOAD_BYTES ARTIFACT_UPLOAD_TTL_SECONDS
    ARTIFACT_DOWNLOAD_TTL_SECONDS ARTIFACT_PURGE_DELAY_SECONDS
    ARTIFACT_CLEANUP_LEASE_SECONDS ARTIFACT_MAINTENANCE_INTERVAL_MS
    ARTIFACT_MAINTENANCE_BATCH_SIZE SHARE_TOKEN_ACTIVE_VERSION SHARE_TOKEN_KEYS
  )
  local -a worker_allowed_keys=(
    APP_ENV DATABASE_URL REDIS_URL DATABASE_POOL_MAX
    DATABASE_CONNECT_TIMEOUT_MS DATABASE_STATEMENT_TIMEOUT_MS
    REDIS_CONNECT_TIMEOUT_MS S3_ENDPOINT S3_REGION S3_BUCKET
    S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_FORCE_PATH_STYLE
    S3_BUCKET_VERSIONING S3_REQUEST_TIMEOUT_MS
    ARTIFACT_WORKSPACE_MAX_BYTES ARTIFACT_MAX_UPLOAD_BYTES
    ARTIFACT_UPLOAD_TTL_SECONDS ARTIFACT_DOWNLOAD_TTL_SECONDS
    ARTIFACT_PURGE_DELAY_SECONDS ARTIFACT_CLEANUP_LEASE_SECONDS
    ARTIFACT_MAINTENANCE_INTERVAL_MS ARTIFACT_MAINTENANCE_BATCH_SIZE
    AZURE_API_KEY
  )
  local -a migrate_allowed_keys=(
    DATABASE_URL DATABASE_POOL_MAX DATABASE_CONNECT_TIMEOUT_MS
    DATABASE_STATEMENT_TIMEOUT_MS
  )
  local prefix

  require_no_service_env_prefix "$API_ENV_FILE" AZURE_
  require_only_service_env_keys "$API_ENV_FILE" "${api_allowed_keys[@]}"
  for prefix in BETTER_AUTH_ AUTH_ GOOGLE_ GITHUB_ SHARE_TOKEN_; do
    require_no_service_env_prefix "$WORKER_ENV_FILE" "$prefix"
  done
  require_only_service_env_keys "$WORKER_ENV_FILE" "${worker_allowed_keys[@]}"
  for prefix in AZURE_ SHARE_TOKEN_ GOOGLE_ GITHUB_ BETTER_AUTH_ AUTH_; do
    require_no_service_env_prefix "$MIGRATE_ENV_FILE" "$prefix"
  done
  require_only_service_env_keys "$MIGRATE_ENV_FILE" "${migrate_allowed_keys[@]}"

  grep -Fxq 'APP_ENV=production' "$API_ENV_FILE" ||
    fail "$API_ENV_FILE must declare literal APP_ENV=production"
  require_nonempty_service_env "$API_ENV_FILE" \
    APP_ENV DATABASE_URL REDIS_URL DATABASE_POOL_MAX \
    DATABASE_CONNECT_TIMEOUT_MS DATABASE_STATEMENT_TIMEOUT_MS \
    REDIS_CONNECT_TIMEOUT_MS BETTER_AUTH_URL BETTER_AUTH_SECRET \
    AUTH_TRUSTED_ORIGINS AUTH_TRUSTED_PROXY_CIDRS \
    GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET
  require_exact_service_env "$API_ENV_FILE" APP_ENV production
  require_service_env_url "$API_ENV_FILE" DATABASE_URL postgres
  require_service_env_url "$API_ENV_FILE" REDIS_URL redis
  validate_auth_service_env "$API_ENV_FILE"
  require_service_env_min_length "$API_ENV_FILE" BETTER_AUTH_SECRET 32
  require_bounded_service_env_integer "$API_ENV_FILE" DATABASE_POOL_MAX 100
  require_bounded_service_env_integer "$API_ENV_FILE" DATABASE_CONNECT_TIMEOUT_MS 120000
  require_bounded_service_env_integer "$API_ENV_FILE" DATABASE_STATEMENT_TIMEOUT_MS 600000
  require_bounded_service_env_integer "$API_ENV_FILE" REDIS_CONNECT_TIMEOUT_MS 120000
  validate_s3_service_env "$API_ENV_FILE" api
  validate_artifact_service_env "$API_ENV_FILE"
  validate_share_token_keyring_env "$API_ENV_FILE"

  grep -Fxq 'APP_ENV=production' "$WORKER_ENV_FILE" ||
    fail "$WORKER_ENV_FILE must declare literal APP_ENV=production"
  require_nonempty_service_env "$WORKER_ENV_FILE" \
    APP_ENV DATABASE_URL REDIS_URL DATABASE_POOL_MAX \
    DATABASE_CONNECT_TIMEOUT_MS DATABASE_STATEMENT_TIMEOUT_MS \
    REDIS_CONNECT_TIMEOUT_MS AZURE_API_KEY
  require_exact_service_env "$WORKER_ENV_FILE" APP_ENV production
  require_service_env_url "$WORKER_ENV_FILE" DATABASE_URL postgres
  require_service_env_url "$WORKER_ENV_FILE" REDIS_URL redis
  require_bounded_service_env_integer "$WORKER_ENV_FILE" DATABASE_POOL_MAX 100
  require_bounded_service_env_integer "$WORKER_ENV_FILE" DATABASE_CONNECT_TIMEOUT_MS 120000
  require_bounded_service_env_integer "$WORKER_ENV_FILE" DATABASE_STATEMENT_TIMEOUT_MS 600000
  require_bounded_service_env_integer "$WORKER_ENV_FILE" REDIS_CONNECT_TIMEOUT_MS 120000
  require_service_env_max_length "$WORKER_ENV_FILE" AZURE_API_KEY 4096
  validate_s3_service_env "$WORKER_ENV_FILE" worker
  validate_artifact_service_env "$WORKER_ENV_FILE"

  require_nonempty_service_env "$MIGRATE_ENV_FILE" \
    DATABASE_URL DATABASE_POOL_MAX DATABASE_CONNECT_TIMEOUT_MS \
    DATABASE_STATEMENT_TIMEOUT_MS
  require_service_env_url "$MIGRATE_ENV_FILE" DATABASE_URL postgres
  require_bounded_service_env_integer "$MIGRATE_ENV_FILE" DATABASE_POOL_MAX 100
  require_bounded_service_env_integer "$MIGRATE_ENV_FILE" DATABASE_CONNECT_TIMEOUT_MS 120000
  require_bounded_service_env_integer "$MIGRATE_ENV_FILE" DATABASE_STATEMENT_TIMEOUT_MS 600000

  local -a shared_runtime_config=(
    S3_ENDPOINT S3_REGION S3_BUCKET S3_FORCE_PATH_STYLE
    S3_BUCKET_VERSIONING S3_REQUEST_TIMEOUT_MS
    ARTIFACT_WORKSPACE_MAX_BYTES ARTIFACT_MAX_UPLOAD_BYTES
    ARTIFACT_UPLOAD_TTL_SECONDS ARTIFACT_DOWNLOAD_TTL_SECONDS
    ARTIFACT_PURGE_DELAY_SECONDS ARTIFACT_CLEANUP_LEASE_SECONDS
    ARTIFACT_MAINTENANCE_INTERVAL_MS ARTIFACT_MAINTENANCE_BATCH_SIZE
  )
  require_matching_service_env \
    "$API_ENV_FILE" "$WORKER_ENV_FILE" "${shared_runtime_config[@]}"
}

# Validate Compose's actual per-service values while keeping the operator's
# configuration in one .env. Temporary validation inputs never leave this
# private subshell and are removed on success and failure.
validate_rendered_service_environments() (
  umask 077
  local temp_dir service
  temp_dir=$(mktemp -d)
  trap 'rm -rf -- "$temp_dir"' EXIT
  API_ENV_FILE="$temp_dir/api.env"
  WORKER_ENV_FILE="$temp_dir/worker.env"
  MIGRATE_ENV_FILE="$temp_dir/migrate.env"
  SERVICE_ENVIRONMENTS_JSON=$1

  jq -e --arg version "$RELEASE_VERSION" --arg revision "$RELEASE_GIT_SHA" \
    --arg endpoint "$OTEL_EXPORTER_OTLP_ENDPOINT" \
    --arg interval "$OTEL_METRIC_EXPORT_INTERVAL" \
    --arg sampler "$OTEL_TRACES_SAMPLER" \
    --arg environment "$DEPLOYMENT_ENVIRONMENT_NAME" '
    .services as $services |
    all(["api", "worker", "migrate"][];
      $services[.].environment as $env |
      ($env | type) == "object" and
      all($env[]; type == "string" and (test("[\\r\\n]") | not)) and
      $env.APP_VERSION == $version and $env.GIT_SHA == $revision) and
    $services.api.environment.PORT == "8000" and
    $services.api.environment.RELAY_PROCESS_ROLE == "api" and
    $services.api.environment.OTEL_SERVICE_NAME == "relay-api" and
    $services.worker.environment.RELAY_PROCESS_ROLE == "worker" and
    $services.worker.environment.OTEL_SERVICE_NAME == "relay-worker" and
    $services.migrate.environment.OTEL_DENO == "false" and
    ($services.api.environment.DATABASE_URL | test("^postgres(?:ql)?://relay_app:")) and
    $services.api.environment.DATABASE_URL == $services.worker.environment.DATABASE_URL and
    ($services.migrate.environment.DATABASE_URL | test("^postgres(?:ql)?://relay_migrator:")) and
    all(["api", "worker"][];
      $services[.].environment as $env |
      $env.OTEL_DENO == "true" and
      $env.OTEL_EXPORTER_OTLP_PROTOCOL == "http/protobuf" and
      $env.OTEL_EXPORTER_OTLP_ENDPOINT == $endpoint and
      $env.OTEL_METRIC_EXPORT_INTERVAL == $interval and
      $env.OTEL_TRACES_SAMPLER == $sampler and
      $env.DEPLOYMENT_ENVIRONMENT_NAME == $environment and
      $env.OTEL_PROPAGATORS == "tracecontext" and
      $env.OTEL_DENO_CONSOLE == "capture")
  ' <<<"$SERVICE_ENVIRONMENTS_JSON" >/dev/null ||
    fail "rendered Compose has invalid role, build, or telemetry settings"

  for service in api worker migrate; do
    jq -r --arg service "$service" '
      .services[$service].environment |
      del(.APP_VERSION, .GIT_SHA, .OTEL_DENO) |
      if $service != "migrate" then
        del(.RELAY_PROCESS_ROLE, .OTEL_SERVICE_NAME,
          .DEPLOYMENT_ENVIRONMENT_NAME, .OTEL_EXPORTER_OTLP_PROTOCOL,
          .OTEL_EXPORTER_OTLP_ENDPOINT, .OTEL_PROPAGATORS, .OTEL_DENO_CONSOLE,
          .OTEL_METRIC_EXPORT_INTERVAL, .OTEL_TRACES_SAMPLER)
      else . end |
      if $service == "api" then del(.PORT) else . end |
      to_entries[] | "\(.key)=\(.value)"
    ' <<<"$SERVICE_ENVIRONMENTS_JSON" > "$temp_dir/$service.env"
  done
  validate_service_environment_files
  validate_trusted_proxy_cidrs "$API_ENV_FILE" "$2" "$RELAY_PROXY_NETWORK"
)

validate_trusted_proxy_cidrs() {
  local file=$1
  local nginx_networks=$2
  local edge_network=$3
  read_service_env_value "$file" AUTH_TRUSTED_PROXY_CIDRS
  local configured=$SERVICE_ENV_VALUE
  [[ $configured != ,* && $configured != *, && $configured != *,,* ]] ||
    fail "AUTH_TRUSTED_PROXY_CIDRS must be a comma-separated exact-address allowlist"

  local -a proxy_addresses=()
  mapfile -t proxy_addresses < <(
    jq -r --arg network "$edge_network" '
      .[$network] |
      [.IPAddress, .GlobalIPv6Address] | .[] |
      select(type == "string" and length > 0)
    ' <<<"$nginx_networks"
  )
  ((${#proxy_addresses[@]} > 0)) ||
    fail "Nginx has no address on edge network $edge_network"

  local -a entries=()
  IFS=',' read -r -a entries <<<"$configured"
  local entry leading_trimmed address exact_cidr matched
  for entry in "${entries[@]}"; do
    leading_trimmed=${entry#"${entry%%[![:space:]]*}"}
    entry=${leading_trimmed%"${leading_trimmed##*[![:space:]]}"}
    [[ -n $entry ]] ||
      fail "AUTH_TRUSTED_PROXY_CIDRS must not contain empty entries"

    matched=false
    for address in "${proxy_addresses[@]}"; do
      if [[ $address == *:* ]]; then
        exact_cidr="$address/128"
      else
        exact_cidr="$address/32"
      fi
      if [[ $entry == "$address" || $entry == "$exact_cidr" ]]; then
        matched=true
        break
      fi
    done
    [[ $matched == true ]] ||
      fail "AUTH_TRUSTED_PROXY_CIDRS may contain only exact current Nginx edge-network addresses (/32 or /128)"
  done
}

require_private_file() {
  local file=$1
  [[ -f $file ]] || fail "required service environment file is missing: $file"
  local mode
  mode=$(stat -c '%a' -- "$file")
  [[ $mode =~ ^[0-7]{3,4}$ ]] || fail "cannot determine permissions for $file"
  if (((8#$mode & 077) != 0)); then
    fail "$file permissions are $mode; service secret files must not grant group or other access"
  fi
}

load_release_env() {
  local file=$1
  [[ -f $file ]] || fail "release file does not exist: $file"
  RELAY_ENV_FILE=${RELAY_ENV_FILE:-$file}
  [[ -f $RELAY_ENV_FILE ]] || fail "Compose .env does not exist: $RELAY_ENV_FILE"

  local key
  for key in \
    RELEASE_VERSION RELEASE_TAG RELEASE_GIT_SHA \
    DOCKERHUB_NAMESPACE DOCKERHUB_BACKEND_REPOSITORY DOCKERHUB_WEB_REPOSITORY \
    BACKEND_DIGEST WEB_DIGEST; do
    read_required_env "$file" "$key"
  done
  for key in \
    NGINX_COMPOSE_FILE NGINX_SERVICE RELAY_PUBLIC_URL \
    RELAY_PROXY_NETWORK RELAY_DATABASE_NETWORK \
    DEPLOYMENT_ENVIRONMENT_NAME OTEL_DENO OTEL_EXPORTER_OTLP_ENDPOINT \
    OTEL_METRIC_EXPORT_INTERVAL OTEL_TRACES_SAMPLER \
    BACKUP_VERIFIED_AT_FILE BACKUP_MAX_AGE_SECONDS MIN_FREE_DISK_MB; do
    read_required_env "$RELAY_ENV_FILE" "$key"
  done

  [[ $RELEASE_VERSION =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] ||
    fail "RELEASE_VERSION must be canonical stable SemVer"
  [[ $RELEASE_TAG == "v$RELEASE_VERSION" ]] ||
    fail "RELEASE_TAG must equal v$RELEASE_VERSION"
  [[ $RELEASE_GIT_SHA =~ ^[0-9a-f]{40}$ && ! $RELEASE_GIT_SHA =~ ^0+$ ]] ||
    fail "RELEASE_GIT_SHA must be a non-zero lowercase full Git SHA"
  [[ $BACKEND_DIGEST =~ ^sha256:[0-9a-f]{64}$ && ! $BACKEND_DIGEST =~ ^sha256:0+$ ]] ||
    fail "BACKEND_DIGEST must be a non-zero lowercase sha256 digest"
  [[ $WEB_DIGEST =~ ^sha256:[0-9a-f]{64}$ && ! $WEB_DIGEST =~ ^sha256:0+$ ]] ||
    fail "WEB_DIGEST must be a non-zero lowercase sha256 digest"

  local repository
  for repository in \
    "$DOCKERHUB_NAMESPACE" \
    "$DOCKERHUB_BACKEND_REPOSITORY" \
    "$DOCKERHUB_WEB_REPOSITORY"; do
    [[ $repository =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]] ||
      fail "Docker Hub namespace and repository names must be lowercase and unqualified"
  done
  [[ $DOCKERHUB_BACKEND_REPOSITORY != "$DOCKERHUB_WEB_REPOSITORY" ]] ||
    fail "backend and web repositories must be distinct"

  local network
  for network in "$RELAY_PROXY_NETWORK" "$RELAY_DATABASE_NETWORK"; do
    [[ $network =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]] ||
      fail "invalid external Docker network name"
  done
  [[ $RELAY_PROXY_NETWORK != "$RELAY_DATABASE_NETWORK" ]] ||
    fail "proxy and PostgreSQL networks must be distinct"

  local path
  for path in \
    "$RELAY_ENV_FILE" \
    "$NGINX_COMPOSE_FILE" "$BACKUP_VERIFIED_AT_FILE"; do
    [[ $path == /* ]] || fail "deployment paths must be absolute: $path"
  done
  [[ $NGINX_SERVICE =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] ||
    fail "NGINX_SERVICE must be a valid Compose service name"
  validate_https_origin_value RELAY_PUBLIC_URL "$RELAY_PUBLIC_URL"
  [[ $OTEL_DENO == "true" ]] || fail "production requires OTEL_DENO=true"
  [[ $OTEL_EXPORTER_OTLP_ENDPOINT =~ ^http://[^[:space:]]+$ ]] ||
    fail "OTEL_EXPORTER_OTLP_ENDPOINT must be an internal HTTP URL"
  [[ $OTEL_METRIC_EXPORT_INTERVAL =~ ^[1-9][0-9]*$ ]] ||
    fail "OTEL_METRIC_EXPORT_INTERVAL must be a positive integer"
  [[ $OTEL_TRACES_SAMPLER =~ ^[a-z_]+$ ]] || fail "invalid OTEL_TRACES_SAMPLER"
  [[ $BACKUP_MAX_AGE_SECONDS =~ ^[1-9][0-9]*$ ]] ||
    fail "BACKUP_MAX_AGE_SECONDS must be a positive integer"
  [[ $MIN_FREE_DISK_MB =~ ^[1-9][0-9]*$ ]] ||
    fail "MIN_FREE_DISK_MB must be a positive integer"

  export RELEASE_VERSION RELEASE_TAG RELEASE_GIT_SHA
  export DOCKERHUB_NAMESPACE DOCKERHUB_BACKEND_REPOSITORY DOCKERHUB_WEB_REPOSITORY
  export BACKEND_DIGEST WEB_DIGEST
  export RELAY_ENV_FILE
  export NGINX_COMPOSE_FILE NGINX_SERVICE RELAY_PUBLIC_URL
  export RELAY_PROXY_NETWORK RELAY_DATABASE_NETWORK
  export DEPLOYMENT_ENVIRONMENT_NAME OTEL_DENO OTEL_EXPORTER_OTLP_ENDPOINT
  export OTEL_METRIC_EXPORT_INTERVAL OTEL_TRACES_SAMPLER
}

check_compose_version() {
  local version
  version=$(docker compose version --short)
  version=${version#v}
  if [[ ! $version =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    fail "unable to parse Docker Compose version: $version"
  fi
  local major=${BASH_REMATCH[1]}
  local minor=${BASH_REMATCH[2]}
  if ((major < 2 || (major == 2 && minor < 24))); then
    fail "Docker Compose 2.24 or newer is required; found $version"
  fi
}

validate_remote_image_metadata() {
  local reference=$1
  local manifest_json=$2
  local image_json=$3

  jq -e '
    def sha256_digest:
      (type == "string") and
      test("^sha256:[0-9a-f]{64}$") and
      (test("^sha256:0+$") == false);
    def content_descriptor:
      (type == "object") and
      ((.mediaType | type) == "string") and
      ((.mediaType | length) > 0) and
      (.digest | sha256_digest) and
      ((.size | type) == "number") and
      (.size > 0) and
      ((.size | floor) == .size);
    def runnable_descriptor:
      content_descriptor and
      (.mediaType == "application/vnd.oci.image.manifest.v1+json" or
       .mediaType == "application/vnd.docker.distribution.manifest.v2+json") and
      .platform.os == "linux" and
      .platform.architecture == "amd64";
    def attestation_descriptor:
      content_descriptor and
      .mediaType == "application/vnd.oci.image.manifest.v1+json" and
      .platform.os == "unknown" and
      .platform.architecture == "unknown" and
      .annotations["vnd.docker.reference.type"] == "attestation-manifest" and
      (.annotations["vnd.docker.reference.digest"] | sha256_digest);
    .schemaVersion == 2 and
    if (.manifests? | type) == "array" then
      (.manifests | map(select(runnable_descriptor))) as $runnable |
      ((.mediaType == "application/vnd.oci.image.index.v1+json" or
        .mediaType == "application/vnd.docker.distribution.manifest.list.v2+json") and
       (($runnable | length) == 1) and
       all(.manifests[];
         runnable_descriptor or
         (attestation_descriptor and
          .annotations["vnd.docker.reference.digest"] == $runnable[0].digest)))
    else
      (.mediaType == "application/vnd.oci.image.manifest.v1+json" or
       .mediaType == "application/vnd.docker.distribution.manifest.v2+json") and
      (.config | content_descriptor) and
      ((.layers | type) == "array") and
      ((.layers | length) > 0) and
      all(.layers[]; content_descriptor)
    end
  ' <<<"$manifest_json" >/dev/null ||
    fail "$reference must contain exactly one runnable linux/amd64 image; only linked unknown/unknown attestation descriptors are allowed"

  jq -e \
    --arg version "$RELEASE_VERSION" \
    --arg revision "$RELEASE_GIT_SHA" '
      def expected_image:
        type == "object" and
        .os == "linux" and
        .architecture == "amd64" and
        .config.Labels["org.opencontainers.image.version"] == $version and
        .config.Labels["org.opencontainers.image.revision"] == $revision;
      if type == "object" and has("os") then
        expected_image
      elif type == "object" then
        has("linux/amd64") and
        (.["linux/amd64"] | expected_image) and
        all(keys[]; . == "linux/amd64" or . == "unknown/unknown")
      else
        false
      end
    ' <<<"$image_json" >/dev/null ||
    fail "$reference does not expose the expected linux/amd64 release labels"
}

verify_remote_image() {
  local repository=$1
  local digest=$2
  local reference="$repository@$digest"
  local actual manifest_json image_json
  actual=$(docker buildx imagetools inspect "$reference" --format '{{.Manifest.Digest}}') ||
    fail "cannot inspect $reference; authenticate with the read-only registry token"
  [[ $actual == "$digest" ]] || fail "registry digest mismatch for $reference"

  manifest_json=$(docker buildx imagetools inspect "$reference" --format '{{json .Manifest}}') ||
    fail "cannot inspect OCI manifest metadata for $reference"
  image_json=$(docker buildx imagetools inspect "$reference" --format '{{json .Image}}') ||
    fail "cannot inspect OCI image metadata for $reference"
  validate_remote_image_metadata "$reference" "$manifest_json" "$image_json"
}

run_preflight() {
  local release_file=$1
  local compose_file=$2

  require_command awk
  require_command curl
  require_command cmp
  require_command date
  require_command df
  require_command docker
  require_command flock
  require_command grep
  require_command jq
  require_command mktemp
  require_command stat
  require_command tr
  require_command uname

  RELAY_ENV_FILE=${RELAY_ENV_FILE:-$(dirname -- "$compose_file")/.env}
  load_release_env "$release_file"
  [[ -f $compose_file ]] || fail "production Compose file does not exist: $compose_file"
  [[ -f $NGINX_COMPOSE_FILE ]] || fail "Nginx Compose file does not exist: $NGINX_COMPOSE_FILE"

  require_private_file "$RELAY_ENV_FILE"

  check_compose_version
  if ! SERVICE_ENVIRONMENTS_JSON=$(
    docker compose --project-name relay --env-file "$RELAY_ENV_FILE" --env-file "$release_file" \
      -f "$compose_file" config --format json
  ); then
    fail "production Compose configuration is invalid"
  fi
  docker compose -f "$NGINX_COMPOSE_FILE" config --quiet
  docker buildx version >/dev/null 2>&1 || fail "Docker Buildx is required for remote digest verification"

  [[ $(uname -s) == "Linux" ]] || fail "the production host must run Linux"
  local architecture engine_os
  architecture=$(docker info --format '{{.Architecture}}')
  engine_os=$(docker info --format '{{.OSType}}')
  [[ $engine_os == "linux" ]] || fail "the Docker Engine must run Linux containers"
  [[ $architecture == "amd64" || $architecture == "x86_64" ]] ||
    fail "production host must be linux/amd64; Docker reports $architecture"

  local network
  for network in "$RELAY_PROXY_NETWORK" "$RELAY_DATABASE_NETWORK"; do
    docker network inspect "$network" >/dev/null 2>&1 ||
      fail "required external network does not exist: $network"
  done

  local nginx_id nginx_networks
  nginx_id=$(docker compose -f "$NGINX_COMPOSE_FILE" ps -q "$NGINX_SERVICE")
  [[ -n $nginx_id ]] || fail "Nginx service is not running: $NGINX_SERVICE"
  nginx_networks=$(docker inspect --format '{{json .NetworkSettings.Networks}}' "$nginx_id")
  jq -e --arg network "$RELAY_PROXY_NETWORK" 'has($network)' \
    <<<"$nginx_networks" >/dev/null ||
    fail "Nginx is not attached to proxy network $RELAY_PROXY_NETWORK"
  validate_rendered_service_environments "$SERVICE_ENVIRONMENTS_JSON" "$nginx_networks"
  SERVICE_ENVIRONMENTS_JSON=
  docker compose -f "$NGINX_COMPOSE_FILE" exec -T \
    "$NGINX_SERVICE" nginx -t

  [[ -f $BACKUP_VERIFIED_AT_FILE ]] ||
    fail "backup verification marker is missing: $BACKUP_VERIFIED_AT_FILE"
  local backup_timestamp backup_epoch now_epoch backup_age
  backup_timestamp=$(tr -d '\r\n' < "$BACKUP_VERIFIED_AT_FILE")
  [[ $backup_timestamp =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    fail "backup verification marker must contain one RFC 3339 UTC timestamp"
  backup_epoch=$(date -u -d "$backup_timestamp" +%s) ||
    fail "backup verification timestamp is invalid"
  now_epoch=$(date -u +%s)
  backup_age=$((now_epoch - backup_epoch))
  ((backup_age >= -300)) || fail "backup verification timestamp is unexpectedly in the future"
  ((backup_age <= BACKUP_MAX_AGE_SECONDS)) ||
    fail "last restore-verified backup is too old (${backup_age}s)"

  local available_mb
  available_mb=$(df -Pm "$compose_file" | awk 'NR == 2 { print $4 }')
  [[ $available_mb =~ ^[0-9]+$ ]] || fail "cannot determine free disk space"
  ((available_mb >= MIN_FREE_DISK_MB)) ||
    fail "only ${available_mb} MiB is free; ${MIN_FREE_DISK_MB} MiB is required"

  verify_remote_image \
    "$DOCKERHUB_NAMESPACE/$DOCKERHUB_BACKEND_REPOSITORY" \
    "$BACKEND_DIGEST"
  verify_remote_image \
    "$DOCKERHUB_NAMESPACE/$DOCKERHUB_WEB_REPOSITORY" \
    "$WEB_DIGEST"

  echo "Preflight passed for $RELEASE_TAG ($RELEASE_GIT_SHA); no host state was changed."
}

reload_nginx() {
  docker compose -f "$NGINX_COMPOSE_FILE" exec -T "$NGINX_SERVICE" nginx -t
  docker compose -f "$NGINX_COMPOSE_FILE" exec -T "$NGINX_SERVICE" nginx -s reload
}

verify_running_release() {
  local release_file=$1
  local compose_file=$2
  local version_json
  version_json=$(mktemp)

  curl --fail --silent --show-error --max-time 20 \
    "$RELAY_PUBLIC_URL/version" > "$version_json"
  jq -e --arg version "$RELEASE_VERSION" --arg revision "$RELEASE_GIT_SHA" \
    '.version == $version and .revision == $revision' "$version_json" >/dev/null ||
    fail "public /version does not match the selected release"
  curl --fail --silent --show-error --max-time 20 \
    "$RELAY_PUBLIC_URL/health/ready" >/dev/null
  curl --fail --silent --show-error --max-time 20 \
    "$RELAY_PUBLIC_URL/healthz" >/dev/null
  curl --fail --silent --show-error --max-time 20 \
    "$RELAY_PUBLIC_URL/.well-known/oauth-protected-resource/mcp" >/dev/null

  local service container_id health
  for service in api worker web; do
    container_id=$(docker compose --project-name relay --env-file "$RELAY_ENV_FILE" --env-file "$release_file" \
      -f "$compose_file" ps -q "$service")
    [[ -n $container_id ]] || fail "$service container is not running"
    health=$(docker inspect --format '{{.State.Health.Status}}' "$container_id")
    [[ $health == "healthy" ]] || fail "$service container health is $health"
  done
  rm -f "$version_json"
}

select_current_release() {
  local release_file=$1
  # When deploying directly from .env, retain only immutable image selectors
  # for rollback. Never copy the shared secrets into release history.
  if [[ $release_file == "$RELAY_ENV_FILE" ]]; then
    local release_directory selector pending_selector
    release_directory="$(dirname -- "$RELAY_ENV_FILE")/releases"
    mkdir -p -- "$release_directory"
    selector="$release_directory/$RELEASE_TAG.env"
    pending_selector=$(mktemp "$release_directory/.selector.XXXXXX")
    local key
    for key in RELEASE_VERSION RELEASE_TAG RELEASE_GIT_SHA \
      DOCKERHUB_NAMESPACE DOCKERHUB_BACKEND_REPOSITORY DOCKERHUB_WEB_REPOSITORY \
      BACKEND_DIGEST WEB_DIGEST; do
      printf '%s=%s\n' "$key" "${!key}" >> "$pending_selector"
    done
    if [[ -e $selector || -L $selector ]]; then
      if [[ -L $selector ]] || ! cmp -s -- "$selector" "$pending_selector"; then
        rm -f -- "$pending_selector"
        fail "existing release selector differs: $selector"
      fi
      rm -f -- "$pending_selector"
    else
      mv -- "$pending_selector" "$selector"
    fi
    release_file=$selector
  fi
  local current_link=${RELAY_CURRENT_RELEASE_LINK:-/opt/relay/current-release.env}
  local link_directory pending_link
  link_directory=$(dirname -- "$current_link")
  [[ -d $link_directory ]] || fail "current release link directory does not exist"
  if [[ -e $current_link && ! -L $current_link ]]; then
    fail "refusing to replace non-symlink current release file: $current_link"
  fi

  pending_link="${current_link}.pending"
  [[ ! -e $pending_link && ! -L $pending_link ]] ||
    fail "remove stale pending release link before retrying: $pending_link"
  ln -s "$release_file" "$pending_link"
  mv -Tf "$pending_link" "$current_link"
}
