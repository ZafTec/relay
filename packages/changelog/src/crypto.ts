const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

export class GovernanceIdempotencyConflictError extends Error {
  override readonly name = "GovernanceIdempotencyConflictError";

  constructor() {
    super("Governance idempotency key was reused for a different mutation");
  }
}

export function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new TypeError(
      "idempotencyKey must be 16-128 URL-safe characters",
    );
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError("Mutation payload must be JSON-serializable");
    }
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${
    entries.map(([key, item]) =>
      `${JSON.stringify(key)}:${canonicalJson(item)}`
    ).join(",")
  }}`;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface MutationArtifacts {
  readonly keyHash: string;
  readonly requestFingerprint: string;
}

export async function createMutationArtifacts(
  operation: string,
  idempotencyKey: string,
  payload: unknown,
): Promise<MutationArtifacts> {
  assertIdempotencyKey(idempotencyKey);
  const keyHash = await sha256Hex(
    `relay-governance-idempotency:v1\0${idempotencyKey}`,
  );
  const requestFingerprint = await sha256Hex(canonicalJson({
    operation,
    payload,
  }));
  return { keyHash, requestFingerprint };
}
