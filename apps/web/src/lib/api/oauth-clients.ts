import { ApiError, fetchJsonResponse } from "./client";

export interface ManagedOAuthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
}

export interface OAuthClientCredentials extends ManagedOAuthClient {
  client_secret?: string;
}

const root = "/api/auth/oauth2";

function parseClient(value: unknown): ManagedOAuthClient {
  const client = value as Partial<ManagedOAuthClient> | null;
  if (!client || typeof client.client_id !== "string" || !client.client_id
    || !Array.isArray(client.redirect_uris) || !client.redirect_uris.every((uri) => typeof uri === "string")
    || [client.client_name, client.scope, client.token_endpoint_auth_method].some((field) => field !== undefined && typeof field !== "string")) {
    throw new TypeError("Invalid OAuth client response");
  }
  return client as ManagedOAuthClient;
}

function parseCredentials(value: unknown, requiresSecret: boolean): OAuthClientCredentials {
  const client = parseClient(value) as OAuthClientCredentials;
  if ((requiresSecret && (typeof client.client_secret !== "string" || !client.client_secret))
    || (client.client_secret !== undefined && typeof client.client_secret !== "string")) {
    throw new TypeError("Invalid OAuth credentials response");
  }
  return client;
}

export const oauthClients = {
  async list(signal?: AbortSignal): Promise<ManagedOAuthClient[]> {
    const response = await fetchJsonResponse<unknown>(`${root}/get-clients`, { signal });
    if (!Array.isArray(response.data)) throw new TypeError("Invalid OAuth client list");
    return response.data.map(parseClient);
  },
  async create(input: {
    name: string;
    redirectUris: string[];
    scopes: string[];
    authMethod: "client_secret_post" | "client_secret_basic" | "none";
  }): Promise<OAuthClientCredentials> {
    return parseCredentials((await fetchJsonResponse<unknown>(`${root}/create-client`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: input.name,
        redirect_uris: input.redirectUris,
        scope: ["openid", "offline_access", ...input.scopes].join(" "),
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: input.authMethod,
      }),
    })).data, input.authMethod !== "none");
  },
  async rotate(client: ManagedOAuthClient): Promise<OAuthClientCredentials> {
    const result = await fetchJsonResponse<{ client_secret?: unknown } | null>(`${root}/client/rotate-secret`, {
      headers: { "content-type": "application/json" },
      method: "POST", body: JSON.stringify({ client_id: client.client_id }),
    });
    return parseCredentials({ ...client, client_secret: result.data?.client_secret }, true);
  },
  async remove(clientId: string): Promise<void> {
    await fetchJsonResponse(`${root}/delete-client`, {
      headers: { "content-type": "application/json" },
      method: "POST", body: JSON.stringify({ client_id: clientId }),
    });
  },
};

export function oauthClientError(error: unknown): string {
  if (error instanceof ApiError && [401, 403].includes(error.status)) {
    return "Sign in again, then try this action again.";
  }
  if (error instanceof ApiError && error.status === 400) {
    return "Check the redirect URLs and permissions, then try again.";
  }
  return "Relay could not confirm the change. Refresh the client list before trying again. If a client was created, rotate its secret to get a new copy.";
}
