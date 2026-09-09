import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const MAX_URL_IMPORT_BYTES = 20_000_000;
export class RemoteContentError extends Error {
  override readonly name = "RemoteContentError";
  constructor() {
    super(
      "Use a public HTTP or HTTPS file URL, up to 20 MB. The file must be available without signing in.",
    );
  }
}
const privateAddresses = new BlockList();
for (
  const [address, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const
) privateAddresses.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (
  const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], [
    "2002::",
    16,
  ], ["3fff::", 20]] as const
) privateAddresses.addSubnet(address, prefix, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4
    ? !privateAddresses.check(address, "ipv4")
    : family === 6 && !address.includes("%") &&
      globalV6.check(address, "ipv6") &&
      !privateAddresses.check(address, "ipv6");
}
export function publicFileUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteContentError();
  }
  if (
    raw.length > 4096 || !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.hash ||
    (url.port && url.port !== "80" && url.port !== "443")
  ) throw new RemoteContentError();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !isPublicAddress(host)) throw new RemoteContentError();
  return url;
}
interface Address {
  address: string;
  family: number;
}
interface RemoteResponse {
  status: number;
  type?: string;
  location?: string;
  length?: string;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
export interface RemoteContentDependencies {
  resolve(host: string): Promise<Address[]>;
  request(
    url: URL,
    address: Address,
    signal: AbortSignal,
  ): Promise<RemoteResponse>;
}
const defaults: RemoteContentDependencies = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  request: (url, address, signal) =>
    new Promise((resolve, reject) => {
      const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
        url,
        {
          method: "GET",
          agent: false,
          signal,
          family: address.family,
          // Pin the socket to the validated address; TLS still verifies the URL's hostname.
          lookup: (_host, _options, callback) =>
            callback(null, address.address, address.family),
          headers: {
            accept: "*/*",
            "accept-encoding": "identity",
            "user-agent": "Relay-File-Import",
          },
        },
        (response) =>
          resolve({
            status: response.statusCode ?? 0,
            type: response.headers["content-type"],
            location: response.headers.location,
            length: response.headers["content-length"],
            body: response,
            close: () => response.destroy(),
          }),
      );
      req.on("error", reject);
      req.end();
    }),
};

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new RemoteContentError());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort)
    );
  });
}

function verifiedMime(bytes: Uint8Array, header: string | undefined): string {
  const prefix = String.fromCharCode(...bytes.slice(0, 16));
  const detected = prefix.startsWith("\x89PNG\r\n\x1a\n")
    ? "image/png"
    : prefix.startsWith("\xff\xd8\xff")
    ? "image/jpeg"
    : /^GIF8[79]a/.test(prefix)
    ? "image/gif"
    : prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP"
    ? "image/webp"
    : prefix.startsWith("%PDF-")
    ? "application/pdf"
    : undefined;
  const declared = header?.split(";")[0].trim().toLowerCase();
  if (declared && !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(declared)) {
    throw new RemoteContentError();
  }
  if (
    declared &&
    ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]
      .includes(declared) &&
    declared !== detected
  ) throw new RemoteContentError();
  const mime = detected ?? declared ?? "application/octet-stream";
  if (mime.startsWith("text/") || mime === "application/json") {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (mime === "application/json") JSON.parse(text);
  }
  return mime;
}

export async function fetchRemoteContent(
  raw: string,
  dependencies = defaults,
): Promise<{ bytes: Uint8Array; mimeType: string; name: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    let url = publicFileUrl(raw);
    for (let redirect = 0; redirect <= 3; redirect++) {
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const addresses = isIP(host)
        ? [{ address: host, family: isIP(host) }]
        : await abortable(dependencies.resolve(host), controller.signal);
      if (
        !addresses.length ||
        addresses.some((item) => !isPublicAddress(item.address))
      ) throw new RemoteContentError();
      const response = await abortable(
        dependencies.request(url, addresses[0], controller.signal),
        controller.signal,
      );
      try {
        if (
          [301, 302, 303, 307, 308].includes(response.status) &&
          response.location && redirect < 3
        ) {
          url = publicFileUrl(new URL(response.location, url).href);
          continue;
        }
        if (
          response.status !== 200 ||
          (response.length !== undefined &&
            (!/^\d+$/.test(response.length) ||
              Number(response.length) > MAX_URL_IMPORT_BYTES))
        ) throw new RemoteContentError();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for await (const chunk of response.body) {
          total += chunk.byteLength;
          if (total > MAX_URL_IMPORT_BYTES || controller.signal.aborted) {
            throw new RemoteContentError();
          }
          chunks.push(chunk);
        }
        if (
          response.length !== undefined && Number(response.length) !== total
        ) throw new RemoteContentError();
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const name =
          decodeURIComponent(url.pathname.split("/").pop() || "Imported file")
            .replace(/[\\/]/g, "-").replace(/[^\P{C}]/gu, "").slice(0, 200) ||
          "Imported file";
        return { bytes, mimeType: verifiedMime(bytes, response.type), name };
      } finally {
        response.close();
      }
    }
    throw new RemoteContentError();
  } catch {
    throw new RemoteContentError();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
