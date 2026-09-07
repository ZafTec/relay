import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { signInPathFor } from "../../auth/return-url";
import { usePageMetadata } from "../../app/usePageMetadata";
import { RelayBrand } from "../../components/brand/RelayBrand";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { ApiError } from "../../lib/api/client";
import { superadminAccess } from "../../lib/api/superadmin-access";

export function AcceptSuperadminInvitationPage() {
  usePageMetadata("Superadmin invitation · Relay", "#141A16");
  const { session } = useAuth();
  const { id = "" } = useParams();
  return session.status === "authenticated" ? <Invitation key={`${session.identity.session.id}:${id}`} id={id} /> : null;
}
function Invitation({ id }: { id: string }) {
  const { adapter, session, expireSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [invitation, setInvitation] = useState<{ email: string; accepted: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const lock = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); alive.current = true;
    void superadminAccess.invitation(id,false,controller.signal).then((value) => { if (!controller.signal.aborted) setInvitation(value); }).catch(() => { if (!controller.signal.aborted) setError("This invitation is unavailable for your account. Sign in with the invited email, or ask a superadmin for a new link."); });
    return () => { alive.current = false; controller.abort(); };
  }, [id]);
  async function accept() {
    if (lock.current) return; lock.current = true; setBusy(true); setError(null);
    try { const value = await superadminAccess.invitation(id,true); if (alive.current) setInvitation(value); }
    catch (error) { if (alive.current) setError(error instanceof ApiError && [401,403].includes(error.status) ? "Sign in again with the invited email before accepting." : "Relay could not accept this invitation. It may have expired or been revoked."); }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  async function restart() {
    if (lock.current) return; lock.current = true; setBusy(true);
    try { await adapter.signOut(); if (alive.current) { expireSession(session.status === "authenticated" ? session.identity.session.id : undefined); navigate(signInPathFor(location.pathname,"session-expired"),{replace:true}); } }
    catch { if (alive.current) { setError("Could not restart sign-in. Try again."); setBusy(false); } }
    finally { lock.current = false; }
  }
  return <main className="admin-gate product-surface"><RelayBrand surface="product" /><div className="admin-gate__panel">
    <p className="mono-label">Platform access</p><h1>{invitation?.accepted ? "Invitation accepted" : "Become a superadmin"}</h1>
    {!invitation && !error ? <Skeleton label="Checking invitation" lines={3} /> : null}
    {error ? <InlineNotice title="Invitation needs attention" tone="error"><p>{error}</p><Button variant="quiet" pending={busy} onClick={() => void restart()}>Sign in again</Button></InlineNotice> : null}
    {invitation?.accepted ? <><p>This invitation has been accepted. Open the admin dashboard to check your current access.</p><Link to="/admin">Open admin dashboard</Link></> : invitation ? <><p>You are accepting as <strong>{invitation.email}</strong>. This grants platform-wide administrative access, including allowances and OAuth clients.</p><Button pending={busy} onClick={() => void accept()}>Accept superadmin invitation</Button><Link to="/dashboard">Return to workspace</Link></> : null}
  </div></main>;
}
