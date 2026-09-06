#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck source=./lib.sh
source "$SCRIPT_DIR/lib.sh"

if (($# < 1 || $# > 2)); then
  echo "Usage: $0 /opt/relay/releases/vX.Y.Z.env [/opt/relay/docker-compose.yml]" >&2
  exit 2
fi

RELEASE_FILE=$(realpath -- "$1")
COMPOSE_FILE=$(realpath -- "${2:-$DEPLOY_DIR/compose.prod.yaml}")
run_preflight "$RELEASE_FILE" "$COMPOSE_FILE"
