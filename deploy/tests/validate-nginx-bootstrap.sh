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

temp_dir=$(mktemp -d)
trap 'rm -rf -- "$temp_dir"' EXIT
python3 "$SCRIPT_DIR/render-nginx-test.py" "$temp_dir/nginx-bootstrap.conf"
bootstrap_config=$(host_path "$temp_dir/nginx-bootstrap.conf")

# Deliberately do not create relay-api or relay-web DNS records. Passing proves
# configuration validation is safe before the first application deployment.
MSYS_NO_PATHCONV=1 docker run --rm --pull never \
  -v "$bootstrap_config:/etc/nginx/nginx-bootstrap.conf:ro" \
  "$image" nginx -t -c /etc/nginx/nginx-bootstrap.conf
