export type ApiJsonPrimitive = boolean | number | string | null;
export type ApiJsonValue = ApiJsonPrimitive | ApiJsonObject | readonly ApiJsonValue[];
export interface ApiJsonObject {
  readonly [key: string]: ApiJsonValue;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: ApiJsonObject | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    status: number,
    code: string | null = null,
    details: ApiJsonObject | null = null,
    requestId: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
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

function errorDetails(
  body: unknown,
  status: number,
  fallbackRequestId: string | null,
): {
  message: string;
  code: string | null;
  details: ApiJsonObject | null;
  requestId: string | null;
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
  };
}

export async function fetchJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "include",
    headers: {
      accept: "application/json",
      ...init.headers,
    },
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
    throw new ApiError(
      details.message,
      response.status,
      details.code,
      details.details,
      details.requestId,
    );
  }

  return body as T;
}
