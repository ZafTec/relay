#!/bin/sh
set -eu

command_name="${1:-}"
expected_service=""
case "$command_name" in
  api)
    expected_service="relay-api"
    ;;
  worker)
    expected_service="relay-worker"
    ;;
  migrate | healthcheck)
    expected_service="${OTEL_SERVICE_NAME:-}"
    ;;
esac

if [ "${OTEL_DENO:-false}" = "true" ]; then
  if [ -z "$expected_service" ]; then
    echo "OTEL_SERVICE_NAME is required for this command" >&2
    exit 78
  fi
  if [ -n "${OTEL_SERVICE_NAME:-}" ] && [ "$OTEL_SERVICE_NAME" != "$expected_service" ]; then
    echo "OTEL_SERVICE_NAME does not match the Relay process" >&2
    exit 78
  fi
  if [ ! -r /proc/sys/kernel/random/uuid ]; then
    echo "A per-process telemetry instance ID could not be generated" >&2
    exit 78
  fi

  read -r service_instance_id < /proc/sys/kernel/random/uuid
  export OTEL_SERVICE_NAME="$expected_service"
  export OTEL_RESOURCE_ATTRIBUTES="deployment.environment.name=${DEPLOYMENT_ENVIRONMENT_NAME:-production},relay.build.revision=${GIT_SHA:-unknown},service.instance.id=${service_instance_id},service.namespace=relay,service.version=${APP_VERSION:-development}"
fi

exec /app/relay "$@"
