#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPOSITORY_ROOT=$(cd -- "$SCRIPT_DIR/../.." && pwd)
cd "$REPOSITORY_ROOT"

readonly ACTIONLINT_IMAGE='docker.io/rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667'

fail() {
  echo "release CI validation failed: $*" >&2
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

for command in bash docker find sort; do
  require_command "$command"
done
require_pinned_image "$ACTIONLINT_IMAGE"

mapfile -d '' shell_scripts < <(
  find scripts/release -type f -name '*.sh' -print0 | sort -z
)
((${#shell_scripts[@]} > 0)) || fail "no release shell scripts were found"
for script in "${shell_scripts[@]}"; do
  bash -n -- "$script"
done

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

echo "Release and workflow validations passed."
