import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  INVALID_REQUEST,
  type McpHttpHandler,
  PARSE_ERROR,
} from "@modelcontextprotocol/server";
import type {
  AuthConnectionInfo,
  AuthorizedMcpPrincipal,
  McpRequestHandler,
  ProtectMcpOptions,
} from "@relay/auth";
import type { ApplicationServices } from "@relay/application";
import { getToolResultSchema, TOOL_KEY_PATTERN } from "@relay/contracts";
import {
  createRelayMcpServer,
  RELAY_MCP_MANAGEMENT_TOOL_SCOPES,
  RELAY_MCP_SCOPES,
} from "@relay/mcp";

// Allows a 4 MiB file encoded as base64 plus bounded JSON metadata.
export const DEFAULT_MAX_MCP_BODY_BYTES = 6 * 1024 * 1024;
const PRINCIPAL_EXTRA_KEY = "io.relay/principal";

export interface McpHttpAuth {
  readonly mcpResource: string;
  readonly authorizeMcpClaims: (
    claims: unknown,
  ) => Promise<AuthorizedMcpPrincipal | null>;
  readonly requireMcpScopes: (
    grantedScopes: readonly string[],
    requiredScopes: readonly string[],
  ) => void;
  readonly protectMcp: (
    handler: McpRequestHandler,
    options?: ProtectMcpOptions,
  ) => (
    request: Request,
    connection?: AuthConnectionInfo,
  ) => Promise<Response>;
}

export interface RelayMcpHttpHandlerOptions {
  readonly auth: McpHttpAuth;
  readonly services: ApplicationServices;
  readonly allowedHostnames?: readonly string[];
  readonly allowedOrigins?: readonly string[];
  readonly maxBodyBytes?: number;
  readonly serverInfo?: {
    readonly name: string;
    readonly version: string;
  };
  readonly onerror?: (error: Error) => void;
}

export interface RelayMcpHttpHandler {
  fetch(request: Request, connection?: AuthConnectionInfo): Promise<Response>;
  close(): Promise<void>;
}

interface BoundedJsonRequest {
  readonly request: Request;
  readonly parsedBody: unknown;
}

function positiveBodyLimit(value: number | undefined): number {
  const selected = value ?? DEFAULT_MAX_MCP_BODY_BYTES;
  if (
    !Number.isSafeInteger(selected) || selected < 1 ||
    selected > 8 * 1024 * 1024
  ) {
    throw new TypeError("maxBodyBytes must be between 1 and 8388608");
  }
  return selected;
}

function configuredHostnames(
  values: readonly string[] | undefined,
  resource: URL,
): string[] {
  const selected = values ?? [resource.hostname];
  if (selected.length === 0) {
    throw new TypeError("allowedHostnames is required");
  }
  return selected.map((value) => {
    const normalized = value.trim().toLowerCase();
    if (
      normalized.length === 0 || normalized !== value.toLowerCase() ||
      (normalized.includes(":") &&
        !(normalized.startsWith("[") && normalized.endsWith("]"))) ||
      normalized.includes("/") || /[\r\n\0]/.test(normalized)
    ) {
      throw new TypeError(
        "allowedHostnames must contain hostnames without ports",
      );
    }
    return normalized;
  });
}

function configuredOrigins(
  values: readonly string[] | undefined,
  resource: URL,
): ReadonlySet<string> {
  const selected = values ?? [resource.origin];
  const origins = new Set<string>();
  for (const value of selected) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new TypeError("allowedOrigins must contain absolute origins");
    }
    if (
      parsed.username !== "" || parsed.password !== "" ||
      parsed.pathname !== "/" ||
      parsed.search !== "" || parsed.hash !== "" ||
      (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    ) {
      throw new TypeError("allowedOrigins must contain absolute origins");
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function jsonRpcError(
  status: number,
  code: number,
  message: string,
  headers: HeadersInit = {},
): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...headers,
      },
    },
  );
}

function originRejection(
  request: Request,
  allowedOrigins: ReadonlySet<string>,
): Response | undefined {
  const value = request.headers.get("origin");
  if (value === null || value === "") return undefined;
  let origin: string;
  try {
    const parsed = new URL(value);
    if (parsed.origin !== value) throw new TypeError("non-canonical origin");
    origin = parsed.origin;
  } catch {
    return jsonRpcError(403, INVALID_REQUEST, "Invalid Origin header");
  }
  return allowedOrigins.has(origin)
    ? undefined
    : jsonRpcError(403, INVALID_REQUEST, "Origin not allowed");
}

function methodRejection(): Response {
  return jsonRpcError(405, INVALID_REQUEST, "Method not allowed", {
    allow: "POST",
  });
}

function requireJsonContentType(request: Request): Response | undefined {
  const encoding = request.headers.get("content-encoding")?.trim()
    .toLowerCase();
  if (encoding !== undefined && encoding !== "" && encoding !== "identity") {
    return jsonRpcError(415, INVALID_REQUEST, "Unsupported Content-Encoding");
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]
    .trim().toLowerCase();
  return contentType === "application/json" ? undefined : jsonRpcError(
    415,
    INVALID_REQUEST,
    "Content-Type must be application/json",
  );
}

async function boundedJsonRequest(
  request: Request,
  maxBodyBytes: number,
): Promise<BoundedJsonRequest | Response> {
  const contentTypeRejection = requireJsonContentType(request);
  if (contentTypeRejection !== undefined) return contentTypeRejection;

  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength)) {
      return jsonRpcError(400, INVALID_REQUEST, "Invalid Content-Length");
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      return jsonRpcError(400, INVALID_REQUEST, "Invalid Content-Length");
    }
    if (parsedLength > maxBodyBytes) {
      return jsonRpcError(413, INVALID_REQUEST, "Request body too large");
    }
  }
  if (request.body === null) {
    return jsonRpcError(400, INVALID_REQUEST, "Request body is required");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBodyBytes) {
        await reader.cancel();
        return jsonRpcError(413, INVALID_REQUEST, "Request body too large");
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
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return jsonRpcError(400, PARSE_ERROR, "Invalid UTF-8 JSON body");
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    return jsonRpcError(400, PARSE_ERROR, "Malformed JSON body");
  }

  const envelope = parsedBody as {
    method?: unknown;
    params?: { name?: unknown };
  } | null;
  if (
    bytes.byteLength > 64 * 1024 &&
    (envelope?.method !== "tools/call" ||
      envelope?.params?.name !== "relay.artifacts.upload_content")
  ) {
    return jsonRpcError(
      413,
      INVALID_REQUEST,
      "Only inline file uploads may exceed 64 KiB",
    );
  }

  const headers = new Headers(request.headers);
  headers.set("content-length", String(bytes.byteLength));
  return {
    request: new Request(request.url, {
      method: "POST",
      headers,
      body: bytes,
      signal: request.signal,
    }),
    parsedBody,
  };
}

async function requiredScopesForBody(
  body: unknown,
  services: ApplicationServices,
  principal: AuthorizedMcpPrincipal,
): Promise<readonly string[]> {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return [];
  }
  const request = body as Record<string, unknown>;
  if (request.method !== "tools/call") return [];
  const params = request.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    return [];
  }
  const name = (params as Record<string, unknown>).name;
  if (typeof name !== "string") return [];
  const management = RELAY_MCP_MANAGEMENT_TOOL_SCOPES[
    name as keyof typeof RELAY_MCP_MANAGEMENT_TOOL_SCOPES
  ];
  if (management !== undefined) {
    const args = (params as Record<string, unknown>).arguments;
    if (
      (name === "relay.artifacts.upload_content" ||
        name === "relay.artifacts.get_access") &&
      typeof args === "object" && args !== null && "access" in args &&
      args.access === "permanent"
    ) {
      return [...management, "artifacts:share"];
    }
    return management;
  }
  if (name.length > 128 || !TOOL_KEY_PATTERN.test(name)) return [];
  try {
    const result = getToolResultSchema.parse(
      await services.tools.get(
        {
          workspaceId: principal.workspaceId,
          actorUserId: principal.actorUserId,
        },
        name,
      ),
    );
    return result.kind === "found" ? ["tools:execute"] : [];
  } catch {
    return [];
  }
}

function accessToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return null;
  const match = /^(?:Bearer|DPoP) ([^\s]+)$/i.exec(authorization);
  return match?.[1] ?? null;
}

function principalFromAuthInfo(
  authInfo: AuthInfo | undefined,
): AuthorizedMcpPrincipal {
  const value = authInfo?.extra?.[PRINCIPAL_EXTRA_KEY];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("verified MCP principal is missing");
  }
  const principal = value as Partial<AuthorizedMcpPrincipal>;
  if (
    typeof principal.actorUserId !== "string" ||
    typeof principal.workspaceId !== "string" ||
    typeof principal.clientId !== "string" ||
    !Array.isArray(principal.scopes) ||
    principal.scopes.some((scope) => typeof scope !== "string")
  ) {
    throw new TypeError("verified MCP principal is invalid");
  }
  return principal as AuthorizedMcpPrincipal;
}

export function createRelayMcpHttpHandler(
  options: RelayMcpHttpHandlerOptions,
): RelayMcpHttpHandler {
  if (options?.auth === undefined) throw new TypeError("auth is required");
  if (options.services === undefined) {
    throw new TypeError("services are required");
  }
  const resource = new URL(options.auth.mcpResource);
  const allowedHostnames = configuredHostnames(
    options.allowedHostnames,
    resource,
  );
  const allowedOrigins = configuredOrigins(options.allowedOrigins, resource);
  const maxBodyBytes = positiveBodyLimit(options.maxBodyBytes);

  const protocol: McpHttpHandler = createMcpHandler(
    (context) => {
      const principal = principalFromAuthInfo(context.authInfo);
      return createRelayMcpServer({
        services: options.services,
        principal: {
          identity: {
            workspaceId: principal.workspaceId,
            actorUserId: principal.actorUserId,
          },
          clientId: principal.clientId,
          scopes: principal.scopes,
        },
        serverInfo: options.serverInfo,
      });
    },
    {
      legacy: "reject",
      responseMode: "auto",
      onerror: options.onerror,
    },
  );

  return {
    async fetch(request, connection) {
      const hostRejection = hostHeaderValidationResponse(
        request,
        allowedHostnames,
      );
      if (hostRejection !== undefined) return hostRejection;
      const rejectedOrigin = originRejection(request, allowedOrigins);
      if (rejectedOrigin !== undefined) return rejectedOrigin;

      const url = new URL(request.url);
      if (url.pathname !== resource.pathname || url.search !== "") {
        return jsonRpcError(404, INVALID_REQUEST, "MCP endpoint not found");
      }
      if (request.method !== "POST") return methodRejection();

      const bounded = await boundedJsonRequest(request, maxBodyBytes);
      if (bounded instanceof Response) return bounded;
      const protectedHandler = options.auth.protectMcp(
        async (protectedRequest, claims) => {
          const principal = await options.auth.authorizeMcpClaims(claims);
          if (principal === null) {
            return jsonRpcError(403, INVALID_REQUEST, "MCP access denied");
          }
          const requiredScopes = await requiredScopesForBody(
            bounded.parsedBody,
            options.services,
            principal,
          );
          options.auth.requireMcpScopes(principal.scopes, requiredScopes);
          const token = accessToken(protectedRequest);
          if (token === null) {
            return jsonRpcError(
              401,
              INVALID_REQUEST,
              "Authentication required",
            );
          }
          return await protocol.fetch(protectedRequest, {
            parsedBody: bounded.parsedBody,
            authInfo: {
              token,
              clientId: principal.clientId,
              scopes: [...principal.scopes],
              resource,
              extra: { [PRINCIPAL_EXTRA_KEY]: principal },
            },
          });
        },
        { challengeScopes: RELAY_MCP_SCOPES },
      );
      return await protectedHandler(bounded.request, connection);
    },
    close: () => protocol.close(),
  };
}
