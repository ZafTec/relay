#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

usage() {
  echo "Usage: $0 --confirm-schema-compatible /opt/relay/releases/vX.Y.Z.env [/opt/relay/docker-compose.yml]" >&2
  exit 2
}

if [[ ${1:-} != "--locked" ]]; then
  [[ ${1:-} == "--confirm-schema-compatible" ]] || usage
  shift
  (($# >= 1 && $# <= 2)) || usage
  release_file=$(realpath -- "$1")
  compose_file=$(realpath -- "${2:-$DEPLOY_DIR/compose.prod.yaml}")
  lock_file=${RELAY_DEPLOY_LOCK_FILE:-/opt/relay/.deploy.lock}
  [[ -f $lock_file && ! -L $lock_file ]] ||
    fail "deployment lock must be a pre-created regular file: $lock_file"
  exec flock --exclusive --nonblock "$lock_file" \
    bash "$0" --locked "$release_file" "$compose_file"
fi

shift
(($# == 2)) || usage
RELEASE_FILE=$1
COMPOSE_FILE=$2
trap 'echo "Rollback stopped; inspect the running services before taking another action." >&2' ERR

run_preflight "$RELEASE_FILE" "$COMPOSE_FILE"
load_release_env "$RELEASE_FILE"
COMPOSE=(docker compose --project-name relay --env-file "$RELEASE_FILE" -f "$COMPOSE_FILE")

# Rollback never runs a down-migration. The explicit confirmation flag records
# the operator's decision that the prior binaries support the current schema.
"${COMPOSE[@]}" pull api worker web
"${COMPOSE[@]}" up -d --pull never --wait --wait-timeout 180 --remove-orphans api worker web
reload_nginx
verify_running_release "$RELEASE_FILE" "$COMPOSE_FILE"

select_current_release "$RELEASE_FILE"

echo "Rollback verified: $RELEASE_TAG"
