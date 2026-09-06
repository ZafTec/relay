export type ArtifactMutationOperation =
  | "upload-create"
  | "upload-complete"
  | "share-create"
  | "share-revoke";

function randomIdentifier(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi === undefined) {
    throw new Error("Secure browser randomness is unavailable.");
  }
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();

  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createArtifactIdempotencyKey(operation: ArtifactMutationOperation): string {
  return `artifact-ui:${operation}:${randomIdentifier()}`;
}
