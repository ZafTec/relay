export const REDACTED_VALUE = "[redacted]";
export const INVALID_VALUE = "[invalid]";
export const TRUNCATED_VALUE = "[truncated]";
export const UNKNOWN_ROUTE = "/__unknown__";

export const TELEMETRY_VALUE_LIMITS = {
  messageCharacters: 512,
  identifierCharacters: 128,
  routeCharacters: 192,
  traceStateCharacters: 512,
} as const;

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (
      (code <= 31 && code !== 9 && code !== 10 && code !== 13) || code === 127
    ) {
      return true;
    }
  }
  return false;
}

const URL_PATTERN = /(?:https?|s3|postgres(?:ql)?|redis):\/\/|\bwww\./i;
const QUERY_PARAMETER_PATTERN = /(?:\?|&)[^\s&=]{1,64}=/i;
const AUTHORIZATION_PATTERN = /(?:^|\s)(?:bearer|basic)\s+[^\s,;]+/i;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/;
const TOKEN_PREFIX_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/;
const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /(?:authorization|proxy[-_ ]?authorization|cookie|set[-_ ]?cookie|password|passphrase|secret|token|credential|api[-_ ]?key|private[-_ ]?key|client[-_ ]?secret|oauth[-_ ]?(?:code|state|token)|signed[-_ ]?url|object[-_ ]?key|prompt|file[-_ ]?contents?|provider[-_ ]?(?:payload|result)|request[-_. ]?body|response[-_. ]?body|sql[-_ ]?(?:query|parameters?|values?)|db[-_. ]?statement|bullmq[-_ ]?(?:options|results?|progress|failure)|failure[-_ ]?reason)\s*(?:=|:|=>)\s*\S+/i;
const SQL_TEXT_PATTERN =
  /\b(?:select|insert|update|delete|merge|call)\b[\s\S]{0,256}\b(?:from|into|set|where|values)\b/i;

const RAW_IDENTIFIER_PATTERNS = [
  /^\d+$/,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/,
  /^[0-9a-f]{16,}$/i,
  /^(?=[A-Za-z0-9_-]{24,}$)(?=.*\d)[A-Za-z0-9_-]+$/,
] as const;

/**
 * Returns true when a string resembles material that policy forbids in logs or
 * telemetry attributes. The check is intentionally conservative: replacing a
 * diagnostic message is preferable to exporting a credential or payload.
 */
export function containsSensitiveTelemetry(value: string): boolean {
  return containsControlCharacter(value) ||
    URL_PATTERN.test(value) ||
    QUERY_PARAMETER_PATTERN.test(value) ||
    AUTHORIZATION_PATTERN.test(value) ||
    JWT_PATTERN.test(value) ||
    TOKEN_PREFIX_PATTERN.test(value) ||
    PRIVATE_KEY_PATTERN.test(value) ||
    SENSITIVE_ASSIGNMENT_PATTERN.test(value) ||
    SQL_TEXT_PATTERN.test(value);
}

export function sanitizeTelemetryText(
  value: unknown,
  maxCharacters: number = TELEMETRY_VALUE_LIMITS.messageCharacters,
): string {
  if (typeof value !== "string") return INVALID_VALUE;

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized === "") return INVALID_VALUE;
  if (containsSensitiveTelemetry(normalized)) return REDACTED_VALUE;
  if (normalized.length <= maxCharacters) return normalized;

  const retained = Math.max(0, maxCharacters - TRUNCATED_VALUE.length);
  return `${normalized.slice(0, retained)}${TRUNCATED_VALUE}`;
}

export function sanitizeIdentifier(
  value: unknown,
  maxCharacters: number = TELEMETRY_VALUE_LIMITS.identifierCharacters,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized === "" ||
    normalized.length > maxCharacters ||
    containsSensitiveTelemetry(normalized) ||
    !/^[A-Za-z][A-Za-z0-9._:/{}*-]*$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function sanitizeVersion(
  value: unknown,
  maxCharacters = 64,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized === "" ||
    normalized.length > maxCharacters ||
    containsSensitiveTelemetry(normalized) ||
    !/^[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function looksLikeRawIdentifier(value: string): boolean {
  return RAW_IDENTIFIER_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Accepts only route templates. It never falls back to a request URL or raw
 * path, because those can contain OAuth values, object keys, and identifiers.
 */
export function sanitizeRouteTemplate(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_ROUTE;
  const route = value.trim();
  if (
    route === "" ||
    route.length > TELEMETRY_VALUE_LIMITS.routeCharacters ||
    !route.startsWith("/") ||
    route.includes("?") ||
    route.includes("#") ||
    route.includes("\\") ||
    route.includes("%") ||
    containsControlCharacter(route)
  ) {
    return UNKNOWN_ROUTE;
  }
  if (route === "/") return route;

  const segments = route.split("/").slice(1);
  for (const segment of segments) {
    if (segment === "") continue;
    if (
      segment === "*" ||
      /^:[A-Za-z][A-Za-z0-9_]*\??$/.test(segment) ||
      /^\{[A-Za-z][A-Za-z0-9_]*\}$/.test(segment)
    ) {
      continue;
    }
    if (
      (segment !== ".well-known" &&
        !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(segment)) ||
      looksLikeRawIdentifier(segment)
    ) {
      return UNKNOWN_ROUTE;
    }
  }

  return route;
}

const HTTP_METHODS = new Set([
  "CONNECT",
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
  "QUERY",
  "TRACE",
]);

export function normalizeHttpMethod(value: unknown): string {
  if (typeof value !== "string") return "_OTHER";
  const method = value.toUpperCase();
  return HTTP_METHODS.has(method) ? method : "_OTHER";
}

export function httpStatusClass(status: unknown): string {
  if (!Number.isInteger(status)) return "unknown";
  const statusCode = Number(status);
  return statusCode >= 100 && statusCode <= 599
    ? `${Math.floor(statusCode / 100)}xx`
    : "unknown";
}
