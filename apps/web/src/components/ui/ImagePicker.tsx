import { useId, useState } from "react";
import { Button } from "./Button";
import { Disclosure } from "./Disclosure";
import "./image-picker.css";

export function ImagePicker({ label, value, onChange, onBusyChange, disabled = false }: {
  label: string;
  value: string | null;
  onChange(value: string | null): void;
  disabled?: boolean;
  onBusyChange?(busy: boolean): void;
}) {
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState<string | null>(null);
  const previewSource = value?.startsWith("https://") || value?.startsWith("data:image/")
    ? value
    : null;
  async function choose(file: File) {
    setError("");
    setBusy(true);
    onBusyChange?.(true);
    let bitmap: ImageBitmap | undefined;
    try {
      if (
        !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
        file.size > 8_000_000
      ) throw new Error("Choose a PNG, JPEG or WebP image smaller than 8 MB.");
      bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 256;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Photo editing is unavailable in this browser.");
      }
      const size = Math.min(bitmap.width, bitmap.height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, 256, 256);
      ctx.drawImage(
        bitmap,
        (bitmap.width - size) / 2,
        (bitmap.height - size) / 2,
        size,
        size,
        0,
        0,
        256,
        256,
      );
      const result = canvas.toDataURL("image/jpeg", 0.82);
      if (result.length > 65_536) {
        throw new Error("Choose a smaller or simpler image.");
      }
      onChange(result);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Couldn’t read this image. Try another file.",
      );
    } finally {
      bitmap?.close();
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <div className="image-picker">
      <div className="image-picker__row">
        <span className="image-picker__preview">
          {previewSource && failed !== previewSource
            ? (
              <img
                src={previewSource}
                alt={label + " preview"}
                referrerPolicy="no-referrer"
                onError={() => setFailed(previewSource)}
              />
            )
            : <span aria-hidden="true">{label[0]}</span>}
        </span>
        <div>
          <label className="image-picker__upload" htmlFor={id}>
            {busy ? "Preparing image…" : "Choose image"}
          </label>
          <input
            id={id}
            type="file"
            aria-label={label}
            accept="image/png,image/jpeg,image/webp"
            disabled={disabled || busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void choose(file);
              event.target.value = "";
            }}
          />
          <p>PNG, JPEG or WebP. Cropped to a square.</p>
          {value
            ? (
              <Button
                variant="quiet"
                disabled={disabled || busy}
                onClick={() => onChange(null)}
              >
                Remove image
              </Button>
            )
            : null}
        </div>
      </div>
      <Disclosure title="Use an image URL">
        <label className="form-field">
          <span className="form-field__label">{label} URL</span>
          <input
            className="input"
            type="url"
            placeholder="https://…"
            value={value?.startsWith("data:") ? "" : value ?? ""}
            disabled={disabled || busy}
            onChange={(event) => {
              setFailed(null);
              onChange(event.target.value || null);
            }}
          />
        </label>
        <p>The image stays hosted at this address.</p>
      </Disclosure>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
