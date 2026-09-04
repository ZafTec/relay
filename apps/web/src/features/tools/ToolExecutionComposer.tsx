import {
  type FormEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { ArtifactUploadDialog } from "../artifacts";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import type {
  ArtifactSummary,
  ArtifactsAdapter,
  ArtifactVersionResource,
} from "../../lib/api/artifacts";
import type {
  CreateRunAdapterResult,
  CreateRunRequest,
  JsonObject,
  JsonValue,
  RunQueueReason,
  RunsAdapter,
} from "../../lib/api/runs";
import type { ToolDetail } from "../../lib/api/tools";

export const PRODUCTION_TOOL_KEYS = [
  "image.generate.gpt-image-2",
  "image.generate.flux-2-pro",
  "document.ocr",
] as const;

export type ProductionToolKey = typeof PRODUCTION_TOOL_KEYS[number];
export type ToolRunsAdapter = Pick<RunsAdapter, "create">;
export type ToolArtifactsAdapter = Pick<
  ArtifactsAdapter,
  "list" | "get" | "createUpload" | "putUpload" | "completeUpload"
>;

interface ToolExecutionComposerProps {
  readonly tool: ToolDetail & { readonly key: ProductionToolKey };
  readonly runsAdapter: ToolRunsAdapter;
  readonly artifactsAdapter: ToolArtifactsAdapter;
  readonly onAuthExpired: () => void;
}

interface FrozenRunOperation {
  readonly request: CreateRunRequest;
  readonly idempotencyKey: string;
}

type VisibleRunResult = Exclude<CreateRunAdapterResult, { readonly kind: "auth-expired" }>;

type SubmissionState =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting"; readonly exactRetry: boolean }
  | { readonly kind: "result"; readonly result: VisibleRunResult };

type ArtifactCatalogState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly items: readonly ArtifactSummary[];
      readonly nextCursor: string | null;
    }
  | { readonly kind: "degraded"; readonly message: string };

interface ArtifactCatalogController {
  readonly state: ArtifactCatalogState;
  readonly loadingMore: boolean;
  readonly resolutionMessage: string | null;
  readonly reload: () => void;
  readonly loadMore: () => Promise<void>;
  readonly resolveCompletedUpload: (
    artifactId: string,
    artifactVersionId?: string,
  ) => Promise<string | null>;
}

interface ArtifactChoice {
  readonly artifact: ArtifactSummary;
  readonly version: ArtifactVersionResource;
  readonly disabledReason: string | null;
}

interface ArtifactPickerProps {
  readonly catalog: ArtifactCatalogController;
  readonly choices: readonly ArtifactChoice[];
  readonly disabled: boolean;
  readonly error?: string;
  readonly hint: string;
  readonly label: string;
  readonly maxSelected: number;
  readonly multiple: boolean;
  readonly onChange: (versionId: string, selected: boolean) => void;
  readonly onUpload: () => void;
  readonly selectedVersionIds: readonly string[];
}

const ARTIFACT_PAGE_SIZE = 100;
const FLUX_MAX_INPUTS = 8;
const FLUX_MAX_PIXELS = 4 * 1024 * 1024;
const FLUX_MIN_EDGE = 64;
const FLUX_MAX_EDGE = Math.floor(FLUX_MAX_PIXELS / FLUX_MIN_EDGE);
const FLUX_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const OCR_MAX_SOURCE_BYTES = 30_000_000;
const MAX_PROMPT_CODE_POINTS = 32_000;
const MAX_SCHEMA_BYTES = 256 * 1024;
const MAX_SCHEMA_DEPTH = 16;
const MAX_SCHEMA_NODES = 8_192;
const GPT_MIN_PIXELS = 655_360;
const GPT_MAX_PIXELS = 8_294_400;
const GPT_MAX_EDGE = 3_840;
const VERIFIED_ARTIFACT_STATUSES = new Set([
  "head_verified",
  "cryptographically_verified",
]);
const FLUX_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const OCR_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException &&
      error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error &&
      error.name === "AbortError")
  );
}

export function isProductionToolKey(value: string): value is ProductionToolKey {
  return (PRODUCTION_TOOL_KEYS as readonly string[]).includes(value);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function appendArtifacts(
  current: readonly ArtifactSummary[],
  incoming: readonly ArtifactSummary[],
): readonly ArtifactSummary[] {
  const byId = new Map(current.map((artifact) => [artifact.id, artifact]));
  for (const artifact of incoming) byId.set(artifact.id, artifact);
  return Array.from(byId.values());
}

function freezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item) => freezeJson(item)));
  }
  if (value !== null && typeof value === "object") {
    const frozen: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) frozen[key] = freezeJson(item);
    return Object.freeze(frozen);
  }
  return value;
}

function freezeRunRequest(toolKey: ProductionToolKey, input: JsonObject): CreateRunRequest {
  return Object.freeze({
    toolKey,
    input: freezeJson(input),
  });
}

function createRunIdempotencyKey(toolKey: ProductionToolKey): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi === undefined) {
    throw new Error("Secure browser randomness is unavailable.");
  }
  let identifier: string;
  if (typeof cryptoApi.randomUUID === "function") {
    identifier = cryptoApi.randomUUID();
  } else {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    identifier = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `tool-run:${toolKey}:${identifier}`;
}

function queueReasonLabel(reason: RunQueueReason | null): string {
  switch (reason) {
    case "awaiting_dispatch":
      return "Awaiting dispatch";
    case "capacity_wait":
      return "Waiting for capacity";
    case "retry_backoff":
      return "Retry backoff";
    case null:
      return "Accepted";
  }
}

function queueScopeLabel(scope: "global_tool" | "workspace_total" | "workspace_tool"): string {
  switch (scope) {
    case "global_tool":
      return "this tool across Relay";
    case "workspace_total":
      return "the workspace";
    case "workspace_tool":
      return "this tool in the workspace";
  }
}

function retryAfterCopy(seconds: number | null): string | null {
  if (seconds === null) return null;
  return `Relay suggested waiting ${seconds.toLocaleString()} ${seconds === 1 ? "second" : "seconds"} before retrying.`;
}

function useArtifactCatalog(
  adapter: ToolArtifactsAdapter,
  enabled: boolean,
  onAuthExpired: () => void,
): ArtifactCatalogController {
  const [state, setState] = useState<ArtifactCatalogState>(
    enabled ? { kind: "loading" } : { kind: "idle" },
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [resolutionMessage, setResolutionMessage] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const loadMoreControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadMoreControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ kind: "idle" });
      return;
    }

    const controller = new AbortController();
    let active = true;
    loadMoreControllerRef.current?.abort();
    setLoadingMore(false);
    setResolutionMessage(null);
    setState({ kind: "loading" });

    void adapter.list({ limit: ARTIFACT_PAGE_SIZE }, controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        onAuthExpired();
        return;
      }
      if (!active) return;
      if (result.kind === "ok") {
        setState({ kind: "ready", items: result.items, nextCursor: result.nextCursor });
      } else if (result.kind === "not_found") {
        setState({
          kind: "degraded",
          message: "Relay could not find the workspace artifact registry.",
        });
      } else {
        setState({ kind: "degraded", message: result.message });
      }
    }).catch((error: unknown) => {
      if (!active || isAbortError(error)) return;
      setState({
        kind: "degraded",
        message: "Relay could not load artifact inputs. No artifact was selected.",
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [adapter, enabled, onAuthExpired, reloadKey]);

  async function loadMore() {
    if (state.kind !== "ready" || state.nextCursor === null || loadingMore) return;
    const cursor = state.nextCursor;
    const controller = new AbortController();
    loadMoreControllerRef.current?.abort();
    loadMoreControllerRef.current = controller;
    setLoadingMore(true);

    try {
      const result = await adapter.list(
        { limit: ARTIFACT_PAGE_SIZE, cursor },
        controller.signal,
      );
      if (result.kind === "auth-expired") {
        onAuthExpired();
        return;
      }
      if (!mountedRef.current || controller.signal.aborted) return;
      if (result.kind === "ok") {
        setState((current) => current.kind === "ready" && current.nextCursor === cursor
          ? {
              kind: "ready",
              items: appendArtifacts(current.items, result.items),
              nextCursor: result.nextCursor,
            }
          : current);
      } else {
        setResolutionMessage(
          result.kind === "degraded"
            ? result.message
            : "Relay could not find the next artifact page. The loaded artifacts were kept.",
        );
      }
    } catch (error) {
      if (!isAbortError(error) && mountedRef.current) {
        setResolutionMessage(
          "Relay could not load more artifact inputs. The loaded artifacts were kept.",
        );
      }
    } finally {
      if (mountedRef.current && loadMoreControllerRef.current === controller) {
        loadMoreControllerRef.current = null;
        setLoadingMore(false);
      }
    }
  }

  async function resolveCompletedUpload(
    artifactId: string,
    artifactVersionId?: string,
  ): Promise<string | null> {
    setResolutionMessage("Refreshing the completed artifact version…");
    try {
      const result = await adapter.get(artifactId);
      if (result.kind === "auth-expired") {
        onAuthExpired();
        return null;
      }
      if (!mountedRef.current) return null;
      if (result.kind === "found") {
        setState((current) => current.kind === "ready"
          ? { ...current, items: appendArtifacts(current.items, [result.artifact]) }
          : { kind: "ready", items: [result.artifact], nextCursor: null });
        const currentVersion = result.artifact.currentVersion;
        if (currentVersion === null) {
          setResolutionMessage(
            "The upload completed, but the artifact does not expose a current version yet.",
          );
          return null;
        }
        if (
          artifactVersionId !== undefined &&
          artifactVersionId !== currentVersion.id
        ) {
          setResolutionMessage(
            "The upload completed, but a newer artifact version is already current. The current version was selected.",
          );
        } else {
          setResolutionMessage("The completed artifact version is selected.");
        }
        return currentVersion.id;
      }
      setResolutionMessage(
        result.kind === "degraded"
          ? result.message
          : "The upload completed, but Relay could not reload the artifact record.",
      );
      return artifactVersionId ?? null;
    } catch {
      if (mountedRef.current) {
        setResolutionMessage(
          "The upload completed, but Relay could not reload the artifact record.",
        );
      }
      return artifactVersionId ?? null;
    }
  }

  return {
    state,
    loadingMore,
    resolutionMessage,
    reload: () => setReloadKey((value) => value + 1),
    loadMore,
    resolveCompletedUpload,
  };
}

function artifactChoices(
  state: ArtifactCatalogState,
  mode: "flux" | "ocr",
): readonly ArtifactChoice[] {
  if (state.kind !== "ready") return [];
  const mimeTypes = mode === "flux" ? FLUX_MIME_TYPES : OCR_MIME_TYPES;
  return state.items.flatMap((artifact): readonly ArtifactChoice[] => {
    const version = artifact.currentVersion;
    if (version === null || !mimeTypes.has(version.mimeType)) return [];
    let disabledReason: string | null = null;
    if (!VERIFIED_ARTIFACT_STATUSES.has(version.verificationStatus)) {
      disabledReason = "Current version is not verified.";
    } else if (mode === "flux" && version.sizeBytes > FLUX_MAX_SOURCE_BYTES) {
      disabledReason = "Current version exceeds the 64 MiB FLUX input limit.";
    } else if (mode === "ocr" && version.sizeBytes > OCR_MAX_SOURCE_BYTES) {
      disabledReason = "Current version exceeds the 30,000,000-byte OCR source limit.";
    }
    return [{ artifact, version, disabledReason }];
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes.toLocaleString()} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function ArtifactPicker({
  catalog,
  choices,
  disabled,
  error,
  hint,
  label,
  maxSelected,
  multiple,
  onChange,
  onUpload,
  selectedVersionIds,
}: ArtifactPickerProps) {
  const id = useId();
  const representedIds = useMemo(
    () => new Set(choices.map((choice) => choice.version.id)),
    [choices],
  );
  const unresolvedIds = selectedVersionIds.filter((versionId) => !representedIds.has(versionId));
  const describedBy = [
    `${id}-hint`,
    error === undefined ? null : `${id}-error`,
  ].filter(Boolean).join(" ");

  return (
    <fieldset
      className="tool-artifact-picker"
      aria-describedby={describedBy}
      aria-invalid={error === undefined ? undefined : true}
    >
      <div className="tool-artifact-picker__heading">
        <div>
          <legend>{label}</legend>
          <p id={`${id}-hint`}>{hint}</p>
        </div>
        <Button type="button" variant="outline" disabled={disabled} onClick={onUpload}>
          Upload artifact
        </Button>
      </div>

      {catalog.state.kind === "loading"
        ? <Skeleton label="Loading artifact inputs" lines={3} />
        : null}

      {catalog.state.kind === "degraded"
        ? (
          <InlineNotice
            title="Artifact inputs unavailable"
            tone="error"
            action={
              <Button type="button" variant="outline" onClick={catalog.reload}>
                Try again
              </Button>
            }
          >
            <p>{catalog.state.message}</p>
          </InlineNotice>
        )
        : null}

      {catalog.state.kind === "ready" && choices.length === 0
        ? (
          <div className="tool-artifact-picker__empty" role="status">
            <strong>No compatible current versions</strong>
            <p>
              Upload a verified {multiple ? "PNG, JPEG, or WebP image" : "PDF, PNG, JPEG, or WebP document"},
              or load another artifact page.
            </p>
          </div>
        )
        : null}

      {catalog.state.kind === "ready" && (choices.length > 0 || unresolvedIds.length > 0)
        ? (
          <div className="tool-artifact-list">
            {choices.map(({ artifact, version, disabledReason }) => {
              const selected = selectedVersionIds.includes(version.id);
              const atLimit = multiple && !selected && selectedVersionIds.length >= maxSelected;
              return (
                <label
                  className={`tool-artifact-option${disabledReason === null ? "" : " is-disabled"}`}
                  key={version.id}
                >
                  <input
                    type={multiple ? "checkbox" : "radio"}
                    name={multiple ? undefined : `${id}-source`}
                    checked={selected}
                    disabled={disabled || disabledReason !== null || atLimit}
                    onChange={(event) => onChange(version.id, event.currentTarget.checked)}
                  />
                  <span className="tool-artifact-option__copy">
                    <strong>{artifact.name}</strong>
                    <span>
                      Current v{version.sequence} · {version.mimeType} · {formatBytes(version.sizeBytes)}
                    </span>
                    <code>{version.id}</code>
                    {disabledReason === null ? null : <small>{disabledReason}</small>}
                  </span>
                </label>
              );
            })}
            {unresolvedIds.map((versionId) => (
              <label className="tool-artifact-option" key={versionId}>
                <input
                  type={multiple ? "checkbox" : "radio"}
                  name={multiple ? undefined : `${id}-source`}
                  checked
                  disabled={disabled}
                  onChange={(event) => onChange(versionId, event.currentTarget.checked)}
                />
                <span className="tool-artifact-option__copy">
                  <strong>Recently uploaded version</strong>
                  <span>Artifact metadata is refreshing.</span>
                  <code>{versionId}</code>
                </span>
              </label>
            ))}
          </div>
        )
        : null}

      {catalog.state.kind === "ready" && catalog.state.nextCursor !== null
        ? (
          <Button
            type="button"
            variant="quiet"
            pending={catalog.loadingMore}
            pendingLabel="Loading artifacts"
            onClick={() => void catalog.loadMore()}
          >
            Load more artifacts
          </Button>
        )
        : null}

      {catalog.resolutionMessage === null
        ? null
        : <p className="tool-artifact-picker__status" role="status">{catalog.resolutionMessage}</p>}
      {error === undefined
        ? null
        : <p className="tool-field__error" id={`${id}-error`}>{error}</p>}
    </fieldset>
  );
}

function FieldError({ id, message }: { readonly id: string; readonly message?: string }) {
  return message === undefined
    ? null
    : <p className="tool-field__error" id={id}>{message}</p>;
}

function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const value = ids.filter(Boolean).join(" ");
  return value.length === 0 ? undefined : value;
}

function focusFirstInvalid(form: HTMLFormElement) {
  window.requestAnimationFrame(() => {
    form.querySelector<HTMLElement>("[aria-invalid='true']")?.focus();
  });
}

function promptError(prompt: string): string | undefined {
  if (prompt.trim().length === 0) return "Enter a prompt.";
  if (codePointLength(prompt) > MAX_PROMPT_CODE_POINTS) {
    return "Prompt must be 32,000 characters or fewer.";
  }
  return undefined;
}

function integerText(
  value: string,
  label: string,
  minimum: number,
  maximum: number,
  required: boolean,
): { readonly value?: number; readonly error?: string } {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return required ? { error: `${label} is required.` } : {};
  }
  if (!/^-?\d+$/.test(trimmed)) return { error: `${label} must be a whole number.` };
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return { error: `${label} must be a safe whole number.` };
  if (parsed < minimum || parsed > maximum) {
    return {
      error: `${label} must be between ${minimum.toLocaleString()} and ${maximum.toLocaleString()}.`,
    };
  }
  return { value: parsed };
}

interface GptErrors {
  readonly prompt?: string;
  readonly n?: string;
  readonly size?: string;
  readonly outputCompression?: string;
  readonly background?: string;
}

function validateGptSize(size: string): string | undefined {
  if (size === "auto") return undefined;
  const match = /^([1-9][0-9]{0,3})x([1-9][0-9]{0,3})$/.exec(size);
  if (match === null) return "Use auto or WIDTHxHEIGHT, for example 1536x1024.";
  const width = Number(match[1]);
  const height = Number(match[2]);
  const pixels = width * height;
  if (width % 16 !== 0 || height % 16 !== 0) {
    return "Width and height must both be multiples of 16.";
  }
  if (width > GPT_MAX_EDGE || height > GPT_MAX_EDGE) {
    return "Neither edge may exceed 3,840 pixels.";
  }
  if (Math.max(width, height) / Math.min(width, height) > 3) {
    return "The longest edge may be at most three times the shortest edge.";
  }
  if (pixels < GPT_MIN_PIXELS || pixels > GPT_MAX_PIXELS) {
    return "Image area must be between 655,360 and 8,294,400 pixels.";
  }
  return undefined;
}

interface ComposerFormProps {
  readonly disabled: boolean;
  readonly submitting: boolean;
  readonly onCreate: (input: JsonObject) => void;
}

function GptImageComposer({ disabled, submitting, onCreate }: ComposerFormProps) {
  const id = useId();
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState("1");
  const [size, setSize] = useState("auto");
  const [quality, setQuality] = useState("");
  const [outputFormat, setOutputFormat] = useState<"png" | "jpeg">("png");
  const [outputCompression, setOutputCompression] = useState("100");
  const [background, setBackground] = useState<"auto" | "transparent" | "opaque">("auto");
  const [moderation, setModeration] = useState<"auto" | "low">("auto");
  const [errors, setErrors] = useState<GptErrors>({});

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const countResult = integerText(count, "Image count", 1, 10, true);
    const compressionResult = outputFormat === "jpeg"
      ? integerText(outputCompression, "Output compression", 0, 100, true)
      : {};
    const nextErrors: GptErrors = {
      prompt: promptError(prompt),
      n: countResult.error,
      size: validateGptSize(size),
      outputCompression: compressionResult.error,
      background: background === "transparent" && outputFormat !== "png"
        ? "Transparent backgrounds require PNG output."
        : undefined,
    };
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      focusFirstInvalid(event.currentTarget);
      return;
    }

    onCreate({
      prompt,
      n: countResult.value ?? 1,
      size,
      ...(quality.length === 0 ? {} : { quality }),
      outputFormat,
      ...(outputFormat === "jpeg"
        ? { outputCompression: compressionResult.value ?? 100 }
        : {}),
      background,
      moderation,
    });
  }

  return (
    <form className="tool-composer-form" noValidate onSubmit={submit}>
      <fieldset disabled={disabled}>
        <legend className="sr-only">GPT Image 2 run configuration</legend>
        <div className="tool-field tool-field--wide">
          <label htmlFor={`${id}-prompt`}>Prompt</label>
          <textarea
            className="tool-composer-control tool-composer-control--textarea"
            id={`${id}-prompt`}
            value={prompt}
            aria-invalid={errors.prompt === undefined ? undefined : true}
            aria-describedby={describedBy(`${id}-prompt-hint`, errors.prompt && `${id}-prompt-error`)}
            onChange={(event) => {
              setPrompt(event.currentTarget.value);
              setErrors((current) => ({ ...current, prompt: undefined }));
            }}
          />
          <p className="tool-field__hint" id={`${id}-prompt-hint`}>
            Up to 32,000 characters. Your text is sent exactly as entered.
          </p>
          <FieldError id={`${id}-prompt-error`} message={errors.prompt} />
        </div>

        <div className="tool-form-grid tool-form-grid--three">
          <div className="tool-field">
            <label htmlFor={`${id}-count`}>Images</label>
            <input
              className="tool-composer-control"
              id={`${id}-count`}
              type="number"
              min="1"
              max="10"
              step="1"
              value={count}
              aria-invalid={errors.n === undefined ? undefined : true}
              aria-describedby={errors.n && `${id}-count-error`}
              onChange={(event) => {
                setCount(event.currentTarget.value);
                setErrors((current) => ({ ...current, n: undefined }));
              }}
            />
            <FieldError id={`${id}-count-error`} message={errors.n} />
          </div>
          <div className="tool-field">
            <label htmlFor={`${id}-size`}>Size</label>
            <input
              className="tool-composer-control"
              id={`${id}-size`}
              value={size}
              spellCheck="false"
              aria-invalid={errors.size === undefined ? undefined : true}
              aria-describedby={describedBy(`${id}-size-hint`, errors.size && `${id}-size-error`)}
              onChange={(event) => {
                setSize(event.currentTarget.value);
                setErrors((current) => ({ ...current, size: undefined }));
              }}
            />
            <p className="tool-field__hint" id={`${id}-size-hint`}>auto or WIDTHxHEIGHT</p>
            <FieldError id={`${id}-size-error`} message={errors.size} />
          </div>
          <div className="tool-field">
            <label htmlFor={`${id}-quality`}>Quality</label>
            <select
              className="tool-composer-control"
              id={`${id}-quality`}
              value={quality}
              onChange={(event) => setQuality(event.currentTarget.value)}
            >
              <option value="">Provider default</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>

        <div className="tool-form-grid tool-form-grid--three">
          <div className="tool-field">
            <label htmlFor={`${id}-format`}>Output format</label>
            <select
              className="tool-composer-control"
              id={`${id}-format`}
              value={outputFormat}
              onChange={(event) => {
                const next = event.currentTarget.value as "png" | "jpeg";
                setOutputFormat(next);
                if (next === "jpeg" && background === "transparent") setBackground("auto");
                setErrors((current) => ({ ...current, background: undefined }));
              }}
            >
              <option value="png">PNG</option>
              <option value="jpeg" disabled={background === "transparent"}>JPEG</option>
            </select>
          </div>
          {outputFormat === "jpeg"
            ? (
              <div className="tool-field">
                <label htmlFor={`${id}-compression`}>Output compression</label>
                <input
                  className="tool-composer-control"
                  id={`${id}-compression`}
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  value={outputCompression}
                  aria-invalid={errors.outputCompression === undefined ? undefined : true}
                  aria-describedby={errors.outputCompression && `${id}-compression-error`}
                  onChange={(event) => {
                    setOutputCompression(event.currentTarget.value);
                    setErrors((current) => ({ ...current, outputCompression: undefined }));
                  }}
                />
                <FieldError id={`${id}-compression-error`} message={errors.outputCompression} />
              </div>
            )
            : null}
          <div className="tool-field">
            <label htmlFor={`${id}-background`}>Background</label>
            <select
              className="tool-composer-control"
              id={`${id}-background`}
              value={background}
              aria-invalid={errors.background === undefined ? undefined : true}
              aria-describedby={describedBy(`${id}-background-hint`, errors.background && `${id}-background-error`)}
              onChange={(event) => {
                const next = event.currentTarget.value as typeof background;
                setBackground(next);
                if (next === "transparent") setOutputFormat("png");
                setErrors((current) => ({ ...current, background: undefined }));
              }}
            >
              <option value="auto">Auto</option>
              <option value="transparent">Transparent</option>
              <option value="opaque">Opaque</option>
            </select>
            <p className="tool-field__hint" id={`${id}-background-hint`}>
              Transparent output is restricted to PNG.
            </p>
            <FieldError id={`${id}-background-error`} message={errors.background} />
          </div>
          <div className="tool-field">
            <label htmlFor={`${id}-moderation`}>Moderation</label>
            <select
              className="tool-composer-control"
              id={`${id}-moderation`}
              value={moderation}
              onChange={(event) => setModeration(event.currentTarget.value as typeof moderation)}
            >
              <option value="auto">Auto</option>
              <option value="low">Low</option>
            </select>
          </div>
        </div>
      </fieldset>
      <div className="tool-composer-form__actions">
        <Button
          type="submit"
          disabled={disabled}
          pending={submitting}
          pendingLabel="Creating run"
        >
          Create run
        </Button>
      </div>
    </form>
  );
}

interface FluxErrors {
  readonly prompt?: string;
  readonly artifacts?: string;
  readonly seed?: string;
  readonly width?: string;
  readonly height?: string;
  readonly dimensions?: string;
}

function FluxComposer({
  artifactsAdapter,
  disabled,
  submitting,
  onAuthExpired,
  onCreate,
}: ComposerFormProps & {
  readonly artifactsAdapter: ToolArtifactsAdapter;
  readonly onAuthExpired: () => void;
}) {
  const id = useId();
  const catalog = useArtifactCatalog(artifactsAdapter, true, onAuthExpired);
  const choices = useMemo(() => artifactChoices(catalog.state, "flux"), [catalog.state]);
  const [prompt, setPrompt] = useState("");
  const [disablePromptUpsampling, setDisablePromptUpsampling] = useState(false);
  const [selectedVersionIds, setSelectedVersionIds] = useState<readonly string[]>([]);
  const [seed, setSeed] = useState("");
  const [width, setWidth] = useState("");
  const [height, setHeight] = useState("");
  const [safetyTolerance, setSafetyTolerance] = useState("");
  const [outputFormat, setOutputFormat] = useState<"jpeg" | "png" | "webp">("png");
  const [errors, setErrors] = useState<FluxErrors>({});
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);

  function changeArtifact(versionId: string, selected: boolean) {
    setErrors((current) => ({ ...current, artifacts: undefined }));
    setSelectedVersionIds((current) => {
      if (!selected) return current.filter((idValue) => idValue !== versionId);
      if (current.includes(versionId) || current.length >= FLUX_MAX_INPUTS) return current;
      return [...current, versionId];
    });
  }

  function completedUpload(artifactId: string, artifactVersionId?: string) {
    if (artifactVersionId !== undefined) changeArtifact(artifactVersionId, true);
    void catalog.resolveCompletedUpload(artifactId, artifactVersionId).then((resolvedId) => {
      if (resolvedId !== null) changeArtifact(resolvedId, true);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const seedResult = integerText(
      seed,
      "Seed",
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      false,
    );
    const widthResult = integerText(width, "Width", FLUX_MIN_EDGE, FLUX_MAX_EDGE, false);
    const heightResult = integerText(height, "Height", FLUX_MIN_EDGE, FLUX_MAX_EDGE, false);
    const selectedBytes = choices
      .filter((choice) => selectedVersionIds.includes(choice.version.id))
      .reduce((total, choice) => total + choice.version.sizeBytes, 0);
    const dimensionsError = widthResult.value !== undefined && heightResult.value !== undefined &&
        widthResult.value * heightResult.value > FLUX_MAX_PIXELS
      ? "Width × height must not exceed 4,194,304 pixels."
      : undefined;
    const nextErrors: FluxErrors = {
      prompt: promptError(prompt),
      artifacts: selectedVersionIds.length > FLUX_MAX_INPUTS
        ? "Select no more than eight current artifact versions."
        : selectedBytes > FLUX_MAX_SOURCE_BYTES
          ? "Selected artifact versions exceed the 64 MiB combined input limit."
          : undefined,
      seed: seedResult.error,
      width: widthResult.error,
      height: heightResult.error,
      dimensions: dimensionsError,
    };
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      focusFirstInvalid(event.currentTarget);
      return;
    }

    const safetyValue = safetyTolerance.length === 0 ? undefined : Number(safetyTolerance);
    onCreate({
      prompt,
      disablePromptUpsampling,
      ...(selectedVersionIds.length === 0
        ? {}
        : { inputArtifactVersionIds: [...selectedVersionIds] }),
      ...(seedResult.value === undefined ? {} : { seed: seedResult.value }),
      ...(widthResult.value === undefined ? {} : { width: widthResult.value }),
      ...(heightResult.value === undefined ? {} : { height: heightResult.value }),
      ...(safetyValue === undefined ? {} : { safetyTolerance: safetyValue }),
      outputFormat,
    });
  }

  return (
    <>
      <form className="tool-composer-form" noValidate onSubmit={submit}>
        <fieldset disabled={disabled}>
          <legend className="sr-only">FLUX.2 Pro run configuration</legend>
          <div className="tool-field tool-field--wide">
            <label htmlFor={`${id}-prompt`}>Prompt</label>
            <textarea
              className="tool-composer-control tool-composer-control--textarea"
              id={`${id}-prompt`}
              value={prompt}
              aria-invalid={errors.prompt === undefined ? undefined : true}
              aria-describedby={describedBy(`${id}-prompt-hint`, errors.prompt && `${id}-prompt-error`)}
              onChange={(event) => {
                setPrompt(event.currentTarget.value);
                setErrors((current) => ({ ...current, prompt: undefined }));
              }}
            />
            <p className="tool-field__hint" id={`${id}-prompt-hint`}>
              Up to 32,000 characters. Your text is sent exactly as entered.
            </p>
            <FieldError id={`${id}-prompt-error`} message={errors.prompt} />
          </div>

          <label className="tool-check-row">
            <input
              type="checkbox"
              checked={disablePromptUpsampling}
              onChange={(event) => setDisablePromptUpsampling(event.currentTarget.checked)}
            />
            <span>
              <strong>Disable prompt upsampling</strong>
              <small>Send the prompt without provider-side upsampling.</small>
            </span>
          </label>

          <ArtifactPicker
            catalog={catalog}
            choices={choices}
            disabled={disabled}
            error={errors.artifacts}
            hint="Optional. Select up to eight verified current PNG, JPEG, or WebP versions."
            label="Input artifact versions"
            maxSelected={FLUX_MAX_INPUTS}
            multiple
            onChange={changeArtifact}
            onUpload={() => setUploadDialogOpen(true)}
            selectedVersionIds={selectedVersionIds}
          />

          <div className="tool-form-grid tool-form-grid--three">
            <div className="tool-field">
              <label htmlFor={`${id}-seed`}>Seed</label>
              <input
                className="tool-composer-control"
                id={`${id}-seed`}
                inputMode="numeric"
                placeholder="Provider default"
                value={seed}
                aria-invalid={errors.seed === undefined ? undefined : true}
                aria-describedby={errors.seed && `${id}-seed-error`}
                onChange={(event) => {
                  setSeed(event.currentTarget.value);
                  setErrors((current) => ({ ...current, seed: undefined }));
                }}
              />
              <FieldError id={`${id}-seed-error`} message={errors.seed} />
            </div>
            <div className="tool-field">
              <label htmlFor={`${id}-width`}>Width</label>
              <input
                className="tool-composer-control"
                id={`${id}-width`}
                type="number"
                min={FLUX_MIN_EDGE}
                max={FLUX_MAX_EDGE}
                step="1"
                placeholder="Provider default"
                value={width}
                aria-invalid={errors.width !== undefined || errors.dimensions !== undefined ? true : undefined}
                aria-describedby={describedBy(
                  `${id}-dimensions-hint`,
                  errors.width && `${id}-width-error`,
                  errors.dimensions && `${id}-dimensions-error`,
                )}
                onChange={(event) => {
                  setWidth(event.currentTarget.value);
                  setErrors((current) => ({ ...current, width: undefined, dimensions: undefined }));
                }}
              />
              <FieldError id={`${id}-width-error`} message={errors.width} />
            </div>
            <div className="tool-field">
              <label htmlFor={`${id}-height`}>Height</label>
              <input
                className="tool-composer-control"
                id={`${id}-height`}
                type="number"
                min={FLUX_MIN_EDGE}
                max={FLUX_MAX_EDGE}
                step="1"
                placeholder="Provider default"
                value={height}
                aria-invalid={errors.height !== undefined || errors.dimensions !== undefined ? true : undefined}
                aria-describedby={describedBy(
                  `${id}-dimensions-hint`,
                  errors.height && `${id}-height-error`,
                  errors.dimensions && `${id}-dimensions-error`,
                )}
                onChange={(event) => {
                  setHeight(event.currentTarget.value);
                  setErrors((current) => ({ ...current, height: undefined, dimensions: undefined }));
                }}
              />
              <FieldError id={`${id}-height-error`} message={errors.height} />
            </div>
          </div>
          <p className="tool-field__hint tool-field__hint--grid" id={`${id}-dimensions-hint`}>
            Optional edges: 64–65,536 pixels. Combined area cannot exceed 4,194,304 pixels.
          </p>
          <FieldError id={`${id}-dimensions-error`} message={errors.dimensions} />

          <div className="tool-form-grid tool-form-grid--two">
            <div className="tool-field">
              <label htmlFor={`${id}-safety`}>Safety tolerance</label>
              <select
                className="tool-composer-control"
                id={`${id}-safety`}
                value={safetyTolerance}
                onChange={(event) => setSafetyTolerance(event.currentTarget.value)}
              >
                <option value="">Provider default</option>
                {[0, 1, 2, 3, 4, 5].map((value) => (
                  <option value={value} key={value}>{value}</option>
                ))}
              </select>
            </div>
            <div className="tool-field">
              <label htmlFor={`${id}-format`}>Output format</label>
              <select
                className="tool-composer-control"
                id={`${id}-format`}
                value={outputFormat}
                onChange={(event) => setOutputFormat(event.currentTarget.value as typeof outputFormat)}
              >
                <option value="png">PNG</option>
                <option value="jpeg">JPEG</option>
                <option value="webp">WebP</option>
              </select>
            </div>
          </div>
        </fieldset>
        <div className="tool-composer-form__actions">
          <Button
            type="submit"
            disabled={disabled}
            pending={submitting}
            pendingLabel="Creating run"
          >
            Create run
          </Button>
        </div>
      </form>

      {uploadDialogOpen
        ? (
          <ArtifactUploadDialog
            adapter={artifactsAdapter}
            onAuthExpired={onAuthExpired}
            onClose={() => setUploadDialogOpen(false)}
            onCompleted={completedUpload}
          />
        )
        : null}
    </>
  );
}

interface OcrErrors {
  readonly source?: string;
  readonly pages?: string;
  readonly imageLimit?: string;
  readonly imageMinSize?: string;
  readonly imageAnnotationSchema?: string;
  readonly extractionSchema?: string;
  readonly extractionPrompt?: string;
}

interface SchemaTraversalState {
  nodes: number;
}

function inspectSchema(value: unknown, depth: number, state: SchemaTraversalState): boolean {
  state.nodes += 1;
  if (state.nodes > MAX_SCHEMA_NODES || depth > MAX_SCHEMA_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.length <= 2_048 && value.every((item) => inspectSchema(item, depth + 1, state));
  }
  const keys = Object.keys(value);
  return keys.length <= 512 && Object.values(value).every((item) =>
    inspectSchema(item, depth + 1, state)
  );
}

function optionalJsonSchema(
  text: string,
  label: string,
): { readonly value?: JsonObject; readonly error?: string } {
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { error: `${label} must be valid JSON.` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${label} must have an object at its root.` };
  }
  if (Object.keys(parsed).length > 256) {
    return { error: `${label} may contain at most 256 root properties.` };
  }
  if (!inspectSchema(parsed, 0, { nodes: 0 })) {
    return { error: `${label} is too complex.` };
  }
  if (new TextEncoder().encode(JSON.stringify(parsed)).byteLength > MAX_SCHEMA_BYTES) {
    return { error: `${label} must be 256 KiB or smaller.` };
  }
  return { value: parsed as JsonObject };
}

function validatePages(value: string): string | undefined {
  const pages = value.trim();
  if (pages.length === 0) return undefined;
  if (pages.length > 4_096 || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(pages)) {
    return "Use comma-separated zero-based pages or ranges, for example 0-2,5.";
  }
  let count = 0;
  for (const part of pages.split(",")) {
    const [startText, endText] = part.split("-");
    const start = Number(startText);
    const end = endText === undefined ? start : Number(endText);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > 99_999) {
      return "Page values must be ordered whole numbers from 0 to 99,999.";
    }
    count += end - start + 1;
    if (count > 1_000) return "Select no more than 1,000 pages.";
  }
  return undefined;
}

function OcrComposer({
  artifactsAdapter,
  disabled,
  submitting,
  onAuthExpired,
  onCreate,
}: ComposerFormProps & {
  readonly artifactsAdapter: ToolArtifactsAdapter;
  readonly onAuthExpired: () => void;
}) {
  const id = useId();
  const catalog = useArtifactCatalog(artifactsAdapter, true, onAuthExpired);
  const choices = useMemo(() => artifactChoices(catalog.state, "ocr"), [catalog.state]);
  const [sourceVersionId, setSourceVersionId] = useState("");
  const [pages, setPages] = useState("");
  const [includeImages, setIncludeImages] = useState(false);
  const [imageLimit, setImageLimit] = useState("");
  const [imageMinSize, setImageMinSize] = useState("");
  const [imageAnnotationSchema, setImageAnnotationSchema] = useState("");
  const [extractionSchema, setExtractionSchema] = useState("");
  const [extractionPrompt, setExtractionPrompt] = useState("");
  const [tableFormat, setTableFormat] = useState<"markdown" | "html">("markdown");
  const [extractHeader, setExtractHeader] = useState(true);
  const [extractFooter, setExtractFooter] = useState(true);
  const [confidenceGranularity, setConfidenceGranularity] = useState<"word" | "page">("word");
  const [errors, setErrors] = useState<OcrErrors>({});
  const [uploadDialogOpen, setUploadDialogOpen] = useState(false);

  function changeSource(versionId: string, selected: boolean) {
    setSourceVersionId(selected ? versionId : "");
    setErrors((current) => ({ ...current, source: undefined }));
  }

  function completedUpload(artifactId: string, artifactVersionId?: string) {
    if (artifactVersionId !== undefined) changeSource(artifactVersionId, true);
    void catalog.resolveCompletedUpload(artifactId, artifactVersionId).then((resolvedId) => {
      if (resolvedId !== null) changeSource(resolvedId, true);
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const imageLimitResult = includeImages
      ? integerText(imageLimit, "Image limit", 0, 10_000, false)
      : {};
    const imageMinSizeResult = includeImages
      ? integerText(imageMinSize, "Image minimum size", 0, 100_000, false)
      : {};
    const imageSchemaResult = optionalJsonSchema(
      imageAnnotationSchema,
      "Image annotation schema",
    );
    const extractionSchemaResult = optionalJsonSchema(
      extractionSchema,
      "Document extraction schema",
    );
    const trimmedExtractionPrompt = extractionPrompt.trim();
    const nextErrors: OcrErrors = {
      source: sourceVersionId.length === 0 ? "Select one current artifact version." : undefined,
      pages: validatePages(pages),
      imageLimit: imageLimitResult.error,
      imageMinSize: imageMinSizeResult.error,
      imageAnnotationSchema: imageSchemaResult.error,
      extractionSchema: extractionSchemaResult.error,
      extractionPrompt: trimmedExtractionPrompt.length > 0 && extractionSchemaResult.value === undefined
        ? "Add a valid document extraction schema before adding an extraction prompt."
        : codePointLength(trimmedExtractionPrompt) > MAX_PROMPT_CODE_POINTS
          ? "Extraction prompt must be 32,000 characters or fewer."
          : undefined,
    };
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) {
      focusFirstInvalid(event.currentTarget);
      return;
    }

    onCreate({
      sourceArtifactVersionId: sourceVersionId,
      ...(pages.trim().length === 0 ? {} : { pages: pages.trim() }),
      includeImages,
      ...(imageLimitResult.value === undefined ? {} : { imageLimit: imageLimitResult.value }),
      ...(imageMinSizeResult.value === undefined ? {} : { imageMinSize: imageMinSizeResult.value }),
      ...(imageSchemaResult.value === undefined
        ? {}
        : { imageAnnotationSchema: imageSchemaResult.value }),
      ...(extractionSchemaResult.value === undefined
        ? {}
        : { extractionSchema: extractionSchemaResult.value }),
      ...(trimmedExtractionPrompt.length === 0
        ? {}
        : { extractionPrompt }),
      tableFormat,
      extractHeader,
      extractFooter,
      confidenceGranularity,
    });
  }

  return (
    <>
      <form className="tool-composer-form" noValidate onSubmit={submit}>
        <fieldset disabled={disabled}>
          <legend className="sr-only">Document OCR run configuration</legend>
          <ArtifactPicker
            catalog={catalog}
            choices={choices}
            disabled={disabled}
            error={errors.source}
            hint="Required. OCR is pinned to the selected verified current version."
            label="Source artifact version"
            maxSelected={1}
            multiple={false}
            onChange={changeSource}
            onUpload={() => setUploadDialogOpen(true)}
            selectedVersionIds={sourceVersionId.length === 0 ? [] : [sourceVersionId]}
          />

          <div className="tool-field tool-field--wide">
            <label htmlFor={`${id}-pages`}>Pages</label>
            <input
              className="tool-composer-control"
              id={`${id}-pages`}
              placeholder="All pages"
              spellCheck="false"
              value={pages}
              aria-invalid={errors.pages === undefined ? undefined : true}
              aria-describedby={describedBy(`${id}-pages-hint`, errors.pages && `${id}-pages-error`)}
              onChange={(event) => {
                setPages(event.currentTarget.value);
                setErrors((current) => ({ ...current, pages: undefined }));
              }}
            />
            <p className="tool-field__hint" id={`${id}-pages-hint`}>
              Optional zero-based pages or ranges, such as 0-2,5. Maximum 1,000 pages.
            </p>
            <FieldError id={`${id}-pages-error`} message={errors.pages} />
          </div>

          <section className="tool-option-group" aria-labelledby={`${id}-images-title`}>
            <div className="tool-option-group__heading">
              <div>
                <h3 id={`${id}-images-title`}>Embedded images</h3>
                <p>Control image output and optional annotation structure.</p>
              </div>
              <label className="tool-switch-row">
                <input
                  type="checkbox"
                  checked={includeImages}
                  onChange={(event) => {
                    setIncludeImages(event.currentTarget.checked);
                    setErrors((current) => ({
                      ...current,
                      imageLimit: undefined,
                      imageMinSize: undefined,
                    }));
                  }}
                />
                <span>Include images</span>
              </label>
            </div>
            {includeImages
              ? (
                <div className="tool-form-grid tool-form-grid--two">
                  <div className="tool-field">
                    <label htmlFor={`${id}-image-limit`}>Image limit</label>
                    <input
                      className="tool-composer-control"
                      id={`${id}-image-limit`}
                      type="number"
                      min="0"
                      max="10000"
                      step="1"
                      placeholder="Provider default"
                      value={imageLimit}
                      aria-invalid={errors.imageLimit === undefined ? undefined : true}
                      aria-describedby={errors.imageLimit && `${id}-image-limit-error`}
                      onChange={(event) => {
                        setImageLimit(event.currentTarget.value);
                        setErrors((current) => ({ ...current, imageLimit: undefined }));
                      }}
                    />
                    <FieldError id={`${id}-image-limit-error`} message={errors.imageLimit} />
                  </div>
                  <div className="tool-field">
                    <label htmlFor={`${id}-image-min-size`}>Image minimum size</label>
                    <input
                      className="tool-composer-control"
                      id={`${id}-image-min-size`}
                      type="number"
                      min="0"
                      max="100000"
                      step="1"
                      placeholder="Provider default"
                      value={imageMinSize}
                      aria-invalid={errors.imageMinSize === undefined ? undefined : true}
                      aria-describedby={errors.imageMinSize && `${id}-image-min-size-error`}
                      onChange={(event) => {
                        setImageMinSize(event.currentTarget.value);
                        setErrors((current) => ({ ...current, imageMinSize: undefined }));
                      }}
                    />
                    <FieldError id={`${id}-image-min-size-error`} message={errors.imageMinSize} />
                  </div>
                </div>
              )
              : null}
            <div className="tool-field tool-field--wide">
              <label htmlFor={`${id}-image-schema`}>Image annotation JSON schema</label>
              <textarea
                className="tool-composer-control tool-composer-control--code"
                id={`${id}-image-schema`}
                placeholder="Optional JSON object"
                spellCheck="false"
                value={imageAnnotationSchema}
                aria-invalid={errors.imageAnnotationSchema === undefined ? undefined : true}
                aria-describedby={describedBy(
                  `${id}-image-schema-hint`,
                  errors.imageAnnotationSchema && `${id}-image-schema-error`,
                )}
                onChange={(event) => {
                  setImageAnnotationSchema(event.currentTarget.value);
                  setErrors((current) => ({ ...current, imageAnnotationSchema: undefined }));
                }}
              />
              <p className="tool-field__hint" id={`${id}-image-schema-hint`}>
                Optional JSON object defining strict image annotations.
              </p>
              <FieldError id={`${id}-image-schema-error`} message={errors.imageAnnotationSchema} />
            </div>
          </section>

          <section className="tool-option-group" aria-labelledby={`${id}-extraction-title`}>
            <div className="tool-option-group__heading">
              <div>
                <h3 id={`${id}-extraction-title`}>Document extraction</h3>
                <p>Add a JSON schema, with an optional prompt, for structured output.</p>
              </div>
            </div>
            <div className="tool-form-grid tool-form-grid--two">
              <div className="tool-field">
                <label htmlFor={`${id}-extraction-schema`}>Document extraction JSON schema</label>
                <textarea
                  className="tool-composer-control tool-composer-control--code"
                  id={`${id}-extraction-schema`}
                  placeholder="Optional JSON object"
                  spellCheck="false"
                  value={extractionSchema}
                  aria-invalid={errors.extractionSchema === undefined ? undefined : true}
                  aria-describedby={errors.extractionSchema && `${id}-extraction-schema-error`}
                  onChange={(event) => {
                    setExtractionSchema(event.currentTarget.value);
                    setErrors((current) => ({
                      ...current,
                      extractionSchema: undefined,
                      extractionPrompt: undefined,
                    }));
                  }}
                />
                <FieldError id={`${id}-extraction-schema-error`} message={errors.extractionSchema} />
              </div>
              <div className="tool-field">
                <label htmlFor={`${id}-extraction-prompt`}>Extraction prompt</label>
                <textarea
                  className="tool-composer-control tool-composer-control--code"
                  id={`${id}-extraction-prompt`}
                  placeholder="Optional when a schema is present"
                  value={extractionPrompt}
                  aria-invalid={errors.extractionPrompt === undefined ? undefined : true}
                  aria-describedby={errors.extractionPrompt && `${id}-extraction-prompt-error`}
                  onChange={(event) => {
                    setExtractionPrompt(event.currentTarget.value);
                    setErrors((current) => ({ ...current, extractionPrompt: undefined }));
                  }}
                />
                <FieldError id={`${id}-extraction-prompt-error`} message={errors.extractionPrompt} />
              </div>
            </div>
          </section>

          <div className="tool-form-grid tool-form-grid--two">
            <div className="tool-field">
              <label htmlFor={`${id}-table-format`}>Table format</label>
              <select
                className="tool-composer-control"
                id={`${id}-table-format`}
                value={tableFormat}
                onChange={(event) => setTableFormat(event.currentTarget.value as typeof tableFormat)}
              >
                <option value="markdown">Markdown</option>
                <option value="html">HTML</option>
              </select>
            </div>
            <div className="tool-field">
              <label htmlFor={`${id}-confidence`}>Confidence granularity</label>
              <select
                className="tool-composer-control"
                id={`${id}-confidence`}
                value={confidenceGranularity}
                onChange={(event) =>
                  setConfidenceGranularity(event.currentTarget.value as typeof confidenceGranularity)}
              >
                <option value="word">Word</option>
                <option value="page">Page</option>
              </select>
            </div>
          </div>

          <div className="tool-check-grid">
            <label className="tool-check-row">
              <input
                type="checkbox"
                checked={extractHeader}
                onChange={(event) => setExtractHeader(event.currentTarget.checked)}
              />
              <span><strong>Extract headers</strong></span>
            </label>
            <label className="tool-check-row">
              <input
                type="checkbox"
                checked={extractFooter}
                onChange={(event) => setExtractFooter(event.currentTarget.checked)}
              />
              <span><strong>Extract footers</strong></span>
            </label>
          </div>
        </fieldset>
        <div className="tool-composer-form__actions">
          <Button
            type="submit"
            disabled={disabled}
            pending={submitting}
            pendingLabel="Creating run"
          >
            Create run
          </Button>
        </div>
      </form>

      {uploadDialogOpen
        ? (
          <ArtifactUploadDialog
            adapter={artifactsAdapter}
            onAuthExpired={onAuthExpired}
            onClose={() => setUploadDialogOpen(false)}
            onCompleted={completedUpload}
          />
        )
        : null}
    </>
  );
}

function SubmissionFeedback({
  pendingOperation,
  state,
  onRetry,
}: {
  readonly pendingOperation: FrozenRunOperation | null;
  readonly state: SubmissionState;
  readonly onRetry: () => void;
}) {
  if (state.kind === "idle") return null;
  if (state.kind === "submitting") {
    return (
      <div className="tool-run-feedback" role="status" aria-live="polite">
        <strong>{state.exactRetry ? "Retrying exact request" : "Submitting run"}</strong>
        <p>No automatic retry will be attempted.</p>
      </div>
    );
  }

  const result = state.result;
  switch (result.kind) {
    case "accepted":
      return (
        <InlineNotice
          title={result.replayed ? "Stored run replayed" : "Run accepted"}
          tone="success"
          action={
            <LinkButton variant="outline" to={`/dashboard/runs/${encodeURIComponent(result.run.id)}`}>
              Open run
            </LinkButton>
          }
        >
          <p>
            {result.replayed
              ? "Relay returned the run already bound to this exact request; no duplicate run was created."
              : `Run status: ${result.run.status}. Queue state: ${queueReasonLabel(result.queueReason)}.`}
          </p>
        </InlineNotice>
      );
    case "unknown-outcome":
      return (
        <InlineNotice
          title="Run outcome unknown"
          tone="warning"
          action={
            <Button type="button" onClick={onRetry} disabled={pendingOperation === null}>
              Retry exact request
            </Button>
          }
        >
          <p>{result.message}</p>
          {retryAfterCopy(result.retryAfterSeconds) === null
            ? null
            : <p>{retryAfterCopy(result.retryAfterSeconds)}</p>}
          {pendingOperation === null
            ? null
            : <p>Stable request key: <code>{pendingOperation.idempotencyKey}</code></p>}
        </InlineNotice>
      );
    case "queue-full":
      return (
        <InlineNotice title="Run queue is full" tone="warning">
          <p>Capacity is currently full for {queueScopeLabel(result.scope)}.</p>
          {retryAfterCopy(result.retryAfterSeconds) === null
            ? null
            : <p>{retryAfterCopy(result.retryAfterSeconds)}</p>}
        </InlineNotice>
      );
    case "not-entitled":
      return (
        <InlineNotice title="Tool access required" tone="warning">
          <p>The active workspace is not entitled to execute this tool.</p>
        </InlineNotice>
      );
    case "allowance-exceeded":
      return (
        <InlineNotice title="Workspace allowance exceeded" tone="warning">
          <p>The requested run exceeds the current <code>{result.metric}</code> allowance.</p>
          <dl className="tool-run-feedback__facts">
            <div><dt>Requested</dt><dd>{result.requestedAmount} {result.unit}</dd></div>
            <div><dt>Limit</dt><dd>{result.limitAmount} {result.unit}</dd></div>
            <div><dt>Consumed</dt><dd>{result.consumedAmount} {result.unit}</dd></div>
            <div><dt>Reserved</dt><dd>{result.reservedAmount} {result.unit}</dd></div>
          </dl>
        </InlineNotice>
      );
    case "tool-unavailable":
      return (
        <InlineNotice title="Tool temporarily unavailable" tone="warning">
          <p>Relay cannot admit this tool right now. The request was not accepted.</p>
        </InlineNotice>
      );
    case "idempotency-conflict":
      return (
        <InlineNotice title="Request key conflict" tone="error">
          <p>The stable request key is bound to different content. The frozen request cannot be retried.</p>
        </InlineNotice>
      );
    case "not_found":
      return (
        <InlineNotice title="Tool no longer available" tone="error">
          <p>Relay could not find this tool during admission. Reload the catalog before submitting again.</p>
        </InlineNotice>
      );
    case "degraded":
      return (
        <InlineNotice
          title={result.retryable ? "Run admission unavailable" : "Run not created"}
          tone="error"
          action={result.retryable && pendingOperation !== null
            ? <Button type="button" onClick={onRetry}>Retry exact request</Button>
            : undefined}
        >
          <p>{result.message}</p>
          {retryAfterCopy(result.retryAfterSeconds ?? null) === null
            ? null
            : <p>{retryAfterCopy(result.retryAfterSeconds ?? null)}</p>}
          {result.retryable && pendingOperation !== null
            ? <p>Stable request key: <code>{pendingOperation.idempotencyKey}</code></p>
            : null}
        </InlineNotice>
      );
  }
}

function composerBadge(state: SubmissionState, exactRequestPending: boolean) {
  if (state.kind === "submitting") return <StatusBadge tone="pending">Submitting</StatusBadge>;
  if (exactRequestPending) return <StatusBadge tone="warning">Retry locked</StatusBadge>;
  if (state.kind === "result" && state.result.kind === "accepted") {
    return <StatusBadge tone="ready">Accepted</StatusBadge>;
  }
  return <StatusBadge tone="ready">Ready</StatusBadge>;
}

export function ToolExecutionComposer({
  tool,
  runsAdapter,
  artifactsAdapter,
  onAuthExpired,
}: ToolExecutionComposerProps) {
  const [submission, setSubmission] = useState<SubmissionState>({ kind: "idle" });
  const [pendingOperation, setPendingOperation] = useState<FrozenRunOperation | null>(null);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  async function execute(operation: FrozenRunOperation, exactRetry: boolean) {
    const generation = ++generationRef.current;
    setSubmission({ kind: "submitting", exactRetry });
    let result: CreateRunAdapterResult;
    try {
      result = await runsAdapter.create(operation.request, operation.idempotencyKey);
    } catch {
      result = {
        kind: "unknown-outcome",
        message:
          "Relay could not confirm whether the run was accepted. Retry only this exact frozen request with the same idempotency key.",
        retryable: true,
        retryMode: "exact-request",
        retryAfterSeconds: null,
      };
    }
    if (!mountedRef.current || generation !== generationRef.current) return;

    if (result.kind === "auth-expired") {
      setPendingOperation(null);
      setSubmission({ kind: "idle" });
      onAuthExpired();
      return;
    }
    const retainExact = result.kind === "unknown-outcome" ||
      (result.kind === "degraded" && result.retryable === true);
    setPendingOperation(retainExact ? operation : null);
    setSubmission({ kind: "result", result });
  }

  function create(input: JsonObject) {
    if (submission.kind === "submitting" || pendingOperation !== null) return;
    let operation: FrozenRunOperation;
    try {
      operation = Object.freeze({
        request: freezeRunRequest(tool.key, input),
        idempotencyKey: createRunIdempotencyKey(tool.key),
      });
    } catch (error) {
      setSubmission({
        kind: "result",
        result: {
          kind: "degraded",
          message: error instanceof Error
            ? `Relay could not prepare a stable run request. ${error.message}`
            : "Relay could not prepare a stable run request in this browser.",
          retryable: false,
          retryAfterSeconds: null,
        },
      });
      return;
    }
    setPendingOperation(null);
    void execute(operation, false);
  }

  function retryExact() {
    if (pendingOperation !== null && submission.kind !== "submitting") {
      void execute(pendingOperation, true);
    }
  }

  if (tool.lifecycle === "deprecated") {
    return (
      <section className="tool-composer" aria-labelledby="tool-composer-title">
        <header className="tool-composer__header">
          <div>
            <h2 id="tool-composer-title">Create run</h2>
            <p>Configure an asynchronous run from the published tool contract.</p>
          </div>
          <StatusBadge tone="warning">Deprecated</StatusBadge>
        </header>
        <InlineNotice title="Execution disabled for deprecated tool" tone="warning">
          <p>This tool remains visible for contract history, but Relay will not create new runs from it.</p>
        </InlineNotice>
      </section>
    );
  }

  const submitting = submission.kind === "submitting";
  const formDisabled = submitting || pendingOperation !== null;

  return (
    <section className="tool-composer" aria-labelledby="tool-composer-title">
      <header className="tool-composer__header">
        <div>
          <h2 id="tool-composer-title">Create run</h2>
          <p>Configure and submit an asynchronous run. No automatic retry is performed.</p>
        </div>
        {composerBadge(submission, pendingOperation !== null)}
      </header>

      <SubmissionFeedback
        pendingOperation={pendingOperation}
        state={submission}
        onRetry={retryExact}
      />

      {tool.key === "image.generate.gpt-image-2"
        ? (
          <GptImageComposer
            disabled={formDisabled}
            submitting={submitting}
            onCreate={create}
          />
        )
        : null}
      {tool.key === "image.generate.flux-2-pro"
        ? (
          <FluxComposer
            artifactsAdapter={artifactsAdapter}
            disabled={formDisabled}
            submitting={submitting}
            onAuthExpired={onAuthExpired}
            onCreate={create}
          />
        )
        : null}
      {tool.key === "document.ocr"
        ? (
          <OcrComposer
            artifactsAdapter={artifactsAdapter}
            disabled={formDisabled}
            submitting={submitting}
            onAuthExpired={onAuthExpired}
            onCreate={create}
          />
        )
        : null}
    </section>
  );
}
