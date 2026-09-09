import { type FormEvent, useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/Button";
import { ApiError, fetchJson } from "../../lib/api/client";

export function ImportUrlForm(
  { onBusy, onCompleted, onAuthExpired }: {
    onBusy(busy: boolean): void;
    onCompleted(artifactId: string, versionId: string): void;
    onAuthExpired(): void;
  },
) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef<{ body: string; key: string } | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    let source: URL;
    try {
      source = new URL(url);
      if (
        !["https:", "http:"].includes(source.protocol) || source.username ||
        source.password
      ) throw new Error();
    } catch {
      setError("Enter a complete HTTP or HTTPS file URL.");
      return;
    }
    const body = JSON.stringify({
      url: source.href,
      ...(name.trim() ? { name: name.trim() } : {}),
    });
    if (operation.current?.body !== body) {
      operation.current = { body, key: crypto.randomUUID() };
    }
    controller.current = new AbortController();
    const signal = controller.current.signal;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const result = await fetchJson<
        { kind: string; artifactId: string; artifactVersionId: string }
      >("/api/v1/artifacts/import", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "idempotency-key": operation.current.key,
        },
        body,
      });
      if (
        result.kind !== "authorized" ||
        !/^art_[a-f0-9]{32}$/.test(result.artifactId) ||
        !/^aver_[a-f0-9]{32}$/.test(result.artifactVersionId)
      ) throw new Error();
      if (!signal.aborted) {
        onCompleted(result.artifactId, result.artifactVersionId);
      }
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof ApiError && error.status === 401) onAuthExpired();
        else {setError(
            error instanceof ApiError && error.status < 500
              ? error.message
              : "Couldn’t confirm the import. Retry with the same URL and name to avoid creating a duplicate.",
          );}
      }
    } finally {
      if (!signal.aborted) {
        setBusy(false);
        onBusy(false);
      }
    }
  }
  return (
    <form
      className="artifact-import-form"
      onSubmit={(event) => void submit(event)}
    >
      <p>
        Import a public file up to 20 MB. Relay saves a copy in this workspace.
      </p>
      <label className="form-field">
        <span className="form-field__label">File URL</span>
        <input
          className="input"
          type="url"
          required
          maxLength={4096}
          autoFocus
          value={url}
          disabled={busy}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/file.png"
        />
      </label>
      <label className="form-field">
        <span className="form-field__label">File name (optional)</span>
        <input
          className="input"
          maxLength={255}
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" pending={busy} pendingLabel="Importing file…">
        Import file
      </Button>
    </form>
  );
}
