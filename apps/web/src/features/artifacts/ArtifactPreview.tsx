import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import {
  getArtifactDownload,
  readTextPreview,
} from "../../lib/api/artifact-download";
import type { ArtifactSummary } from "../../lib/api/artifacts";

export function previewKind(
  mimeType: string,
  sizeBytes: number,
): "image" | "audio" | "video" | "text" | null {
  if (/^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(mimeType)) return "image";
  if (/^audio\/(mpeg|mp4|ogg|wav|webm|flac)$/.test(mimeType)) return "audio";
  if (/^video\/(mp4|webm|ogg)$/.test(mimeType)) return "video";
  if (
    sizeBytes <= 262_144 &&
    (/^text\//.test(mimeType) ||
      ["application/json", "application/xml"].includes(mimeType))
  ) return "text";
  return null;
}

export function ArtifactPreview({ artifact, detail = false }: {
  artifact: Pick<
    ArtifactSummary,
    "id" | "name" | "mediaKind" | "currentVersion"
  >;
  detail?: boolean;
}) {
  const { workspace } = useAuth();
  const workspaceId = workspace.status === "ready"
    ? workspace.workspace.id
    : "";
  const version = artifact.currentVersion;
  const kind = version
    ? previewKind(version.mimeType, version.sizeBytes)
    : null;
  const shouldPreview = kind && (detail || kind === "image");
  const identity = `${workspaceId}:${artifact.id}:${version?.id ?? "none"}`;
  const downloadController = useRef<AbortController | null>(null);
  const [state, setState] = useState<
    { identity: string; url?: string; text?: string; failed?: boolean }
  >({ identity });
  const [retry, setRetry] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  const current = state.identity === identity ? state : { identity };

  useEffect(() => {
    const controller = new AbortController();
    setState({ identity });
    setDownloadError(false);
    setDownloading(false);
    if (shouldPreview && version) {
      void getArtifactDownload(
        artifact.id,
        version.id,
        "inline",
        controller.signal,
      ).then(async ({ url }) => {
        const text = kind === "text"
          ? await readTextPreview(url, controller.signal)
          : undefined;
        if (!controller.signal.aborted) setState({ identity, url, text });
      }).catch(() => {
        if (!controller.signal.aborted) setState({ identity, failed: true });
      });
    }
    return () => {
      controller.abort();
      downloadController.current?.abort();
    };
  }, [identity, artifact.id, version?.id, shouldPreview, kind, retry]);

  async function download() {
    if (!version || downloading) return;
    const controller = new AbortController();
    downloadController.current = controller;
    setDownloading(true);
    setDownloadError(false);
    try {
      const { url } = await getArtifactDownload(
        artifact.id,
        version.id,
        "attachment",
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const link = document.createElement("a");
      link.href = url;
      link.download = artifact.name;
      link.rel = "noopener noreferrer";
      link.referrerPolicy = "no-referrer";
      link.click();
    } catch {
      if (!controller.signal.aborted) setDownloadError(true);
    } finally {
      if (!controller.signal.aborted) setDownloading(false);
    }
  }
  const failed = () => setState({ identity, failed: true });
  return (
    <div
      className={`artifact-preview${detail ? " artifact-preview--detail" : ""}`}
    >
      <div
        className="artifact-preview__content"
        aria-busy={Boolean(shouldPreview && !current.url && !current.failed)}
      >
        {current.url && !current.failed
          ? (
            <>
              {kind === "image"
                ? (
                  <img
                    src={current.url}
                    alt={`Preview of ${artifact.name}`}
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    onError={failed}
                  />
                )
                : null}
              {kind === "audio"
                ? (
                  <audio
                    src={current.url}
                    controls
                    preload="metadata"
                    aria-label={artifact.name}
                    onError={failed}
                  />
                )
                : null}
              {kind === "video"
                ? (
                  <video
                    src={current.url}
                    controls
                    preload="metadata"
                    aria-label={artifact.name}
                    onError={failed}
                  />
                )
                : null}
              {kind === "text"
                ? (
                  <pre
                    tabIndex={0}
                    aria-label={`Preview of ${artifact.name}`}
                  >{current.text}</pre>
                )
                : null}
            </>
          )
          : (
            <div className="artifact-preview__fallback">
              <img
                src="/relay/brand/icon-artifact.svg"
                alt=""
                width="48"
                height="48"
              />
              <span>
                {!version
                  ? "No file yet"
                  : current.failed
                  ? "Preview unavailable"
                  : shouldPreview
                  ? "Loading preview…"
                  : artifact.mediaKind}
              </span>
              {detail && version && !kind
                ? <small>Download this file to view it.</small>
                : null}
            </div>
          )}
      </div>
      {detail && version
        ? (
          <div className="artifact-preview__actions">
            <Button
              variant="outline"
              onClick={() => void download()}
              disabled={downloading}
            >
              {downloading ? "Preparing download…" : "Download file"}
            </Button>
            {current.failed
              ? (
                <Button
                  variant="quiet"
                  onClick={() => setRetry((value) => value + 1)}
                >
                  Retry preview
                </Button>
              )
              : null}
            {downloadError
              ? (
                <p role="alert">
                  Couldn’t download this file. Please try again.
                </p>
              )
              : null}
          </div>
        )
        : null}
    </div>
  );
}
