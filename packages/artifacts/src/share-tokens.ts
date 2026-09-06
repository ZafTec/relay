const TOKEN_DOMAIN = new TextEncoder().encode(
  "relay.artifact-share-token:v1\0",
);
const VERSION_BYTES = 4;
const MAC_BYTES = 32;
const TOKEN_BYTES = MAC_BYTES;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_KEY_VERSION = 2_147_483_647;
const MIN_KEY_BYTES = 32;
const MAX_SHARE_LINK_ID_LENGTH = 255;

export interface ShareTokenSigningKey {
  /** Positive PostgreSQL integer stored with the share-link record. */
  readonly version: number;
  /** At least 256 bits of independently generated secret key material. */
  readonly secret: Uint8Array;
}

export interface ShareTokenCodecOptions {
  /** New tokens are signed with this version. Other configured keys verify history. */
  readonly activeVersion: number;
  readonly keys: readonly ShareTokenSigningKey[];
}

export interface IssuedShareToken {
  /** Bearer secret returned to the caller once; never persist this value. */
  readonly token: string;
  /** Lowercase SHA-256 digest suitable for durable lookup and persistence. */
  readonly tokenHash: string;
  readonly keyVersion: number;
}

export interface ShareTokenValidationInput {
  readonly token: string;
  readonly shareLinkId: string;
  /** The signing-key version persisted with the share-link record. */
  readonly keyVersion: number;
  /** The digest persisted with the share-link record. */
  readonly tokenHash: string;
}

export type ShareTokenValidationResult =
  | {
    readonly kind: "valid";
    readonly keyVersion: number;
    readonly tokenHash: string;
  }
  | { readonly kind: "invalid" };

export const SHARE_TOKEN_LENGTH = 43;

function validKeyVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_KEY_VERSION;
}

function versionBytes(version: number): Uint8Array {
  const bytes = new Uint8Array(VERSION_BYTES);
  new DataView(bytes.buffer).setUint32(0, version, false);
  return bytes;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(token: string): Uint8Array | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  try {
    const binary = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
    if (binary.length !== TOKEN_BYTES) return null;
    const bytes = Uint8Array.from(
      binary,
      (character) => character.charCodeAt(0),
    );
    return base64UrlEncode(bytes) === token ? bytes : null;
  } catch {
    return null;
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
}

function shareLinkIdBytes(value: unknown): Uint8Array | null {
  if (
    typeof value !== "string" || value.length < 1 ||
    value.length > MAX_SHARE_LINK_ID_LENGTH || value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    return null;
  }
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

function hexToFixedBytes(value: unknown): {
  readonly bytes: Uint8Array;
  readonly valid: boolean;
} {
  const bytes = new Uint8Array(MAC_BYTES);
  const valid = typeof value === "string" && SHA256_HEX_PATTERN.test(value);
  if (!valid) return { bytes, valid: false };
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return { bytes, valid: true };
}

/** Fixed-work comparison for the fixed-size digests used by this module. */
function equalDigest(left: Uint8Array, right: Uint8Array): boolean {
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < MAC_BYTES; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return new Uint8Array(digest);
}

export function isShareToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value) &&
    base64UrlDecode(value) !== null;
}

export async function hashShareToken(token: string): Promise<string> {
  if (!isShareToken(token)) {
    throw new TypeError("token has an invalid share-token format");
  }
  return bytesToHex(await sha256Bytes(token));
}

/**
 * Deterministic HMAC share-token codec with explicit key rotation.
 *
 * The token is only an HMAC and does not disclose the share-link ID. Persistence
 * should use `tokenHash` and `keyVersion`, never the token. Keeping retired keys
 * in `keys` allows old links to validate while `activeVersion` controls all new
 * issuance.
 */
export class ShareTokenCodec {
  readonly #activeVersion: number;
  readonly #keys = new Map<number, Promise<CryptoKey>>();

  constructor(options: ShareTokenCodecOptions) {
    if (options === null || typeof options !== "object") {
      throw new TypeError("share-token codec options are required");
    }
    if (!validKeyVersion(options.activeVersion)) {
      throw new TypeError(
        "activeVersion must be a positive PostgreSQL integer",
      );
    }
    if (!Array.isArray(options.keys) || options.keys.length === 0) {
      throw new TypeError("at least one share-token signing key is required");
    }

    for (const candidate of options.keys) {
      if (!validKeyVersion(candidate?.version)) {
        throw new TypeError(
          "share-token key version must be a positive PostgreSQL integer",
        );
      }
      if (!(candidate.secret instanceof Uint8Array)) {
        throw new TypeError("share-token key secret must be a Uint8Array");
      }
      if (candidate.secret.byteLength < MIN_KEY_BYTES) {
        throw new TypeError("share-token keys must contain at least 32 bytes");
      }
      if (this.#keys.has(candidate.version)) {
        throw new TypeError("share-token key versions must be unique");
      }
      const secret = Uint8Array.from(candidate.secret);
      this.#keys.set(
        candidate.version,
        crypto.subtle.importKey(
          "raw",
          secret,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
      );
    }
    if (!this.#keys.has(options.activeVersion)) {
      throw new TypeError("activeVersion must identify a configured key");
    }
    this.#activeVersion = options.activeVersion;
  }

  get activeVersion(): number {
    return this.#activeVersion;
  }

  /** Versions retained in memory; secret key material is never exposed. */
  get keyVersions(): readonly number[] {
    return Object.freeze(
      [...this.#keys.keys()].sort((left, right) => left - right),
    );
  }

  #message(version: number, shareLinkId: string): Uint8Array {
    const id = shareLinkIdBytes(shareLinkId);
    if (id === null) throw new TypeError("shareLinkId has an invalid format");
    return concatBytes(TOKEN_DOMAIN, versionBytes(version), id);
  }

  hasVersion(version: number): boolean {
    return validKeyVersion(version) && this.#keys.has(version);
  }

  async issue(shareLinkId: string): Promise<IssuedShareToken> {
    return await this.issueForVersion(shareLinkId, this.#activeVersion);
  }

  /** Re-issues a deterministic token with the key version stored on its link. */
  async issueForVersion(
    shareLinkId: string,
    version: number,
  ): Promise<IssuedShareToken> {
    if (!validKeyVersion(version)) {
      throw new TypeError(
        "version must be a positive PostgreSQL integer",
      );
    }
    const keyPromise = this.#keys.get(version);
    if (keyPromise === undefined) {
      throw new TypeError("version must identify a configured key");
    }
    const key = await keyPromise;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        ownedBuffer(this.#message(version, shareLinkId)),
      ),
    );
    const token = base64UrlEncode(signature);
    return Object.freeze({
      token,
      tokenHash: bytesToHex(await sha256Bytes(token)),
      keyVersion: version,
    });
  }

  /**
   * Verifies both the persisted digest and the HMAC without data-dependent
   * digest comparisons. Invalid attacker-controlled values return `invalid`
   * rather than exposing parse or key-selection details.
   */
  async validate(
    input: ShareTokenValidationInput,
  ): Promise<ShareTokenValidationResult> {
    const rawToken =
      typeof input?.token === "string" && input.token.length <= 256
        ? input.token
        : "";
    const decoded = base64UrlDecode(rawToken);
    const mac = decoded ?? new Uint8Array(TOKEN_BYTES);
    const keyVersionValid = validKeyVersion(input?.keyVersion);
    const requestedVersion = keyVersionValid
      ? input.keyVersion
      : this.#activeVersion;
    const selectedKey = this.#keys.get(requestedVersion);
    const key = await (selectedKey ?? this.#keys.get(this.#activeVersion)!);
    const id = shareLinkIdBytes(input?.shareLinkId);
    const message = concatBytes(
      TOKEN_DOMAIN,
      versionBytes(requestedVersion),
      id ?? new Uint8Array(),
    );

    const [macValid, candidateHash] = await Promise.all([
      crypto.subtle.verify(
        "HMAC",
        key,
        ownedBuffer(mac),
        ownedBuffer(message),
      ),
      sha256Bytes(rawToken),
    ]);
    const expectedHash = hexToFixedBytes(input?.tokenHash);
    const hashValid = equalDigest(candidateHash, expectedHash.bytes);

    if (
      decoded === null || !keyVersionValid || selectedKey === undefined ||
      id === null || !expectedHash.valid || !macValid || !hashValid
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "valid",
      keyVersion: requestedVersion,
      tokenHash: bytesToHex(candidateHash),
    };
  }
}

export function createShareTokenCodec(
  options: ShareTokenCodecOptions,
): ShareTokenCodec {
  return new ShareTokenCodec(options);
}
