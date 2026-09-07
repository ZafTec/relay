import { type FormEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { usePageMetadata } from "../../app/usePageMetadata";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { type ManagedOAuthClient, type OAuthClientCredentials, oauthClientError, oauthClients } from "../../lib/api/oauth-clients";
import { ApiError } from "../../lib/api/client";
import { useAdminChangelog } from "../admin-changelog/AdminChangelogContext";
import "./oauth-clients.css";

const permissions = [
  ["tools:read", "Browse tools"],
  ["tools:execute", "Run tools"],
  ["runs:read", "Read runs"],
  ["runs:cancel", "Cancel runs"],
  ["artifacts:read", "Read files"],
  ["artifacts:write", "Upload files"],
  ["artifacts:share", "Share files"],
  ["usage:read", "Read usage"],
  ["notifications:read", "Read email preferences"],
  ["notifications:write", "Change email preferences"],
] as const;

export function CopyValue({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [message, setMessage] = useState("");
  async function copy() {
    try { await navigator.clipboard.writeText(value); setMessage(`${label} copied`); }
    catch { setShown(true); setMessage("Copy unavailable. Select and copy the value below."); }
  }
  return <div className="oauth-copy">
    <label>
      <span>{label}</span>
      <input aria-label={label} value={value} type={shown ? "text" : "password"} readOnly autoComplete="off" spellCheck={false} onFocus={(event) => event.target.select()} />
    </label>
    <div className="oauth-copy__actions">
      {secret ? <Button variant="quiet" onClick={() => setShown(!shown)}>{shown ? "Hide secret" : "Reveal secret"}</Button> : null}
      <Button variant="outline" onClick={() => void copy()}>Copy {label.toLowerCase()}</Button>
    </div>
    <span role="status" className="oauth-copy__status">{message}</span>
  </div>;
}

export function OAuthClientsPage() {
  const { session } = useAuth();
  usePageMetadata("OAuth clients · Relay", "#141A16");
  return session.status === "authenticated" ? <ClientManager key={session.identity.session.id} /> : null;
}

function ClientManager() {
  const { session } = useAuth();
  const { reportAccessFailure } = useAdminChangelog();
  const sessionId = session.status === "authenticated" ? session.identity.session.id : undefined;
  const [clients, setClients] = useState<ManagedOAuthClient[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const generation = useRef(0);
  const [mustRefresh, setMustRefresh] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [redirects, setRedirects] = useState("");
  const [scopes, setScopes] = useState(["tools:read", "runs:read", "artifacts:read"]);
  const [authMethod, setAuthMethod] = useState<"client_secret_post" | "client_secret_basic" | "none">("client_secret_post");
  const [credentials, setCredentials] = useState<OAuthClientCredentials | null>(null);
  const [confirm, setConfirm] = useState<{ client: ManagedOAuthClient; action: "rotate" | "delete" } | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const endpoint = new URL("/mcp", window.location.origin).href;

  function showFailure(failure: unknown) {
    if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
      setCredentials(null);
      reportAccessFailure({ kind: "reauthentication-required" }, sessionId);
    } else setError(oauthClientError(failure));
  }

  async function refresh(signal?: AbortSignal) {
    const expected = ++generation.current;
    try {
      const result = await oauthClients.list(signal);
      if (alive.current && !signal?.aborted && expected === generation.current) { setClients(result); setError(null); setMustRefresh(false); }
    } catch (failure) {
      if (alive.current && !signal?.aborted && expected === generation.current) showFailure(failure);
    }
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { alive.current = false; controller.abort(); };
  }, []);
  useEffect(() => { if (credentials) heading.current?.focus(); }, [credentials]);

  async function change(action: () => Promise<OAuthClientCredentials | void>) {
    if (busyRef.current || mustRefresh) return;
    busyRef.current = true; setBusy(true); setError(null); generation.current++;
    try {
      const result = await action();
      if (!alive.current) return;
      setConfirm(null); setEditing(false);
      if (result) setCredentials(result);
      await refresh();
    } catch (failure) {
      if (alive.current) { if (!(failure instanceof ApiError) || failure.status >= 500) setMustRefresh(true); showFailure(failure); }
    } finally { busyRef.current = false; if (alive.current) setBusy(false); }
  }
  function create(event: FormEvent) {
    event.preventDefault();
    const urls = redirects.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    try {
      if (!name.trim() || urls.length === 0 || urls.length > 10) throw new Error();
      for (const value of urls) {
        const url = new URL(value);
        const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
        if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) || url.username || url.password || url.hash) throw new Error();
      }
    } catch { setError("Enter a client name and up to 10 complete redirect URLs, one per line. Use HTTPS, or HTTP on localhost for a local agent."); return; }
    void change(() => oauthClients.create({ name: name.trim(), redirectUris: [...new Set(urls)], scopes, authMethod }));
  }

  return <div className="oauth-clients-page">
    <header className="oauth-clients-header">
      <div><h1>OAuth clients</h1><p>Connect Gemini or another AI agent to your Relay workspace.</p></div>
      {!editing && !credentials ? <Button disabled={busy || mustRefresh || clients === null} onClick={() => { setEditing(true); setConfirm(null); }}>Create client</Button> : null}
    </header>
    <section className="oauth-connection" aria-label="MCP connection address">
      <CopyValue label="MCP URL" value={endpoint} />
      <p>Add this URL in your agent’s connected-app settings. Create a client below if it asks for a client ID and secret. Then sign in to Relay, choose your workspace, and approve access.</p>
    </section>
    {error ? <InlineNotice title="Action needs attention" tone="error"><p>{error}</p><Button variant="quiet" disabled={busy} onClick={() => void refresh()}>Refresh clients</Button></InlineNotice> : null}
    {credentials ? <section className="oauth-credentials" aria-labelledby="credentials-heading">
      <h2 id="credentials-heading" tabIndex={-1} ref={heading}>{credentials.client_secret ? "Save your client secret" : "Client created"}</h2>
      <p>{credentials.client_secret ? "Paste these values into your agent now. Relay stores a hash and cannot show this secret again." : "This public client uses PKCE. Enter its client ID in your agent; no client secret is needed."}</p>
      <CopyValue label="Client ID" value={credentials.client_id} />
      {credentials.client_secret ? <CopyValue label="Client secret" value={credentials.client_secret} secret /> : null}
      <Button onClick={() => setCredentials(null)}>I’ve saved the credentials</Button>
    </section> : null}
    {editing && !credentials ? <form className="oauth-client-form" onSubmit={create}>
      <h2>Create an OAuth client</h2>
      <label>Client name<input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Gemini" /></label>
      <label>Redirect URLs<textarea required rows={3} value={redirects} onChange={(event) => setRedirects(event.target.value)} aria-describedby="redirect-help" placeholder="https://agent.example.com/oauth/callback" /></label>
      <p id="redirect-help">Copy the redirect URI from your agent’s setup screen. Enter one exact URL per line.</p>
      <fieldset><legend>Allowed permissions</legend><p>The agent still needs your consent. Running tools also requires a workspace usage allowance.</p><div className="oauth-permissions">{permissions.map(([scope, label]) => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={(event) => setScopes((current) => event.target.checked ? [...current, scope] : current.filter((value) => value !== scope))} />{label}</label>)}</div></fieldset>
      <details><summary>Client authentication</summary><label>Token authentication<select value={authMethod} onChange={(event) => setAuthMethod(event.target.value as typeof authMethod)}><option value="client_secret_post">Client secret in request body</option><option value="client_secret_basic">Client secret with HTTP Basic</option><option value="none">Public client — PKCE, no secret</option></select></label><p>Use the method your agent supports. All clients must use PKCE with S256.</p></details>
      <div className="oauth-form-actions"><Button type="submit" disabled={mustRefresh} pending={busy} pendingLabel="Creating client">Create client</Button><Button variant="quiet" disabled={busy} onClick={() => setEditing(false)}>Cancel</Button></div>
    </form> : null}
    <section className="oauth-client-list" aria-labelledby="registered-clients-heading">
      <h2 id="registered-clients-heading">Your registered clients</h2>
      {clients === null && !error ? <Skeleton label="Loading OAuth clients" lines={3} /> : null}
      {clients?.length === 0 ? <div className="oauth-clients-empty"><h3>Connect your first agent</h3><p>Create a client using the redirect URI from Gemini or your preferred agent. You’ll receive credentials to finish its setup.</p></div> : null}
      {clients?.map((client) => <article className="oauth-client-row" key={client.client_id}>
        <div><h3>{client.client_name || "Unnamed client"}</h3><code>{client.client_id}</code><ul>{client.redirect_uris.map((url) => <li key={url}>{url}</li>)}</ul><p>{client.token_endpoint_auth_method === "none" ? "Public client · PKCE" : "Confidential client · PKCE"}</p></div>
        <div className="oauth-client-actions">
          <Button variant="quiet" disabled={busy || mustRefresh || !!credentials || client.token_endpoint_auth_method === "none"} onClick={() => setConfirm({ client, action: "rotate" })}>Rotate secret</Button>
          <Button variant="quiet" disabled={busy || mustRefresh || clients === null || !!credentials} onClick={() => setConfirm({ client, action: "delete" })}>Delete client</Button>
        </div>
        {confirm?.client.client_id === client.client_id ? <div className="oauth-client-confirm" role="alert">
          <p>{confirm.action === "delete" ? "Delete this client and revoke its authorizations? The agent will need a new client to reconnect." : "Replace this client’s secret? Update the agent with the new secret to keep it connected."}</p>
          <Button disabled={mustRefresh} pending={busy} onClick={() => void change(() => confirm.action === "delete" ? oauthClients.remove(client.client_id) : oauthClients.rotate(client))}>{confirm.action === "delete" ? "Delete client" : "Replace secret"}</Button><Button variant="quiet" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button>
        </div> : null}
      </article>)}
    </section>
  </div>;
}
