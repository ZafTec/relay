export interface OAuthRequestDetails {
  clientId: string;
  scopes: string[];
  scopeValue: string;
  claims: string | Record<string, unknown> | undefined;
}

const MAX_PARAMETER_LENGTH = 4096;

function safeParameter(value: string | null): string | null {
  if (!value || value.length > MAX_PARAMETER_LENGTH || /[\u0000-\u001F\u007F]/.test(value)) {
    return null;
  }
  return value;
}

export function readOAuthRequest(search: string): OAuthRequestDetails | null {
  const query = new URLSearchParams(search);
  const clientId = safeParameter(query.get("client_id"));
  const scopeValue = safeParameter(query.get("scope")) ?? "";
  if (!clientId) return null;

  const scopes = [...new Set(scopeValue.split(/\s+/).filter(Boolean))].slice(0, 32);
  const rawClaims = safeParameter(query.get("claims"));
  let claims: string | Record<string, unknown> | undefined;

  if (rawClaims) {
    try {
      const parsed: unknown = JSON.parse(rawClaims);
      claims = typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : rawClaims;
    } catch {
      return null;
    }
  }

  return { clientId, scopes, scopeValue, claims };
}

export interface ScopeDescription {
  scope: string;
  title: string;
  description: string;
}

const SCOPE_COPY: Record<string, Omit<ScopeDescription, "scope">> = {
  openid: {
    title: "Confirm your Relay identity",
    description: "Identify your Relay account to the requesting client.",
  },
  profile: {
    title: "Read your basic profile",
    description: "Read your name and profile details from Relay.",
  },
  email: {
    title: "Read your verified email",
    description: "Read the verified email attached to your Relay account.",
  },
  offline_access: {
    title: "Keep the connection available",
    description: "Refresh access without asking you to repeat this browser flow each time.",
  },
  "tools:read": { title: "Browse workspace tools", description: "List the tools available in this workspace and read their options." },
  "tools:execute": { title: "Run workspace tools", description: "Generate images, edit files and run OCR within your workspace's usage allowances." },
  "runs:read": { title: "Read runs and results", description: "Read run inputs, status and output details in this workspace." },
  "runs:cancel": { title: "Cancel runs", description: "Request cancellation of a workspace run." },
  "artifacts:read": { title: "Read and download files", description: "Read stored file details and create temporary download links." },
  "artifacts:write": { title: "Upload files", description: "Save file content and new versions in workspace storage." },
  "artifacts:share": { title: "Share stored files", description: "Create or revoke share links. Permanent links can let anyone who has the link download a file." },
  "usage:read": { title: "Read usage", description: "Read tool usage and storage usage for this workspace." },
  "notifications:read": { title: "Read email preferences", description: "Read your notification preferences and recent delivery status." },
  "notifications:write": { title: "Change email preferences", description: "Enable or disable emails to your verified address when your runs complete or fail." },
  "admin:allowances:read": { title: "Read usage allowances", description: "Read usage allowances across the platform. Requires a current superadmin role." },
  "admin:allowances:write": { title: "Manage usage allowance grants and revocations", description: "Change usage allowance grants and revocations across the platform. Requires explicit confirmation and a recent superadmin sign-in." },
  "admin:capacity:read": { title: "Read provider capacity", description: "Read provider capacity across the platform. Requires a current superadmin role." },
  "admin:capacity:write": { title: "Manage capacity policies and limits", description: "Change capacity policies and limits across the platform. Requires explicit confirmation and a recent superadmin sign-in." },
  "admin:superadmins:read": { title: "Read superadmin access", description: "Read superadmin access across the platform. Requires a current superadmin role." },
  "admin:superadmins:write": { title: "Manage superadmin invitations", description: "Change superadmin invitations across the platform. Requires explicit confirmation and a recent superadmin sign-in." },
  "admin:changelog:read": { title: "Read platform changelog", description: "Read platform changelog across the platform. Requires a current superadmin role." },
  "admin:changelog:write": { title: "Manage changelog drafts and publication", description: "Change changelog drafts and publication across the platform. Requires explicit confirmation and a recent superadmin sign-in." },
  "admin:oauth:read": { title: "Read OAuth clients", description: "Read OAuth clients across the platform. Requires a current superadmin role." },
  "admin:oauth:write": { title: "Manage OAuth client credentials and settings", description: "Change OAuth client credentials and settings across the platform. Requires explicit confirmation and a recent superadmin sign-in." },
};

export function describeScope(scope: string): ScopeDescription {
  const known = SCOPE_COPY[scope];
  return known
    ? { scope, ...known }
    : {
        scope,
        title: "Requested permission",
        description: "This client requested an additional permission from Relay.",
      };
}
