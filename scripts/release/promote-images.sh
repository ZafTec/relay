#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: promote-images.sh --phase immutable|latest \
  --version X.Y.Z --revision <full-sha> \
  --backend-repository namespace/name --backend-candidate namespace/name:candidate-ID \
  --backend-digest sha256:<64-hex> \
  --web-repository namespace/name --web-candidate namespace/name:candidate-ID \
  --web-digest sha256:<64-hex>
EOF
  exit 2
}

PHASE=""
VERSION=""
REVISION=""
BACKEND_REPOSITORY=""
BACKEND_CANDIDATE=""
BACKEND_DIGEST=""
WEB_REPOSITORY=""
WEB_CANDIDATE=""
WEB_DIGEST=""

while (($# > 0)); do
  (($# >= 2)) || usage
  case "$1" in
    --phase) PHASE=$2 ;;
    --version) VERSION=$2 ;;
    --revision) REVISION=$2 ;;
    --backend-repository) BACKEND_REPOSITORY=$2 ;;
    --backend-candidate) BACKEND_CANDIDATE=$2 ;;
    --backend-digest) BACKEND_DIGEST=$2 ;;
    --web-repository) WEB_REPOSITORY=$2 ;;
    --web-candidate) WEB_CANDIDATE=$2 ;;
    --web-digest) WEB_DIGEST=$2 ;;
    *) usage ;;
  esac
  shift 2
done

[[ $PHASE == "immutable" || $PHASE == "latest" ]] || usage
[[ $VERSION =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || usage
[[ $REVISION =~ ^[0-9a-f]{40}$ && ! $REVISION =~ ^0+$ ]] || usage
[[ $BACKEND_REPOSITORY =~ ^[a-z0-9._-]+/[a-z0-9._-]+$ ]] || usage
[[ $WEB_REPOSITORY =~ ^[a-z0-9._-]+/[a-z0-9._-]+$ ]] || usage
[[ $BACKEND_CANDIDATE =~ ^${BACKEND_REPOSITORY}:candidate-[1-9][0-9]*$ ]] || usage
[[ $WEB_CANDIDATE =~ ^${WEB_REPOSITORY}:candidate-[1-9][0-9]*$ ]] || usage
[[ $BACKEND_DIGEST =~ ^sha256:[0-9a-f]{64}$ && ! $BACKEND_DIGEST =~ ^sha256:0+$ ]] || usage
[[ $WEB_DIGEST =~ ^sha256:[0-9a-f]{64}$ && ! $WEB_DIGEST =~ ^sha256:0+$ ]] || usage

INSPECT_ERROR=$(mktemp)
trap 'rm -f "$INSPECT_ERROR"' EXIT

inspect_digest() {
  local reference=$1
  local output
  : > "$INSPECT_ERROR"
  if output=$(docker buildx imagetools inspect "$reference" --format '{{.Manifest.Digest}}' 2>"$INSPECT_ERROR"); then
    if [[ ! $output =~ ^sha256:[0-9a-f]{64}$ ]]; then
      echo "Registry returned an invalid digest for $reference" >&2
      return 2
    fi
    printf '%s\n' "$output"
    return 0
  fi

  local classification
  classification=$(deno run --allow-read scripts/release/validate.ts registry-error \
    --reference "$reference" --error-file "$INSPECT_ERROR")
  if [[ $classification == "missing" ]]; then
    return 1
  fi

  echo "Unable to inspect $reference; refusing to treat an authorization or transport failure as a missing tag." >&2
  cat "$INSPECT_ERROR" >&2
  return 2
}

require_digest() {
  local reference=$1
  local expected=$2
  local actual status
  if actual=$(inspect_digest "$reference"); then
    :
  else
    status=$?
    if [[ $status -eq 1 ]]; then
      echo "Required OCI reference does not exist: $reference" >&2
      exit 1
    fi
    exit "$status"
  fi
  if [[ $actual != "$expected" ]]; then
    echo "Digest mismatch for $reference: expected $expected, received $actual" >&2
    exit 1
  fi
}

classify_immutable_tag() {
  local reference=$1
  local expected=$2
  local actual
  if actual=$(inspect_digest "$reference"); then
    if [[ $actual != "$expected" ]]; then
      echo "Immutable tag conflict for $reference: expected $expected, received $actual" >&2
      exit 1
    fi
    printf 'present\n'
    return
  else
    local status=$?
    if [[ $status -ne 1 ]]; then
      exit "$status"
    fi
  fi
  printf 'missing\n'
}

promote_immutable_tag() {
  local target=$1
  local source=$2
  local digest=$3
  local state=$4
  if [[ $state == "missing" ]]; then
    docker buildx imagetools create --tag "$target" "$source@$digest"
  else
    echo "Immutable tag already has the verified digest: $target"
  fi
  require_digest "$target" "$digest"
}

classify_moving_tag() {
  local reference=$1
  local expected=$2
  local actual
  if actual=$(inspect_digest "$reference"); then
    if [[ $actual == "$expected" ]]; then
      printf 'present\n'
    else
      printf 'move\n'
    fi
    return
  else
    local status=$?
    if [[ $status -ne 1 ]]; then
      exit "$status"
    fi
  fi
  printf 'move\n'
}

promote_latest_tag() {
  local target=$1
  local source=$2
  local digest=$3
  local state=$4
  if [[ $state == "move" ]]; then
    docker buildx imagetools create --tag "$target" "$source@$digest"
  else
    echo "Moving tag already has the verified digest: $target"
  fi
  require_digest "$target" "$digest"
}

require_digest "$BACKEND_CANDIDATE" "$BACKEND_DIGEST"
require_digest "$WEB_CANDIDATE" "$WEB_DIGEST"

BACKEND_SEMVER="$BACKEND_REPOSITORY:$VERSION"
BACKEND_REVISION="$BACKEND_REPOSITORY:git-$REVISION"
WEB_SEMVER="$WEB_REPOSITORY:$VERSION"
WEB_REVISION="$WEB_REPOSITORY:git-$REVISION"

if [[ $PHASE == "immutable" ]]; then
  # Classify every immutable destination before writing any destination. A
  # retry resumes missing promotions, but any conflicting tag fails closed.
  BACKEND_SEMVER_STATE=$(classify_immutable_tag "$BACKEND_SEMVER" "$BACKEND_DIGEST")
  BACKEND_REVISION_STATE=$(classify_immutable_tag "$BACKEND_REVISION" "$BACKEND_DIGEST")
  WEB_SEMVER_STATE=$(classify_immutable_tag "$WEB_SEMVER" "$WEB_DIGEST")
  WEB_REVISION_STATE=$(classify_immutable_tag "$WEB_REVISION" "$WEB_DIGEST")

  promote_immutable_tag "$BACKEND_SEMVER" "$BACKEND_CANDIDATE" "$BACKEND_DIGEST" "$BACKEND_SEMVER_STATE"
  promote_immutable_tag "$BACKEND_REVISION" "$BACKEND_CANDIDATE" "$BACKEND_DIGEST" "$BACKEND_REVISION_STATE"
  promote_immutable_tag "$WEB_SEMVER" "$WEB_CANDIDATE" "$WEB_DIGEST" "$WEB_SEMVER_STATE"
  promote_immutable_tag "$WEB_REVISION" "$WEB_CANDIDATE" "$WEB_DIGEST" "$WEB_REVISION_STATE"
else
  # `latest` is a separate final phase. Verify all immutable publication first,
  # then inspect both moving destinations before changing either one.
  require_digest "$BACKEND_SEMVER" "$BACKEND_DIGEST"
  require_digest "$BACKEND_REVISION" "$BACKEND_DIGEST"
  require_digest "$WEB_SEMVER" "$WEB_DIGEST"
  require_digest "$WEB_REVISION" "$WEB_DIGEST"

  BACKEND_LATEST_STATE=$(classify_moving_tag "$BACKEND_REPOSITORY:latest" "$BACKEND_DIGEST")
  WEB_LATEST_STATE=$(classify_moving_tag "$WEB_REPOSITORY:latest" "$WEB_DIGEST")
  promote_latest_tag "$BACKEND_REPOSITORY:latest" "$BACKEND_CANDIDATE" "$BACKEND_DIGEST" "$BACKEND_LATEST_STATE"
  promote_latest_tag "$WEB_REPOSITORY:latest" "$WEB_CANDIDATE" "$WEB_DIGEST" "$WEB_LATEST_STATE"
fi
