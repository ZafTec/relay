import { authClient } from "./auth-client";
import {
  AuthAdapterError,
  type AuthAdapter,
  type AuthProviderName,
  type OAuthClientProfile,
  type OAuthConsentInput,
  type RelayIdentity,
  type RelayWorkspace,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(record: Record<string, unknown> | null, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date;
  }
  return null;
}

function authError(error: unknown, fallback: string): AuthAdapterError {
  const record = asRecord(error);
  const status = typeof record?.status === "number" ? record.status : undefined;
  const code = stringValue(record, "code") ?? undefined;
  const message = stringValue(record, "message") ?? fallback;
  return new AuthAdapterError(message, { status, code });
}

function normalizeWorkspace(value: unknown): RelayWorkspace | null {
  const record = asRecord(value);
  const id = stringValue(record, "id");
  const name = stringValue(record, "name");
  const slug = stringValue(record, "slug");
  return id && name && slug ? { id, name, slug } : null;
}

export const betterAuthAdapter: AuthAdapter = {
  async getSession(): Promise<RelayIdentity | null> {
    const result = await authClient.getSession();
    if (result.error) throw authError(result.error, "Relay could not check this session.");
    if (!result.data) return null;

    const root = asRecord(result.data);
    const session = asRecord(root?.session);
    const user = asRecord(root?.user);
    const sessionId = stringValue(session, "id");
    const userId = stringValue(session, "userId");
    const name = stringValue(user, "name");
    const email = stringValue(user, "email");
    const id = stringValue(user, "id");

    if (!sessionId || !userId || !name || !email || !id) {
      throw new AuthAdapterError("Relay returned an incomplete session.");
    }

    return {
      session: {
        id: sessionId,
        userId,
        expiresAt: dateValue(session?.expiresAt),
        activeWorkspaceId: stringValue(session, "activeOrganizationId"),
      },
      user: {
        id,
        name,
        email,
        image: stringValue(user, "image"),
      },
    };
  },

  async signIn(provider: AuthProviderName, callbackURL: string): Promise<void> {
    const result = await authClient.signIn.social({ provider, callbackURL });
    if (result.error) {
      throw authError(result.error, `${provider} sign-in did not complete.`);
    }
  },

  async signOut(): Promise<void> {
    const result = await authClient.signOut();
    if (result.error) throw authError(result.error, "Relay could not sign out.");
  },

  async getActiveWorkspace(): Promise<RelayWorkspace | null> {
    const result = await authClient.organization.getOrganization();
    if (result.error) {
      if (result.error.status === 404) return null;
      throw authError(result.error, "Relay could not load the active workspace.");
    }
    if (!result.data) return null;
    const workspace = normalizeWorkspace(result.data);
    if (!workspace) throw new AuthAdapterError("Relay returned an incomplete workspace.");
    return workspace;
  },

  async listWorkspaces(): Promise<RelayWorkspace[]> {
    const result = await authClient.organization.list();
    if (result.error) throw authError(result.error, "Relay could not list workspaces.");
    if (!Array.isArray(result.data)) return [];
    return result.data.map(normalizeWorkspace).filter((item): item is RelayWorkspace => item !== null);
  },

  async setActiveWorkspace(workspaceId: string): Promise<void> {
    const result = await authClient.organization.setActive({ organizationId: workspaceId });
    if (result.error) throw authError(result.error, "Relay could not set the active workspace.");
  },

  async getOAuthClient(clientId: string): Promise<OAuthClientProfile> {
    const result = await authClient.oauth2.publicClient({ query: { client_id: clientId } });
    if (result.error) throw authError(result.error, "Relay could not verify the requesting client.");
    const client = asRecord(result.data);
    const id = stringValue(client, "client_id", "clientId", "id") ?? clientId;
    const name = stringValue(client, "client_name", "name");
    if (!name) throw new AuthAdapterError("The requesting client did not provide a display name.");
    return {
      id,
      name,
      uri: stringValue(client, "client_uri", "uri"),
    };
  },

  async submitOAuthConsent(input: OAuthConsentInput): Promise<void> {
    const result = await authClient.oauth2.consent({
      accept: input.accept,
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.claims ? { claims: input.claims } : {}),
    });
    if (result.error) throw authError(result.error, "Relay could not complete consent.");
  },

  async continueOAuthWorkspace(): Promise<void> {
    const result = await authClient.oauth2.continue({ postLogin: true });
    if (result.error) throw authError(result.error, "Relay could not continue authorization.");
  },
};
