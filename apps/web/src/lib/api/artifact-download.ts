import { fetchJson } from "./client";

export interface ArtifactDownload {
  url: string;
  expiresAt: string;
}

export async function getArtifactDownload(
  artifactId: string,
  artifactVersionId: string,
  disposition: "inline" | "attachment",
  signal?: AbortSignal,
): Promise<ArtifactDownload> {
  const value = await fetchJson<{
    kind: string;
    artifactId: string;
    artifactVersionId: string;
    download: { method: string; url: string; expiresAt: string };
  }>(`/api/v1/artifacts/${encodeURIComponent(artifactId)}/download`, {
    method: "POST",
    signal,
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      artifactVersionId,
      contentDisposition: disposition,
      expiresInSeconds: 900,
    }),
  });
  if (
    value.kind !== "authorized" || value.artifactId !== artifactId ||
    value.artifactVersionId !== artifactVersionId ||
    value.download?.method !== "GET" ||
    !(Date.parse(value.download.expiresAt) > Date.now())
  ) throw new TypeError("File access unavailable");
  const url = new URL(value.download.url);
  if (
    !["https:", "http:"].includes(url.protocol) || url.username || url.password
  ) throw new TypeError("Invalid file URL");
  return { url: url.href, expiresAt: value.download.expiresAt };
}

/** Never read an unbounded text response, even if the saved file metadata is wrong. */
export async function readTextPreview(
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    signal,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok || !response.body) throw new Error("Preview unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) return text + decoder.decode();
      bytes += result.value.byteLength;
      if (bytes > 262_144) throw new Error("Text preview too large");
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
