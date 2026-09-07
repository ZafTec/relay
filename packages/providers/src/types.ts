export type AzureProviderId =
  | "azure-gpt-image-2"
  | "azure-flux-2-pro"
  | "azure-mistral-ocr";

export type FetchLike = typeof globalThis.fetch;

export interface AzureProviderClientOptions {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly fetch: FetchLike;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxBase64Bytes?: number;
}

export interface ProviderCallOptions {
  readonly signal?: AbortSignal;
}

export interface AzureProviderLimits {
  readonly defaultTimeoutMs: number;
  readonly maxTimeoutMs: number;
  readonly defaultMaxRequestBytes: number;
  readonly maxRequestBytes: number;
  readonly defaultMaxResponseBytes: number;
  readonly maxResponseBytes: number;
  readonly defaultMaxBase64Bytes: number;
  readonly maxBase64Bytes: number;
}

export const AZURE_PROVIDER_LIMITS: AzureProviderLimits = Object.freeze({
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 300_000,
  defaultMaxRequestBytes: 96 * 1024 * 1024,
  maxRequestBytes: 128 * 1024 * 1024,
  defaultMaxResponseBytes: 96 * 1024 * 1024,
  maxResponseBytes: 128 * 1024 * 1024,
  defaultMaxBase64Bytes: 64 * 1024 * 1024,
  maxBase64Bytes: 64 * 1024 * 1024,
});

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
