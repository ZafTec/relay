import { APIError } from "better-auth/api";

const METHODS = new Set(["none", "client_secret_basic", "client_secret_post"]);
const SERVER_FIELDS = new Set([
  "user_id",
  "reference_id",
  "metadata",
  "client_credentials_scopes",
  "jwks",
  "jwks_uri",
  "backchannel_logout_uri",
  "backchannel_logout_session_required",
  "software_statement",
  "sector_identifier_uri",
]);

function invalid(description: string): never {
  throw new APIError("BAD_REQUEST", {
    error: "invalid_client_metadata",
    error_description: description,
  });
}

/** No remote metadata is fetched; redirects are exact HTTPS or native loopback URLs. */
export function safeClientRedirect(value: unknown): boolean {
  if (
    typeof value !== "string" || value.length > 2048 ||
    /[\\*\s]/.test(value) ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  ) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || value.includes("#")) {
      return false;
    }
    if (url.protocol === "http:") {
      return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\//.test(value);
    }
    return /^https:\/\/[^/]/i.test(value) && url.protocol === "https:" &&
      url.hostname.includes(".") &&
      !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(":") &&
      !/(?:^|\.)(?:localhost|local|internal|test-invalid)$/.test(
        url.hostname,
      ) &&
      !url.hostname.endsWith(".");
  } catch {
    return false;
  }
}

/** Tighten optional provider extensions at the shared registration/update boundary. */
export function validateRelayClientMetadata(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid("Expected client metadata.");
  }
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => SERVER_FIELDS.has(key))) {
    invalid(
      "Remote client metadata, machine grants and ownership overrides are not supported.",
    );
  }
  if (
    body.skip_consent === true || body.require_pkce === false ||
    body.enable_end_session === true
  ) {
    invalid("Relay clients require consent and PKCE.");
  }
  if (body.redirect_uris !== undefined) {
    if (
      !Array.isArray(body.redirect_uris) || body.redirect_uris.length < 1 ||
      body.redirect_uris.length > 10 ||
      !body.redirect_uris.every(safeClientRedirect)
    ) invalid("Use 1-10 exact HTTPS callback URLs or HTTP loopback callbacks.");
  }
  if (body.post_logout_redirect_uris !== undefined) {
    invalid("Client logout redirects are not supported.");
  }
  if (
    body.token_endpoint_auth_method !== undefined &&
    !METHODS.has(String(body.token_endpoint_auth_method))
  ) {
    invalid(
      "Use a public PKCE client or a client secret authentication method.",
    );
  }
  if (
    body.grant_types !== undefined && (!Array.isArray(body.grant_types) ||
      body.grant_types.some((grant) =>
        grant !== "authorization_code" && grant !== "refresh_token"
      ))
  ) {
    invalid("Only user-authorized code and refresh grants are supported.");
  }
  if (
    body.client_name !== undefined &&
    (typeof body.client_name !== "string" ||
      body.client_name.trim().length < 1 ||
      body.client_name.length > 120 ||
      [...body.client_name].some((character) => character.charCodeAt(0) < 32))
  ) invalid("Use a short client display name.");
}

export function requireS256Authorization(
  query: Record<string, unknown> | undefined,
): void {
  if (
    !query || query.code_challenge_method !== "S256" ||
    typeof query.code_challenge !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(query.code_challenge)
  ) {
    throw new APIError("BAD_REQUEST", {
      error: "invalid_request",
      error_description: "Relay requires PKCE with an S256 challenge.",
    });
  }
}
