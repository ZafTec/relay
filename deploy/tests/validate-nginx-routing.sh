#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd -- "$SCRIPT_DIR/.." && pwd)

if (($# != 2)); then
  echo "Usage: $0 nginx-image@sha256:<digest> python-image@sha256:<digest>" >&2
  exit 2
fi

nginx_image=$1
python_image=$2
for image in "$nginx_image" "$python_image"; do
  [[ $image =~ @sha256:[0-9a-f]{64}$ ]] || {
    echo "Routing test images must be digest-pinned" >&2
    exit 2
  }
done

host_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

test_id=${BASHPID:-$$}
network="relay-nginx-routing-$test_id"
api_container="relay-api-routing-$test_id"
web_container="relay-web-routing-$test_id"
nginx_container="relay-nginx-routing-$test_id"
temp_dir=$(mktemp -d)

cleanup() {
  MSYS_NO_PATHCONV=1 docker rm -f \
    "$nginx_container" "$api_container" "$web_container" >/dev/null 2>&1 || true
  MSYS_NO_PATHCONV=1 docker network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$temp_dir"
}
trap cleanup EXIT

cat > "$temp_dir/server.py" <<'PY'
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

role = os.environ["ROLE"]
port = int(os.environ["PORT"])

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        referer = self.headers.get("Referer", "")
        body = f"{role} {self.path} referer={referer}\n".encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass

if role == "api":
    Thread(target=ThreadingHTTPServer(("0.0.0.0", 9000), Handler).serve_forever, daemon=True).start()
ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
PY

cat > "$temp_dir/client.py" <<'PY'
from urllib.request import Request, urlopen
from urllib.error import HTTPError

cases = {
    "/version": "api /version referer=",
    "/api/v1/probe?check=1": "api /api/v1/probe?check=1 referer=",
    "/s/test-share-token": "api /s/test-share-token referer=",
    "/mcp": "api /mcp referer=",
    "/mcp/": "api /mcp/ referer=",
    "/api/v1/events": "api /api/v1/events referer=",
    "/.well-known/oauth-protected-resource/mcp": "api /.well-known/oauth-protected-resource/mcp referer=",
    "/.well-known/oauth-authorization-server/api/auth": "api /.well-known/oauth-authorization-server/api/auth referer=",
    "/health/ready": "api /health/ready referer=",
    "/relay-artifacts/artifacts/probe?X-Amz-Signature=test": "api /relay-artifacts/artifacts/probe?X-Amz-Signature=test referer=",
    "/": "web / referer=",
}
for path, expected in cases.items():
    request = Request(
        "http://relay-proxy:8080" + path,
        headers={"Referer": "https://outside.example/s/must-not-forward"},
    )
    with urlopen(request, timeout=5) as response:
        actual = response.read().decode().strip()
        if actual != expected:
            raise SystemExit(f"unexpected response for {path}: {actual!r}")
        if path.startswith("/s/") and response.headers.get("Referrer-Policy") != "no-referrer":
            raise SystemExit("share response did not enforce Referrer-Policy: no-referrer")
        if path.startswith("/relay-artifacts/"):
            assert response.headers.get('Content-Security-Policy') == "sandbox; default-src 'none'; frame-ancestors 'none'"
            assert response.headers.get('X-Content-Type-Options') == 'nosniff'
            assert response.headers.get('Referrer-Policy') == 'no-referrer'

for path in ["/health/live", "/.well-known/unapproved"]:
    try:
        urlopen("http://relay-proxy:8080" + path, timeout=5)
        raise SystemExit("private/unknown route should return 404")
    except HTTPError as error:
        assert error.code == 404

headers = "content-type,content-md5,if-none-match,x-amz-checksum-sha256,x-amz-meta-relay-upload-id,x-amz-meta-relay-sha256"
for origin, requested, expected in [
    ("https://relay.zaftech.co", headers, 204),
    ("https://untrusted.example", headers, 403),
    ("https://relay.zaftech.co", "authorization", 403),
]:
    request = Request("http://relay-proxy:8080/relay-artifacts/probe", method="OPTIONS", headers={
        "Origin": origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": requested,
    })
    try:
        with urlopen(request, timeout=5) as response:
            assert response.status == expected
            assert response.headers['Access-Control-Allow-Origin'] == origin
            allowed = {value.strip() for value in response.headers['Access-Control-Allow-Headers'].split(',')}
            assert set(headers.split(',')) == allowed
    except HTTPError as error:
        assert error.code == expected
PY

server_script=$(host_path "$temp_dir/server.py")
client_script=$(host_path "$temp_dir/client.py")
python3 "$SCRIPT_DIR/render-nginx-test.py" "$temp_dir/nginx-bootstrap.conf"
bootstrap_config=$(host_path "$temp_dir/nginx-bootstrap.conf")

MSYS_NO_PATHCONV=1 docker network create "$network" >/dev/null
MSYS_NO_PATHCONV=1 docker run -d --pull never --name "$api_container" \
  --network "$network" --network-alias relay-api --network-alias minio \
  -e ROLE=api -e PORT=8000 -v "$server_script:/srv/server.py:ro" \
  "$python_image" python /srv/server.py >/dev/null
MSYS_NO_PATHCONV=1 docker run -d --pull never --name "$web_container" \
  --network "$network" --network-alias relay-web \
  -e ROLE=web -e PORT=8080 -v "$server_script:/srv/server.py:ro" \
  "$python_image" python /srv/server.py >/dev/null
MSYS_NO_PATHCONV=1 docker run -d --pull never --name "$nginx_container" \
  --network "$network" --network-alias relay-proxy \
  -v "$bootstrap_config:/etc/nginx/nginx-bootstrap.conf:ro" \
  "$nginx_image" nginx -g 'daemon off;' -c /etc/nginx/nginx-bootstrap.conf \
  >/dev/null

passed=false
for _attempt in {1..20}; do
  if MSYS_NO_PATHCONV=1 docker run --rm --pull never --network "$network" \
    -v "$client_script:/tests/client.py:ro" \
    "$python_image" python /tests/client.py >/dev/null 2>&1; then
    passed=true
    break
  fi
  sleep 0.25
done
[[ $passed == true ]] || {
  MSYS_NO_PATHCONV=1 docker logs "$nginx_container" >&2 || true
  echo "Nginx routing integration test did not become ready" >&2
  exit 1
}

nginx_logs=$(MSYS_NO_PATHCONV=1 docker logs "$nginx_container" 2>&1)
[[ $nginx_logs == *'"GET /version"'* ]] || {
  echo "Nginx routing test did not observe ordinary access logging" >&2
  exit 1
}
[[ $nginx_logs != *test-share-token* ]] || {
  echo "Nginx access logs exposed a share token" >&2
  exit 1
}
[[ $nginx_logs != *X-Amz-Signature* ]] || {
  echo "Nginx access logs exposed a signed artifact URL" >&2
  exit 1
}

echo "Nginx runtime routing and share-token privacy tests passed."
