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
  "mcp:tools": {
    title: "Use workspace tools",
    description: "Discover and invoke the tools available to the selected workspace.",
  },
  "mcp:read": {
    title: "Read workspace results",
    description: "Inspect authorized runs and artifact metadata in the selected workspace.",
  },
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
