/**
 * Public-facing IDs (anything that can appear in a URL, an MCP tool
 * result, or a share link) are a short prefix plus random hex, not a raw
 * UUID -- e.g. `run_4f9a2c1e8b3d4a90`. Purely internal rows (job attempts,
 * capacity leases, outbox events) use ordinary bigint identity columns
 * instead; there is no reason to make those opaque or short.
 */
const ID_BYTE_LENGTH = 16;

export function generatePublicId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_BYTE_LENGTH));
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${hex}`;
}

export const ID_PREFIXES = {
  toolRun: "run",
  artifact: "art",
  outputSet: "out",
  shareLink: "shr",
  capacityPool: "pool",
} as const;

export type IdPrefix = typeof ID_PREFIXES[keyof typeof ID_PREFIXES];
