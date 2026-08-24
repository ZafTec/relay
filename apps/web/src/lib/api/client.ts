export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function errorDetails(body: unknown, status: number): { message: string; code: string | null } {
  const record = asRecord(body);
  const error = asRecord(record?.error);
  return {
    message: typeof error?.message === "string"
      ? error.message
      : `Relay API returned HTTP ${status}.`,
    code: typeof error?.code === "string" ? error.code : null,
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
  const body: unknown = contentType.includes("application/json")
    ? await response.json()
    : null;

  if (!response.ok) {
    const details = errorDetails(body, response.status);
    throw new ApiError(details.message, response.status, details.code);
  }

  return body as T;
}
