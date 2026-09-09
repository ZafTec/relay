export type AuthProviderName = "google" | "github";

export interface RelayUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

export interface RelaySession {
  id: string;
  userId: string;
  expiresAt: Date | null;
  activeWorkspaceId: string | null;
}

export interface RelayIdentity {
  session: RelaySession;
  user: RelayUser;
}

export interface RelayWorkspace {
  logo?: string | null;
  id: string;
  name: string;
  slug: string;
}

export interface OAuthClientProfile {
  id: string;
  name: string;
  uri: string | null;
}

export interface OAuthConsentInput {
  accept: boolean;
  scope?: string;
  claims?: string | Record<string, unknown>;
}

export interface AuthAdapter {
  getSession(): Promise<RelayIdentity | null>;
  signIn(provider: AuthProviderName, callbackURL: string): Promise<void>;
  signOut(): Promise<void>;
  getActiveWorkspace(): Promise<RelayWorkspace | null>;
  listWorkspaces(): Promise<RelayWorkspace[]>;
  setActiveWorkspace(workspaceId: string): Promise<void>;
  getOAuthClient(clientId: string): Promise<OAuthClientProfile>;
  submitOAuthConsent(input: OAuthConsentInput): Promise<void>;
  continueOAuthWorkspace(): Promise<void>;
}

export class AuthAdapterError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    message: string,
    options: { status?: number; code?: string } = {},
  ) {
    super(message);
    this.name = "AuthAdapterError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}
