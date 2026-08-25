import type {
  AuthAdapter,
  AuthProviderName,
  OAuthClientProfile,
  OAuthConsentInput,
  RelayIdentity,
  RelayWorkspace,
} from "./types";

export interface TestAuthAdapterOptions {
  identity?: RelayIdentity | null;
  activeWorkspace?: RelayWorkspace | null;
  workspaces?: RelayWorkspace[];
  oauthClient?: OAuthClientProfile;
}

export function createTestAuthAdapter(options: TestAuthAdapterOptions = {}): AuthAdapter {
  let activeWorkspace = options.activeWorkspace ?? null;
  const workspaces = options.workspaces ?? (activeWorkspace ? [activeWorkspace] : []);

  return {
    getSession: async () => options.identity ?? null,
    signIn: async (_provider: AuthProviderName, _callbackURL: string) => undefined,
    signOut: async () => undefined,
    getActiveWorkspace: async () => activeWorkspace,
    listWorkspaces: async () => workspaces,
    setActiveWorkspace: async (workspaceId: string) => {
      activeWorkspace = workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
    },
    getOAuthClient: async (_clientId: string) => options.oauthClient ?? {
      id: "test-client",
      name: "Test MCP client",
      uri: null,
    },
    submitOAuthConsent: async (_input: OAuthConsentInput) => undefined,
    continueOAuthWorkspace: async () => undefined,
  };
}
