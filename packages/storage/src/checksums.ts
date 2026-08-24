import { createHash } from "node:crypto";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer,
  );
  return bytesToHex(new Uint8Array(digest));
}

export function md5Base64(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

export interface StreamChecksums {
  readonly sha256Hex: string;
  readonly contentMd5: string;
  readonly sizeBytes: number;
}

/** Consumes a stream once while calculating Relay's durable provenance. */
export async function checksumStream(
  stream: ReadableStream<Uint8Array>,
): Promise<StreamChecksums> {
  const sha256 = createHash("sha256");
  const md5 = createHash("md5");
  const reader = stream.getReader();
  let sizeBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sizeBytes += value.byteLength;
      sha256.update(value);
      md5.update(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    sha256Hex: sha256.digest("hex"),
    contentMd5: md5.digest("base64"),
    sizeBytes,
  };
}
