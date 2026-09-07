#!/bin/sh
set -eu

COMPOSE_FILE="${COMPOSE_FILE:-compose.test.yaml}"
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-relay-ci}"
RELAY_CI_BACKEND_IMAGE="${RELAY_CI_BACKEND_IMAGE:-relay-ci-backend:local}"
RELAY_CI_TEST_IMAGE="${RELAY_CI_TEST_IMAGE:-relay-ci-tests:local}"
RELAY_CI_WEB_IMAGE="${RELAY_CI_WEB_IMAGE:-relay-ci-web:local}"
RELAY_CI_GIT_SHA="${RELAY_CI_GIT_SHA:-ci-local}"
RELAY_CI_IMAGE_CREATED="${RELAY_CI_IMAGE_CREATED:-1970-01-01T00:00:00Z}"
CI_ARTIFACT_DIR="${CI_ARTIFACT_DIR:-.ci-artifacts}"
MSYS_NO_PATHCONV=1

export COMPOSE_PROJECT_NAME
export RELAY_CI_BACKEND_IMAGE
export RELAY_CI_TEST_IMAGE
export RELAY_CI_WEB_IMAGE
export RELAY_CI_GIT_SHA
export MSYS_NO_PATHCONV

mkdir -p "$CI_ARTIFACT_DIR"

compose() {
  docker compose -f "$COMPOSE_FILE" "$@"
}

cleanup() {
  status=$?
  trap - EXIT
  compose logs --no-color > "$CI_ARTIFACT_DIR/compose.log" 2>&1 || true
  compose down --volumes --remove-orphans --timeout 30 || true
  exit "$status"
}
trap cleanup EXIT INT TERM

compose down --volumes --remove-orphans --timeout 30 >/dev/null 2>&1 || true
compose config --quiet
if compose config --format json | grep -q '"ports"'; then
  echo "compose.test.yaml must not publish host ports" >&2
  exit 1
fi

docker build \
  --target test \
  --tag "$RELAY_CI_TEST_IMAGE" \
  .
docker build \
  --build-arg APP_VERSION=0.0.0-ci \
  --build-arg GIT_SHA="$RELAY_CI_GIT_SHA" \
  --build-arg IMAGE_CREATED="$RELAY_CI_IMAGE_CREATED" \
  --tag "$RELAY_CI_BACKEND_IMAGE" \
  .
docker build \
  --build-arg APP_VERSION=0.0.0-ci \
  --build-arg GIT_SHA="$RELAY_CI_GIT_SHA" \
  --build-arg IMAGE_CREATED="$RELAY_CI_IMAGE_CREATED" \
  --tag "$RELAY_CI_WEB_IMAGE" \
  apps/web

backend_user="$(docker image inspect --format '{{.Config.User}}' "$RELAY_CI_BACKEND_IMAGE")"
web_user="$(docker image inspect --format '{{.Config.User}}' "$RELAY_CI_WEB_IMAGE")"
backend_version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$RELAY_CI_BACKEND_IMAGE")"
backend_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$RELAY_CI_BACKEND_IMAGE")"
web_version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$RELAY_CI_WEB_IMAGE")"
web_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$RELAY_CI_WEB_IMAGE")"

[ "$backend_user" = "65532:65532" ]
[ "$web_user" = "101:101" ]
[ "$backend_version" = "0.0.0-ci" ]
[ "$web_version" = "0.0.0-ci" ]
[ "$backend_revision" = "$RELAY_CI_GIT_SHA" ]
[ "$web_revision" = "$RELAY_CI_GIT_SHA" ]

docker run --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --entrypoint /bin/sh \
  "$RELAY_CI_BACKEND_IMAGE" \
  -ec 'test -x /app/relay && test ! -e /src && test ! -e /app/src && test ! -e /app/deno.json'

docker run --rm \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --tmpfs /tmp:size=16m,mode=1777 \
  --entrypoint /bin/sh \
  "$RELAY_CI_WEB_IMAGE" \
  -ec 'test -r /usr/share/nginx/html/index.html && test ! -e /src && test ! -e /usr/share/nginx/html/src && ! find /usr/share/nginx/html -type f -name "*.map" -print -quit | grep -q .'

compose up -d --wait --wait-timeout 120 postgres redis minio telemetry
compose exec -T minio mc alias set relay-ci http://127.0.0.1:9000 relay_dev_only relay_dev_only >/dev/null
compose exec -T minio mc mb --ignore-existing relay-ci/relay-artifacts >/dev/null
compose exec -T minio mc version enable relay-ci/relay-artifacts >/dev/null
compose run --rm migrate
compose run --rm migrate
compose run --rm migrate migrate status
compose run --rm backend-tests

compose up -d --wait --wait-timeout 120 api web
compose run --rm backend-probe
compose run --rm web-probe

compose up -d --wait --wait-timeout 120 worker
worker_started=false
worker_start_attempt=0
while [ "$worker_start_attempt" -lt 60 ]; do
  compose logs --no-color worker > "$CI_ARTIFACT_DIR/worker.log"
  if grep -F '"event.name":"worker.started"' "$CI_ARTIFACT_DIR/worker.log" >/dev/null; then
    worker_started=true
    break
  fi
  worker_start_attempt=$((worker_start_attempt + 1))
  sleep 1
done
[ "$worker_started" = "true" ]
compose run --rm telemetry-probe
compose stop -t 30 worker
compose logs --no-color worker > "$CI_ARTIFACT_DIR/worker.log"
grep -F '"event.name":"worker.stopped"' "$CI_ARTIFACT_DIR/worker.log" | grep -F '"outcome":"success"' >/dev/null
worker_container="$(compose ps --all --quiet worker)"
[ -n "$worker_container" ]
[ "$(docker inspect --format '{{.State.ExitCode}}' "$worker_container")" = "0" ]

echo "Container and live-infrastructure checks passed."
