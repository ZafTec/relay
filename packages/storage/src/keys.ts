const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{32}$/;
const ARTIFACT_VERSION_ID_PATTERN = /^aver_[0-9a-f]{32}$/;

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Keys contain no user filename or provider URL and include fresh randomness.
 * A version never reuses a prior key, even when restoring identical bytes.
 */
export function createImmutableObjectKey(input: {
  readonly artifactId: string;
  readonly artifactVersionId: string;
}): string {
  if (!ARTIFACT_ID_PATTERN.test(input.artifactId)) {
    throw new TypeError("artifactId must be a Relay artifact ID");
  }
  if (!ARTIFACT_VERSION_ID_PATTERN.test(input.artifactVersionId)) {
    throw new TypeError(
      "artifactVersionId must be a Relay artifact-version ID",
    );
  }

  return `artifacts/${input.artifactId}/${input.artifactVersionId}/${
    randomHex(24)
  }`;
}
