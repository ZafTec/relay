export interface StatusBuildInfo {
  readonly version: string;
  readonly revision: string;
}

export interface StatusReadinessCheck {
  readonly name: string;
  readonly status: "ok" | "error";
  readonly message?: string;
}

export interface StatusReadinessReport {
  readonly service: string;
  readonly status: "ok" | "degraded";
  readonly checks: readonly StatusReadinessCheck[];
}

export type StatusReadinessSnapshot =
  | {
      readonly kind: "operational";
      readonly readiness: StatusReadinessReport;
    }
  | {
      readonly kind: "degraded";
      readonly readiness: StatusReadinessReport;
    }
  | {
      readonly kind: "unknown";
      readonly message: string;
    };

export type StatusBuildSnapshot =
  | { readonly kind: "available"; readonly build: StatusBuildInfo }
  | { readonly kind: "unknown"; readonly message: string };

export interface StatusSnapshot {
  readonly readiness: StatusReadinessSnapshot;
  readonly build: StatusBuildSnapshot;
}

export interface StatusAdapter {
  loadReadiness(signal?: AbortSignal): Promise<StatusReadinessSnapshot>;
  loadBuild(signal?: AbortSignal): Promise<StatusBuildSnapshot>;
}

interface JsonResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

const STATUS_REQUEST_TIMEOUT_MS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function parseBuildInfo(value: unknown): StatusBuildInfo | null {
  const record = asRecord(value);
  const version = nonEmptyString(record?.version);
  const revision = nonEmptyString(record?.revision);

  return version && revision ? { version, revision } : null;
}

function parseReadinessCheck(value: unknown): StatusReadinessCheck | null {
  const record = asRecord(value);
  const name = nonEmptyString(record?.name);
  const status = record?.status;
  const message = record?.message;

  if (!name || (status !== "ok" && status !== "error")) return null;
  if (message !== undefined && typeof message !== "string") return null;

  return message ? { name, status, message } : { name, status };
}

function parseReadinessReport(value: unknown): StatusReadinessReport | null {
  const record = asRecord(value);
  const service = nonEmptyString(record?.service);
  const status = record?.status;
  const rawChecks = record?.checks;

  if (!service || (status !== "ok" && status !== "degraded") || !Array.isArray(rawChecks)) {
    return null;
  }

  const checks = rawChecks.map(parseReadinessCheck);
  if (checks.some((check) => check === null)) return null;

  return {
    service,
    status,
    checks: checks as StatusReadinessCheck[],
  };
}

function isNamedError(error: unknown, name: string): boolean {
  return asRecord(error)?.name === name;
}


function isTimeoutError(error: unknown): boolean {
  return isNamedError(error, "TimeoutError");
}

async function requestJson(path: string, signal?: AbortSignal): Promise<JsonResponse> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });

  const timeout = window.setTimeout(() => {
    controller.abort(new DOMException("The status request timed out.", "TimeoutError"));
  }, STATUS_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(path, {
      signal: controller.signal,
      cache: "no-store",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    const contentType = response.headers.get("content-type") ?? "";

    if (!contentType.includes("application/json")) {
      throw new Error(`Relay returned a non-JSON response for ${path}.`);
    }

    return {
      status: response.status,
      ok: response.ok,
      body: await response.json() as unknown,
    };
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

async function loadReadiness(signal?: AbortSignal): Promise<StatusReadinessSnapshot> {
  try {
    const response = await requestJson("/health/ready", signal);
    if (!response.ok && response.status !== 503) {
      throw new Error("Relay readiness did not return a supported response.");
    }

    const readiness = parseReadinessReport(response.body);
    if (!readiness) throw new Error("Relay readiness returned an invalid payload.");

    const degraded = response.status === 503
      || readiness.status === "degraded"
      || readiness.checks.some((check) => check.status === "error");
    return { kind: degraded ? "degraded" : "operational", readiness };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      kind: "unknown",
      message: isTimeoutError(error)
        ? "Relay readiness did not respond before the request timed out."
        : "Relay readiness could not be verified. The service may still be available.",
    };
  }
}

async function loadBuild(signal?: AbortSignal): Promise<StatusBuildSnapshot> {
  try {
    const response = await requestJson("/version", signal);
    if (!response.ok) throw new Error("Relay version could not be loaded.");

    const build = parseBuildInfo(response.body);
    if (!build) throw new Error("Relay version returned an invalid payload.");
    return { kind: "available", build };
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      kind: "unknown",
      message: isTimeoutError(error)
        ? "Build identity did not respond before the request timed out."
        : "Build identity could not be verified.",
    };
  }
}

export const httpStatusAdapter: StatusAdapter = {
  loadReadiness,
  loadBuild,
};
