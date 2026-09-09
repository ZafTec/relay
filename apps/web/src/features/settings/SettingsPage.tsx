import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth, type WorkspaceState } from "../../auth/AuthProvider";
import { LinkButton } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/StatusBadge";
import "./settings.css";
import { NotificationSettings } from "./NotificationSettings";
import { LegalLinks } from "../../components/layout/LegalLinks";
import { WorkspaceManagement } from "./WorkspaceManagement";

const MCP_ENDPOINT = "/mcp";
const MCP_RESOURCE_METADATA = "/.well-known/oauth-protected-resource/mcp";

const MCP_SCOPE_GUIDANCE = [
  ["tools:read", "List tools and read tool contracts."],
  ["tools:execute", "Call an executable workspace tool."],
  ["runs:read", "List runs and read run detail."],
  ["runs:cancel", "Request cancellation for a run."],
  ["artifacts:read", "List artifacts and read artifact detail."],
  ["artifacts:write", "Create an artifact upload."],
  ["artifacts:share", "Create or revoke a share link."],
  ["usage:read", "Read tool usage and workspace storage usage."],
  ["notifications:read", "Read your email preferences and delivery status."],
  ["notifications:write", "Change your email notification preferences."],
] as const;

const sessionExpiryFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function sessionExpiry(expiresAt: Date | null): { dateTime: string; label: string } | null {
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.valueOf())) return null;
  return {
    dateTime: expiresAt.toISOString(),
    label: sessionExpiryFormatter.format(expiresAt),
  };
}

interface AuthorizationWorkspaceProps {
  state: WorkspaceState;
}

function AuthorizationWorkspace({ state }: AuthorizationWorkspaceProps) {
  if (state.status === "ready") {
    return (
      <div className="settings-mcp__binding">
        <span>New authorization target</span>
        <strong>{state.workspace.name}</strong>
        <code>@{state.workspace.slug}</code>
        <p>Relay records this workspace in the access token and rechecks membership.</p>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <div className="settings-mcp__binding">
        <span>New authorization target</span>
        <strong>No active workspace</strong>
        <p>Selecting an active workspace is required before MCP authorization can complete.</p>
      </div>
    );
  }

  if (state.status === "degraded") {
    return (
      <div className="settings-mcp__binding">
        <span>New authorization target</span>
        <strong>Workspace unavailable</strong>
        <p>Retry the workspace context before starting a new MCP authorization.</p>
      </div>
    );
  }

  return (
    <div className="settings-mcp__binding">
      <span>New authorization target</span>
      <strong>Resolving active workspace</strong>
      <p>Relay must verify the workspace before MCP authorization can complete.</p>
    </div>
  );
}

function McpConnectionGuide({ workspace }: { workspace: WorkspaceState }) {
  return (
    <section className="settings-mcp" aria-labelledby="settings-mcp-title">
      <header className="settings-mcp__header">
        <div>
          <h2 id="settings-mcp-title">MCP connection</h2>
          <p>
            Connect Gemini or another AI agent, then sign in and approve access to your workspace.
          </p>
        </div>
        <LinkButton to="/dashboard/oauth-clients" variant="outline">Manage OAuth clients</LinkButton>
      </header>

      <ol className="settings-mcp__steps">
        <li>
          <span className="settings-step__number" aria-hidden="true">01</span>
          <div>
            <h3>Configure the endpoint</h3>
            <p>Paste this complete URL into your agent’s MCP or connected-app settings.</p>
            <dl className="settings-endpoint">
              <div>
                <dt>Transport</dt>
                <dd>Streamable HTTP</dd>
              </div>
              <div>
                <dt>Request</dt>
                <dd><code>{new URL(MCP_ENDPOINT, window.location.origin).href}</code></dd>
              </div>
              <div>
                <dt>OAuth metadata</dt>
                <dd><code>{MCP_RESOURCE_METADATA}</code></dd>
              </div>
            </dl>
          </div>
        </li>
        <li>
          <span className="settings-step__number" aria-hidden="true">02</span>
          <div>
            <h3>Authorize with OAuth</h3>
            <p>
              Choose Connect in your agent. Compatible agents register automatically and open
              Relay for sign-in. If it asks for a client ID and secret, copy its redirect URI;
              a superadmin can create the client in Manage OAuth clients.
            </p>
          </div>
        </li>
        <li>
          <span className="settings-step__number" aria-hidden="true">03</span>
          <div>
            <h3>Sign in and choose a workspace</h3>
            <p>Approve the permissions you want the agent to use. Running tools also requires a usage allowance.</p>
            <AuthorizationWorkspace state={workspace} />
          </div>
        </li>
      </ol>

      <div className="settings-scopes">
        <div className="settings-scopes__intro">
          <div>
            <h3>Supported resource scopes</h3>
            <p>Each tool call checks the required scope at the protected MCP boundary.</p>
          </div>
          <p className="settings-scopes__note">
            Supported scopes are not evidence that this session or any client currently has them.
          </p>
        </div>
        <div className="settings-scopes__table-wrap">
          <table>
            <caption>Supported MCP authorization scopes</caption>
            <thead>
              <tr>
                <th scope="col">Scope</th>
                <th scope="col">Permitted operation</th>
              </tr>
            </thead>
            <tbody>
              {MCP_SCOPE_GUIDANCE.map(([scope, description]) => (
                <tr key={scope}>
                  <th scope="row"><code>{scope}</code></th>
                  <td>{description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function SettingsPage() {
  usePageMetadata("Workspace settings | Relay", "#141A16");
  const { session, workspace } = useAuth();

  if (session.status !== "authenticated") return null;

  const { user } = session.identity;
  const displayName = user.name.trim() || "Name not provided";
  const displayEmail = user.email.trim() || "Email not provided";
  const expiry = sessionExpiry(session.identity.session.expiresAt);
  const activeWorkspaceId = session.identity.session.activeWorkspaceId;

  return (
    <div className="settings-page product-surface">
      <header className="settings-page__header">
        <div>
          <h1>Workspace settings</h1>
          <p>Connect AI agents and review your workspace and sign-in details.</p>
        </div>
      </header>

      <div className="settings-page__body">
        <div className="settings-context">
          <WorkspaceManagement />

          <section className="settings-panel" aria-labelledby="settings-session-title">
            <header className="settings-panel__header">
              <div>
                <h2 id="settings-session-title">Current session</h2>
                <p>The authenticated identity visible to this browser.</p>
              </div>
              <StatusBadge>Authenticated</StatusBadge>
            </header>
            <div className="settings-panel__body">
              <dl className="settings-facts">
                <div>
                  <dt>Signed in as</dt>
                  <dd>{displayName}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>{displayEmail}</dd>
                </div>
                <div>
                  <dt>Session expires</dt>
                  <dd>
                    {expiry ? (
                      <>
                        <time dateTime={expiry.dateTime}>{expiry.label}</time>
                        <span className="settings-facts__caption">Your local time</span>
                      </>
                    ) : (
                      <span className="settings-facts__muted">Not provided by this session</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Active workspace</dt>
                  <dd>
                    {workspace.status === "ready" ? <>
                      <span>{workspace.workspace.name}</span>
                      <code>@{workspace.workspace.slug}</code>
                    </> : <span className="settings-facts__muted">{activeWorkspaceId
                      ? workspace.status === "degraded" ? "Workspace details unavailable" : "Loading workspace details"
                      : "No active workspace selected"}</span>}
                  </dd>
                </div>
              </dl>
            </div>
          </section>
        </div>

        {workspace.status === "ready" ? <NotificationSettings key={`${session.identity.session.id}:${workspace.workspace.id}`} email={displayEmail} /> : null}
        <McpConnectionGuide workspace={workspace} />
        <section className="settings-panel" aria-label="Legal and privacy"><header className="settings-panel__header"><h2>Legal and privacy</h2></header><div className="settings-panel__body"><LegalLinks /></div></section>
      </div>
    </div>
  );
}
