#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

if (($# != 1)); then
  echo "Usage: $0 nginx-image@sha256:<digest>" >&2
  exit 2
fi

image=$1
[[ $image =~ @sha256:[0-9a-f]{64}$ ]] || {
  echo "Nginx test image must be digest-pinned" >&2
  exit 2
}

host_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

bootstrap_config=$(host_path "$SCRIPT_DIR/nginx-bootstrap.conf")
log_format=$(host_path "$DEPLOY_DIR/nginx/relay-log-format.conf")
proxy_headers=$(host_path "$DEPLOY_DIR/nginx/relay-proxy-headers.conf")
routes=$(host_path "$DEPLOY_DIR/nginx/relay-routes.conf")

# Deliberately do not create relay-api or relay-web DNS records. Passing proves
# configuration validation is safe before the first application deployment.
MSYS_NO_PATHCONV=1 docker run --rm --pull never \
  -v "$bootstrap_config:/etc/nginx/nginx-bootstrap.conf:ro" \
  -v "$log_format:/etc/nginx/relay-log-format.conf:ro" \
  -v "$proxy_headers:/etc/nginx/snippets/relay-proxy-headers.conf:ro" \
  -v "$routes:/etc/nginx/relay-routes.conf:ro" \
  "$image" nginx -t -c /etc/nginx/nginx-bootstrap.conf
