export type FileHashInput = Blob | ArrayBuffer | ArrayBufferView | string;

export interface FileHashes {
  readonly sha256: string;
  readonly contentMd5: string;
}

const MD5_SHIFTS = Uint8Array.from([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const MD5_CONSTANTS = Uint32Array.from(
  { length: 64 },
  (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_0000_0000) >>> 0,
);

const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

async function inputBytes(input: FileHashInput): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof input === "string") {
    return Uint8Array.from(new TextEncoder().encode(input));
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  if (input instanceof ArrayBuffer) return new Uint8Array(input.slice(0));
  if (ArrayBuffer.isView(input)) {
    return Uint8Array.from(
      new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
    );
  }
  throw new TypeError("hash input must be a Blob, string, or byte buffer");
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function md5Digest(bytes: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((bytes.byteLength + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.byteLength] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, (bytes.byteLength << 3) >>> 0, true);
  view.setUint32(
    paddedLength - 4,
    Math.floor(bytes.byteLength / 0x2000_0000) >>> 0,
    true,
  );

  let stateA = 0x67452301;
  let stateB = 0xefcdab89;
  let stateC = 0x98badcfe;
  let stateD = 0x10325476;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const words = new Uint32Array(16);
    for (let index = 0; index < words.length; index += 1) {
      words[index] = view.getUint32(offset + index * 4, true);
    }

    let a = stateA;
    let b = stateB;
    let c = stateC;
    let d = stateD;

    for (let index = 0; index < 64; index += 1) {
      let mixed: number;
      let wordIndex: number;
      if (index < 16) {
        mixed = (b & c) | (~b & d);
        wordIndex = index;
      } else if (index < 32) {
        mixed = (d & b) | (~d & c);
        wordIndex = (5 * index + 1) % 16;
      } else if (index < 48) {
        mixed = b ^ c ^ d;
        wordIndex = (3 * index + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        wordIndex = (7 * index) % 16;
      }

      const previousD = d;
      d = c;
      c = b;
      const sum = (
        a
        + mixed
        + (MD5_CONSTANTS[index] ?? 0)
        + (words[wordIndex] ?? 0)
      ) >>> 0;
      b = (b + rotateLeft(sum, MD5_SHIFTS[index] ?? 0)) >>> 0;
      a = previousD;
    }

    stateA = (stateA + a) >>> 0;
    stateB = (stateB + b) >>> 0;
    stateC = (stateC + c) >>> 0;
    stateD = (stateD + d) >>> 0;
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, stateA, true);
  digestView.setUint32(4, stateB, true);
  digestView.setUint32(8, stateC, true);
  digestView.setUint32(12, stateD, true);
  return digest;
}

function base64(bytes: Uint8Array): string {
  let encoded = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const first = bytes[offset] ?? 0;
    const second = bytes[offset + 1];
    const third = bytes[offset + 2];
    const group = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += BASE64_ALPHABET[(group >>> 18) & 0x3f];
    encoded += BASE64_ALPHABET[(group >>> 12) & 0x3f];
    encoded += second === undefined ? "=" : BASE64_ALPHABET[(group >>> 6) & 0x3f];
    encoded += third === undefined ? "=" : BASE64_ALPHABET[group & 0x3f];
  }
  return encoded;
}

async function sha256Bytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error("SHA-256 is unavailable in this browser");
  }
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: FileHashInput): Promise<string> {
  return sha256Bytes(await inputBytes(input));
}

export async function md5Base64(input: FileHashInput): Promise<string> {
  return base64(md5Digest(await inputBytes(input)));
}

export async function calculateFileHashes(input: FileHashInput): Promise<FileHashes> {
  const bytes = await inputBytes(input);
  const [sha256, contentMd5] = await Promise.all([
    sha256Bytes(bytes),
    Promise.resolve(base64(md5Digest(bytes))),
  ]);
  return { sha256, contentMd5 };
}
