import {
  AzureProviderError,
  invalidInput,
  invalidResponse,
  responseTooLarge,
} from "./errors.ts";
import {
  AZURE_PROVIDER_LIMITS,
  type AzureProviderClientOptions,
  type AzureProviderId,
  type FetchLike,
} from "./types.ts";
import { strictRecord, withInputValidation } from "./validation.ts";

export interface ResolvedClientOptions {
  readonly apiKey: string;
  readonly fetch: FetchLike;
  readonly timeoutMs: number;
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxBase64Bytes: number;
}

function boundedOption(
  value: unknown,
  fallback: number,
  maximum: number,
  provider: AzureProviderId,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 ||
    value > maximum
  ) {
    throw invalidInput(provider, field);
  }
  return value;
}

export function resolveClientOptions(
  value: AzureProviderClientOptions,
  provider: AzureProviderId,
): ResolvedClientOptions {
  return withInputValidation(provider, () => {
    const options = strictRecord(
      value,
      [
        "apiKey",
        "fetch",
        "timeoutMs",
        "maxRequestBytes",
        "maxResponseBytes",
        "maxBase64Bytes",
      ],
      provider,
      "options",
    );
    if (
      typeof options.apiKey !== "string" || options.apiKey.length === 0 ||
      options.apiKey.length > 4_096 || /[\r\n]/.test(options.apiKey)
    ) {
      throw invalidInput(provider, "options.apiKey");
    }
    if (typeof options.fetch !== "function") {
      throw invalidInput(provider, "options.fetch");
    }
    return {
      apiKey: options.apiKey,
      fetch: options.fetch as FetchLike,
      timeoutMs: boundedOption(
        options.timeoutMs,
        AZURE_PROVIDER_LIMITS.defaultTimeoutMs,
        AZURE_PROVIDER_LIMITS.maxTimeoutMs,
        provider,
        "options.timeoutMs",
      ),
      maxRequestBytes: boundedOption(
        options.maxRequestBytes,
        AZURE_PROVIDER_LIMITS.defaultMaxRequestBytes,
        AZURE_PROVIDER_LIMITS.maxRequestBytes,
        provider,
        "options.maxRequestBytes",
      ),
      maxResponseBytes: boundedOption(
        options.maxResponseBytes,
        AZURE_PROVIDER_LIMITS.defaultMaxResponseBytes,
        AZURE_PROVIDER_LIMITS.maxResponseBytes,
        provider,
        "options.maxResponseBytes",
      ),
      maxBase64Bytes: boundedOption(
        options.maxBase64Bytes,
        AZURE_PROVIDER_LIMITS.defaultMaxBase64Bytes,
        AZURE_PROVIDER_LIMITS.maxBase64Bytes,
        provider,
        "options.maxBase64Bytes",
      ),
    };
  });
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const value = raw.trim();
  let milliseconds: number;
  if (/^\d+$/.test(value)) {
    milliseconds = Number(value) * 1_000;
  } else {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return undefined;
    milliseconds = Math.max(0, date - Date.now());
  }
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    return undefined;
  }
  return Math.min(milliseconds, 24 * 60 * 60 * 1_000);
}

function statusError(
  provider: AzureProviderId,
  response: Response,
): AzureProviderError {
  const status = response.status;
  if (status === 401) {
    return new AzureProviderError({
      provider,
      classification: "authentication",
      status,
    });
  }
  if (status === 403) {
    return new AzureProviderError({
      provider,
      classification: "authorization",
      status,
    });
  }
  if (status === 422) {
    return new AzureProviderError({
      provider,
      classification: "unprocessable_entity",
      status,
    });
  }
  if (status === 429) {
    return new AzureProviderError({
      provider,
      classification: "rate_limit",
      retryable: true,
      retryAfterMs: retryAfterMs(response),
      status,
    });
  }
  if (status >= 500 && status <= 599) {
    return new AzureProviderError({
      provider,
      classification: "server_error",
      retryable: true,
      status,
    });
  }
  return new AzureProviderError({
    provider,
    classification: "client_error",
    status,
  });
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  provider: AzureProviderId,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength.trim())) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maximumBytes) {
      void response.body?.cancel().catch(() => undefined);
      throw responseTooLarge(provider, "response");
    }
  }
  if (response.body === null) throw invalidResponse(provider, "response");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLarge(provider, "response");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function performRequest(
  config: ResolvedClientOptions,
  provider: AzureProviderId,
  url: string,
  body: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await config.fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body,
    redirect: "error",
    signal,
  });
  if (!(response instanceof Response)) {
    throw invalidResponse(provider, "response");
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw statusError(provider, response);
  }

  const bytes = await readBoundedBody(
    response,
    config.maxResponseBytes,
    provider,
  );
  if (bytes.byteLength === 0) throw invalidResponse(provider, "response");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidResponse(provider, "response");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse(provider, "response");
  }
}

type CancellationKind = "aborted" | "timeout";

class Cancellation extends Error {
  constructor(readonly kind: CancellationKind) {
    super(kind);
  }
}

export async function postJson(
  config: ResolvedClientOptions,
  provider: AzureProviderId,
  url: string,
  value: unknown,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  let body: string;
  try {
    body = JSON.stringify(value);
  } catch {
    throw invalidInput(provider, "request");
  }
  if (new TextEncoder().encode(body).byteLength > config.maxRequestBytes) {
    throw invalidInput(provider, "request");
  }

  if (callerSignal?.aborted) {
    throw new AzureProviderError({ provider, classification: "aborted" });
  }

  const controller = new AbortController();
  let cancellationKind: CancellationKind | undefined;
  let rejectCancellation: (error: Cancellation) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (kind: CancellationKind): void => {
    if (cancellationKind !== undefined) return;
    cancellationKind = kind;
    controller.abort();
    rejectCancellation(new Cancellation(kind));
  };
  const onCallerAbort = (): void => cancel("aborted");
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  const timer = setTimeout(() => cancel("timeout"), config.timeoutMs);

  try {
    return await Promise.race([
      performRequest(config, provider, url, body, controller.signal),
      cancellation,
    ]);
  } catch (error) {
    if (error instanceof AzureProviderError) throw error;
    if (cancellationKind === "timeout") {
      throw new AzureProviderError({
        provider,
        classification: "timeout",
        retryable: true,
      });
    }
    if (cancellationKind === "aborted") {
      throw new AzureProviderError({ provider, classification: "aborted" });
    }
    throw new AzureProviderError({
      provider,
      classification: "network_error",
      retryable: true,
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
