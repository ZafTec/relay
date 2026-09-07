import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { describeScope, readOAuthRequest } from "../../auth/oauth-request";
import { AuthAdapterError, type OAuthClientProfile } from "../../auth/types";
import { OAuthLayout } from "../../components/layout/OAuthLayout";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";

function displayHost(uri: string | null): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

export function OAuthConsentPage() {
  usePageMetadata("Authorize MCP client | Relay", "#141A16");
  const location = useLocation();
  const { adapter, workspace } = useAuth();
  const request = useMemo(() => readOAuthRequest(location.search), [location.search]);
  const [client, setClient] = useState<OAuthClientProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedScopes, setSelectedScopes] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    if (!request) {
      setLoading(false);
      return () => { active = false; };
    }
    setLoading(true);
    setSelectedScopes(request.scopes.filter((scope) => !scope.startsWith("admin:")));
    setClient(null);
    setError(null);
    void adapter.getOAuthClient(request.clientId).then((value) => {
      if (!active) return;
      setClient(value);
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError("Relay could not verify the requesting client. Authorization was not changed.");
      setLoading(false);
    });
    return () => { active = false; };
  }, [adapter, request]);

  async function submit(accept: boolean) {
    if (!request || (accept && selectedScopes.length === 0)) return;
    setError(null);
    setAction(accept ? "approve" : "deny");
    try {
      await adapter.submitOAuthConsent({
        accept,
        ...(accept ? { scope: selectedScopes.join(" ") } : {}),
        ...(request.claims ? { claims: request.claims } : {}),
      });
      setAction(null);
    } catch (caught) {
      setAction(null);
      setError(caught instanceof AuthAdapterError && caught.status === 401
        ? "The session expired before consent was saved. Sign in again to continue."
        : "Relay could not complete consent. Authorization was not changed.");
    }
  }

  return (
    <OAuthLayout>
      <section className="oauth-panel" aria-labelledby="oauth-consent-title">
        <div className="oauth-panel__heading">
          <p className="mono-label">MCP client request</p>
          <h1 id="oauth-consent-title">{client ? `Authorize ${client.name}` : "Authorize MCP client"}</h1>
          <p>
            {client
              ? `This client is asking Relay to act on your behalf in${workspace.status === "ready" ? ` ${workspace.workspace.name}` : " the active workspace"}.`
              : "Review the signed client request and requested access before granting consent."}
          </p>
          {client && displayHost(client.uri) ? <span className="oauth-client-host">{displayHost(client.uri)}</span> : null}
        </div>
        {loading ? <Skeleton label="Verifying OAuth client" lines={4} /> : null}
        {!loading && !request ? (
          <InlineNotice title="Invalid authorization request" tone="error">
            <p>The signed OAuth request is missing or malformed. Return to the MCP client and start again.</p>
          </InlineNotice>
        ) : null}
        {!loading && request && client ? (
          <>
            {error ? <InlineNotice title="Authorization not completed" tone="error"><p>{error}</p></InlineNotice> : null}

            <div className="oauth-scopes" aria-labelledby="oauth-scopes-title">
              <h2 id="oauth-scopes-title">Requested access</h2>
              <p>Choose the permissions this connection can use. You can leave permissions unchecked.</p>
              {request.scopes.some((scope) => scope.startsWith("admin:")) ? (
                <InlineNotice title="Platform administration" tone="warning">
                  <p>Admin permissions affect the whole platform. They start unchecked and require a current superadmin role and a recent sign-in. Workspace allowances still apply to tool runs.</p>
                </InlineNotice>
              ) : null}
              {request.scopes.length > 0 ? (
                <ul>
                  {request.scopes.map((scope) => {
                    const details = describeScope(scope);
                    return (
                      <li key={scope}>
                        <label className="oauth-scope-choice">
                          <input type="checkbox" checked={selectedScopes.includes(scope)} disabled={action !== null}
                            onChange={(event) => setSelectedScopes((current) => event.target.checked
                              ? [...current, scope] : current.filter((value) => value !== scope))} />
                          <span><strong>{details.title}</strong><span className="oauth-scope-description">{details.description}</span><code>{scope}</code></span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <InlineNotice title="No scopes listed" tone="warning">
                  <p>The client did not provide a readable scope list. Do not approve unless this request is expected.</p>
                </InlineNotice>
              )}
            </div>

            <InlineNotice title="Workspace boundary" tone="info">
              <p>Consent does not bypass membership checks. Relay still authorizes every resource against the active workspace.</p>
              <Link to={`/oauth/workspace${location.search}`}>Choose a different workspace</Link>
            </InlineNotice>

            <div className="oauth-panel__actions">
              <Button
                pending={action === "approve"}
                pendingLabel="Authorizing client"
                disabled={action !== null || selectedScopes.length === 0}
                onClick={() => void submit(true)}
              >
                Authorize client
              </Button>
              <Button
                variant="outline"
                pending={action === "deny"}
                pendingLabel="Denying request"
                disabled={action !== null}
                onClick={() => void submit(false)}
              >
                Deny
              </Button>
            </div>
            <p className="oauth-panel__escape">Not your request? <Link to="/dashboard">Return to dashboard</Link>.</p>
          </>
        ) : null}
        {!loading && request && !client && error ? (
          <InlineNotice
            title="Client verification unavailable"
            tone="error"
            action={<LinkButton to="/dashboard" variant="outline">Return to dashboard</LinkButton>}
          >
            <p>{error}</p>
          </InlineNotice>
        ) : null}
      </section>
    </OAuthLayout>
  );
}
