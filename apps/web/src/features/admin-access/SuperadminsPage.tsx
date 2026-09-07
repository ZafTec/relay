import { type FormEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { usePageMetadata } from "../../app/usePageMetadata";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { ApiError } from "../../lib/api/client";
import { superadminAccess, type SuperadminAccess, type SuperadminInvitation } from "../../lib/api/superadmin-access";
import { useAdminChangelog } from "../admin-changelog/AdminChangelogContext";
import { CopyValue } from "../oauth-clients/OAuthClientsPage";
import "../oauth-clients/oauth-clients.css";

export function SuperadminsPage() {
  const { session } = useAuth();
  usePageMetadata("Superadmins · Relay", "#141A16");
  return session.status === "authenticated" ? <AccessManager key={session.identity.session.id} sessionId={session.identity.session.id} /> : null;
}

function AccessManager({ sessionId }: { sessionId: string }) {
  const { reportAccessFailure } = useAdminChangelog();
  const [data, setData] = useState<SuperadminAccess | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<SuperadminInvitation | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const alive = useRef(true);
  const lock = useRef(false);
  const generation = useRef(0);
  const request = useRef<{ email: string; key: string } | null>(null);
  function failure(error: unknown) {
    if (error instanceof ApiError && [401,403].includes(error.status)) reportAccessFailure({ kind: "reauthentication-required" }, sessionId);
    else setError(error instanceof ApiError && error.status === 409 ? "This person is already a superadmin, or the invitation has changed. Refresh the list." : "Relay could not confirm the change. Refresh the list or retry the same invitation.");
  }
  async function refresh(signal?: AbortSignal) {
    const id = ++generation.current;
    try {
      const value = await superadminAccess.list(signal);
      if (alive.current && !signal?.aborted && id === generation.current) { setData(value); setError(null); }
    } catch (error) { if (alive.current && !signal?.aborted && id === generation.current) failure(error); }
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(); void refresh(controller.signal);
    return () => { alive.current = false; generation.current++; controller.abort(); };
  }, []);
  async function change(action: () => Promise<SuperadminInvitation | void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); generation.current++;
    try {
      const created = await action();
      if (!alive.current) return;
      if (created) { setInvite(created); setEmail(""); request.current = null; }
      setConfirm(null); await refresh();
    } catch (error) { if (alive.current) failure(error); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (request.current?.email !== value) request.current = { email: value, key: crypto.randomUUID() };
    const key = request.current.key;
    void change(() => superadminAccess.invite(value,key));
  }
  function link(value: SuperadminInvitation) { return new URL(`/superadmin-invitations/${value.id}`,window.location.origin).href; }
  return <div className="oauth-clients-page">
    <header className="oauth-clients-header"><div><h1>Superadmins</h1><p>Invite trusted people to manage platform access, usage allowances, and OAuth clients.</p></div></header>
    {error ? <InlineNotice title="Action needs attention" tone="error"><p>{error}</p><Button variant="quiet" disabled={busy} onClick={() => void refresh()}>Refresh access</Button></InlineNotice> : null}
    <form className="oauth-client-form" onSubmit={submit}>
      <h2>Invite a superadmin</h2><label>Email address<input type="email" required maxLength={254} autoComplete="email" value={email} disabled={busy} onChange={(event) => setEmail(event.target.value)} placeholder="colleague@example.com" /></label>
      <p>The recipient must sign in with this verified email and accept within 7 days. Superadmins have access to platform-wide controls.</p>
      <Button type="submit" pending={busy} pendingLabel="Creating invitation" disabled={!data}>Create invitation link</Button>
    </form>
    {invite && !invite.acceptedAt && !invite.revokedAt ? <section className="oauth-credentials" aria-label="New superadmin invitation"><h2>Share this invitation</h2><p>Send this link to {invite.email}. Creating the link does not send an email.</p><CopyValue label="Invitation URL" value={link(invite)} /><Button variant="quiet" onClick={() => setInvite(null)}>Done</Button></section> : null}
    <section className="oauth-client-list" aria-labelledby="superadmins-heading"><h2 id="superadmins-heading">Current superadmins</h2>
      {!data && !error ? <Skeleton label="Loading platform access" lines={3} /> : null}
      {data?.admins.map((admin) => <article className="oauth-client-row" key={admin.userId}><div><h3>{admin.name}</h3><p>{admin.email}</p></div><span className="mono-label">Superadmin</span></article>)}
    </section>
    <section className="oauth-client-list" aria-labelledby="invitations-heading"><h2 id="invitations-heading">Invitations</h2>
      {data?.invitations.length === 0 ? <p>No invitations yet.</p> : null}
      {data?.invitations.map((item) => {
        const status = item.acceptedAt ? "Accepted" : item.revokedAt ? "Revoked" : Date.parse(item.expiresAt) <= Date.now() ? "Expired" : "Pending";
        return <article className="oauth-client-row" key={item.id}><div><h3>{item.email}</h3><p>{status} · Expires {new Date(item.expiresAt).toLocaleDateString()}</p>{status === "Pending" ? <CopyValue label="Invitation URL" value={link(item)} /> : null}</div>
          {status === "Pending" ? <Button variant="quiet" disabled={busy} onClick={() => setConfirm(item.id)}>Revoke invitation</Button> : null}
          {confirm === item.id ? <div className="oauth-client-confirm" role="alert"><p>This link will stop granting access. Revoke the invitation?</p><Button pending={busy} onClick={() => void change(() => superadminAccess.revoke(item.id))}>Confirm revoke</Button><Button variant="quiet" disabled={busy} onClick={() => setConfirm(null)}>Cancel</Button></div> : null}
        </article>;
      })}
    </section>
  </div>;
}
