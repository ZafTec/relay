export type ApiJsonPrimitive = boolean | number | string | null;
export type ApiJsonValue = ApiJsonPrimitive | ApiJsonObject | readonly ApiJsonValue[];
export interface ApiJsonObject {
  readonly [key: string]: ApiJsonValue;
}

export interface ApiResponseMetadata {
  readonly status: number;
  readonly requestId: string | null;
  readonly retryable: boolean | null;
  readonly retryAfter: string | null;
  readonly retryAfterSeconds: number | null;
  readonly location: string | null;
}

export interface ApiJsonResponse<T> extends ApiResponseMetadata {
  readonly data: T;
}

export class ApiError extends Error implements ApiResponseMetadata {
  readonly status: number;
  readonly code: string | null;
  readonly details: ApiJsonObject | null;
  readonly requestId: string | null;
  readonly retryable: boolean | null;
  readonly retryAfter: string | null;
  readonly retryAfterSeconds: number | null;
  readonly location: string | null;

  constructor(
    message: string,
    status: number,
    code: string | null = null,
    details: ApiJsonObject | null = null,
    requestId: string | null = null,
    retryable: boolean | null = null,
    retryAfter: string | null = null,
    retryAfterSeconds: number | null = null,
    location: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
    this.retryAfterSeconds = retryAfterSeconds;
    this.location = location;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
    || (
      Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null
    )
  ) {
    return null;
  }
  return value as Record<string, unknown>;
}

function isJsonValue(value: unknown): value is ApiJsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  const object = asRecord(value);
  return object !== null && Object.values(object).every(isJsonValue);
}

function asJsonObject(value: unknown): ApiJsonObject | null {
  const object = asRecord(value);
  return object !== null && isJsonValue(object) ? object : null;
}

function retryAfterSeconds(
  error: Record<string, unknown> | null,
  retryAfter: string | null,
): number | null {
  if (
    Number.isSafeInteger(error?.retryAfterSeconds)
    && (error?.retryAfterSeconds as number) >= 0
  ) {
    return error?.retryAfterSeconds as number;
  }
  if (retryAfter !== null && /^(?:0|[1-9][0-9]*)$/.test(retryAfter)) {
    const parsed = Number(retryAfter);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function responseMetadata(
  response: Response,
  error: Record<string, unknown> | null = null,
): ApiResponseMetadata {
  const retryAfter = response.headers.get("retry-after");
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    retryable: typeof error?.retryable === "boolean" ? error.retryable : null,
    retryAfter,
    retryAfterSeconds: retryAfterSeconds(error, retryAfter),
    location: response.headers.get("location"),
  };
}

function errorDetails(
  body: unknown,
  status: number,
  fallbackRequestId: string | null,
): {
  message: string;
  code: string | null;
  details: ApiJsonObject | null;
  requestId: string | null;
  error: Record<string, unknown> | null;
} {
  const record = asRecord(body);
  const error = asRecord(record?.error);
  return {
    message: typeof error?.message === "string"
      ? error.message
      : `Relay API returned HTTP ${status}.`,
    code: typeof error?.code === "string" ? error.code : null,
    details: asJsonObject(error?.details),
    requestId: typeof error?.requestId === "string"
      ? error.requestId
      : fallbackRequestId,
    error,
  };
}

export async function fetchJsonResponse<T>(
  path: string,
  init: RequestInit = {},
): Promise<ApiJsonResponse<T>> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers,
  });

  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown = null;
  if (contentType.includes("application/json")) {
    if (response.ok) {
      body = await response.json();
    } else {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    }
  }

  if (!response.ok) {
    const details = errorDetails(
      body,
      response.status,
      response.headers.get("x-request-id"),
    );
    const metadata = responseMetadata(response, details.error);
    throw new ApiError(
      details.message,
      response.status,
      details.code,
      details.details,
      details.requestId,
      metadata.retryable,
      metadata.retryAfter,
      metadata.retryAfterSeconds,
      metadata.location,
    );
  }

  return {
    data: body as T,
    ...responseMetadata(response),
  };
}

export async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  return (await fetchJsonResponse<T>(path, init)).data;
}
