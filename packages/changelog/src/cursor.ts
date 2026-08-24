export interface PublicChangelogCursor {
  readonly releasedAt: string;
  readonly releaseId: string;
}

function toBase64Url(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.length > 1024) {
    throw new TypeError("Invalid changelog cursor");
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  try {
    return atob(base64 + padding);
  } catch {
    throw new TypeError("Invalid changelog cursor");
  }
}

export function encodePublicChangelogCursor(
  cursor: PublicChangelogCursor,
): string {
  const releasedAt = new Date(cursor.releasedAt);
  if (!Number.isFinite(releasedAt.getTime())) {
    throw new TypeError("Cursor releasedAt must be a valid timestamp");
  }
  if (!/^[1-9][0-9]*$/u.test(cursor.releaseId)) {
    throw new TypeError("Cursor releaseId must be a positive integer string");
  }
  return toBase64Url(JSON.stringify({
    v: 1,
    releasedAt: releasedAt.toISOString(),
    releaseId: cursor.releaseId,
  }));
}

export function decodePublicChangelogCursor(
  value: string,
): PublicChangelogCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value));
  } catch (error) {
    if (error instanceof TypeError) throw error;
    throw new TypeError("Invalid changelog cursor");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Invalid changelog cursor");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.v !== 1 || typeof record.releasedAt !== "string" ||
    typeof record.releaseId !== "string" ||
    Object.keys(record).sort().join(",") !== "releaseId,releasedAt,v"
  ) {
    throw new TypeError("Invalid changelog cursor");
  }
  const releasedAt = new Date(record.releasedAt);
  if (
    !Number.isFinite(releasedAt.getTime()) ||
    !/^[1-9][0-9]*$/u.test(record.releaseId)
  ) {
    throw new TypeError("Invalid changelog cursor");
  }
  return {
    releasedAt: releasedAt.toISOString(),
    releaseId: record.releaseId,
  };
}
