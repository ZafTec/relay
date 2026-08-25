import { isIP } from "node:net";

export const RELAY_CLIENT_IP_HEADER = "x-relay-client-ip";

const UNTRUSTED_FORWARDING_HEADERS = [
  "cf-connecting-ip",
  "forwarded",
  "true-client-ip",
  "x-client-ip",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
  RELAY_CLIENT_IP_HEADER,
] as const;

interface ParsedNetwork {
  readonly bytes: Uint8Array;
  readonly prefixLength: number;
}

export interface AuthConnectionInfo {
  /** Immediate TCP peer reported by the HTTP runtime, never by a header. */
  readonly remoteAddress?: string;
  /** Exact proxy addresses or CIDRs allowed to contribute forwarding data. */
  readonly trustedProxyCidrs?: readonly string[];
}

export function parseTrustedProxyCidrs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];

  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const invalid = entries.filter((entry) => parseNetwork(entry) === null);
  if (invalid.length > 0) {
    throw new Error(
      `AUTH_TRUSTED_PROXY_CIDRS contains invalid IP/CIDR entries: ${
        invalid.join(", ")
      }`,
    );
  }
  return entries;
}

/**
 * Removes all caller-controlled forwarding headers and injects one private
 * header derived from the runtime's immediate peer plus an explicit proxy
 * allowlist. Better Auth trusts only this normalized header.
 */
export function prepareAuthRequest(
  request: Request,
  connection: AuthConnectionInfo = {},
): Request {
  const headers = new Headers(request.headers);
  const forwardedFor = headers.get("x-forwarded-for");
  for (const header of UNTRUSTED_FORWARDING_HEADERS) headers.delete(header);

  const clientIp = resolveClientIp(
    connection.remoteAddress,
    forwardedFor,
    connection.trustedProxyCidrs ?? [],
  );
  if (clientIp !== null) headers.set(RELAY_CLIENT_IP_HEADER, clientIp);

  return new Request(request, { headers });
}

export function resolveClientIp(
  remoteAddress: string | undefined,
  forwardedFor: string | null,
  trustedProxyCidrs: readonly string[],
): string | null {
  const peer = parseAddress(remoteAddress);
  if (peer === null) return null;
  if (!isTrusted(peer, trustedProxyCidrs)) return peer.normalized;
  if (forwardedFor === null || forwardedFor.trim() === "") {
    return peer.normalized;
  }

  const forwarded = forwardedFor.split(",").map((entry) => parseAddress(entry));
  if (forwarded.some((entry) => entry === null)) return peer.normalized;

  for (let index = forwarded.length - 1; index >= 0; index -= 1) {
    const candidate = forwarded[index]!;
    if (!isTrusted(candidate, trustedProxyCidrs)) return candidate.normalized;
  }

  // An all-trusted chain has no provable client hop; use the immediate peer
  // rather than accepting a caller-selected value or collapsing all traffic
  // into Better Auth's global no-IP bucket.
  return peer.normalized;
}

interface ParsedAddress {
  readonly normalized: string;
  readonly bytes: Uint8Array;
}

function isTrusted(
  address: ParsedAddress,
  trustedProxyCidrs: readonly string[],
): boolean {
  return trustedProxyCidrs.some((entry) => {
    const network = parseNetwork(entry);
    return network !== null && matchesNetwork(address.bytes, network);
  });
}

function parseNetwork(value: string): ParsedNetwork | null {
  const [rawAddress, rawPrefix, ...extra] = value.trim().split("/");
  if (extra.length > 0 || rawAddress === undefined) return null;
  const address = parseAddress(rawAddress);
  if (address === null) return null;

  const bitLength = address.bytes.length * 8;
  const prefixLength = rawPrefix === undefined ? bitLength : Number(rawPrefix);
  if (
    !Number.isInteger(prefixLength) || prefixLength < 0 ||
    prefixLength > bitLength
  ) {
    return null;
  }
  return { bytes: address.bytes, prefixLength };
}

function parseAddress(value: string | undefined): ParsedAddress | null {
  if (value === undefined) return null;
  const withoutZone = value.trim().replace(/^\[|\]$/g, "").split("%")[0];
  const version = isIP(withoutZone);
  if (version === 4) {
    return {
      normalized: withoutZone,
      bytes: Uint8Array.from(withoutZone.split(".").map(Number)),
    };
  }
  if (version !== 6) return null;

  const groups = expandIpv6(withoutZone);
  if (groups === null) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = group >> 8;
    bytes[index * 2 + 1] = group & 0xff;
  });

  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff && bytes[11] === 0xff
  ) {
    const ipv4Bytes = bytes.slice(12);
    return {
      normalized: Array.from(ipv4Bytes).join("."),
      bytes: ipv4Bytes,
    };
  }

  return { normalized: withoutZone.toLowerCase(), bytes };
}

function expandIpv6(value: string): number[] | null {
  let normalized = value.toLowerCase();
  const ipv4Tail = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const octets = ipv4Tail.split(".").map(Number);
    normalized = normalized.slice(0, -ipv4Tail.length) +
      `${((octets[0] << 8) | octets[1]).toString(16)}:` +
      `${((octets[2] << 8) | octets[3]).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;

  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ].map((part) => Number.parseInt(part, 16));
  return groups.length === 8 && groups.every((part) => Number.isInteger(part))
    ? groups
    : null;
}

function matchesNetwork(address: Uint8Array, network: ParsedNetwork): boolean {
  if (address.length !== network.bytes.length) return false;
  const wholeBytes = Math.floor(network.prefixLength / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== network.bytes[index]) return false;
  }

  const remainingBits = network.prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (address[wholeBytes] & mask) === (network.bytes[wholeBytes] & mask);
}
