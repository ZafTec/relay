#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPOSITORY_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"

readonly ACTIONLINT_IMAGE='docker.io/rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667'
readonly NGINX_TEST_IMAGE='docker.io/nginxinc/nginx-unprivileged:1.31.4-alpine@sha256:901e944d1f4fc2bd077e8f5568b98c1f6f8cdacf6b97a87747c43134a339b9a7'
readonly PYTHON_TEST_IMAGE='docker.io/library/python:3.13.7-alpine3.22@sha256:9ba6d8cbebf0fb6546ae71f2a1c14f6ffd2fdab83af7fa5669734ef30ad48844'

fail() {
  echo "release/deploy CI validation failed: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_pinned_image() {
  [[ $1 =~ @sha256:[0-9a-f]{64}$ ]] || fail "container image is not digest-pinned: $1"
}

host_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

for command in bash docker find jq sort; do
  require_command "$command"
done
for image in "$ACTIONLINT_IMAGE" "$NGINX_TEST_IMAGE" "$PYTHON_TEST_IMAGE"; do
  require_pinned_image "$image"
done

mapfile -d '' shell_scripts < <(
  find deploy scripts/release -type f -name '*.sh' -print0 | sort -z
)
((${#shell_scripts[@]} > 0)) || fail "no release/deploy shell scripts were found"
bash -n -- "${shell_scripts[@]}"

docker pull "$ACTIONLINT_IMAGE"
repository_mount=$(host_path "$REPOSITORY_ROOT")
MSYS_NO_PATHCONV=1 docker run --rm --pull never \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --volume "$repository_mount:/repo:ro" \
  --workdir /repo \
  "$ACTIONLINT_IMAGE" \
  -no-color \
  -ignore 'unexpected key "queue" for "concurrency" section\. expected one of "cancel-in-progress", "group"'

for image in "$NGINX_TEST_IMAGE" "$PYTHON_TEST_IMAGE"; do
  docker pull "$image"
done
export NGINX_TEST_IMAGE PYTHON_TEST_IMAGE
bash deploy/tests/validate-deploy.sh

echo "Release, workflow, and deployment validations passed."
