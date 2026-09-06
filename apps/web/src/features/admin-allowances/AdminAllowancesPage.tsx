import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { ApiError } from "../../lib/api/client";
import {
  httpAdminAllowanceAdapter, type AdminAllowanceAdapter, type AllowanceAuditEvent,
  type AllowanceGrant, type AllowanceKey, type AllowancePage, type AllowanceSummary,
  type AllowanceWorkspace, type GrantAllowanceInput, type RevokeAllowanceInput,
} from "../../lib/api/admin-allowances";
import "./admin-allowances.css";

const names: Record<AllowanceKey, string> = {
  "tools.execute": "Execution access", "images.generated": "Images", "ocr.requests": "OCR requests",
};
interface SavedRequest {
  workspaceId: string; operation: "grant" | "revoke";
  input: GrantAllowanceInput | RevokeAllowanceInput; key: string;
}
interface LoadedWorkspace {
  summary: AllowanceSummary; grants: AllowancePage<AllowanceGrant>; audit: AllowancePage<AllowanceAuditEvent>;
}
interface Failure { message: string; auth?: boolean; denied?: boolean }
function failure(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.status === 401) return { message: "Sign in again to confirm your identity before managing allowances.", auth: true };
    if (error.status === 403) return { message: "A current superadmin role is required to manage allowances.", denied: true };
    if (error.status === 404) return { message: "This workspace or grant is no longer available. Choose a workspace again." };
    if (error.code === "idempotency_conflict") return { message: "This request key was used for another change. Refresh the workspace before trying again." };
    if (error.status === 409) return { message: "This grant was already revoked. Refresh the workspace to see its current state." };
    if (error.status === 400) return { message: "Check the allowance amount, reason and dates. The end date must be in the future and after the start date." };
  }
  return { message: "Relay could not load allowances. Try again." };
}
function count(value: string | null): string {
  if (value === null) return "Unlimited";
  const [whole, fraction] = value.split(".");
  const tail = fraction?.replace(/0+$/, "");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${tail ? `.${tail}` : ""}`;
}
function date(value: string, utc = false): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", ...(utc ? { timeZone: "UTC" } : {}) }).format(new Date(value));
}
function status(grant: AllowanceGrant, asOf: string): string {
  if (grant.revokedAt !== null && grant.revokedAt <= asOf) return "Revoked";
  if (grant.expiresAt !== null && grant.expiresAt <= asOf) return "Expired";
  if (grant.effectiveAt > asOf) return "Scheduled";
  return "Active";
}
function restore(key: string): SavedRequest | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as SavedRequest;
    if (typeof v.workspaceId !== "string" || !v.workspaceId || typeof v.key !== "string" || !v.input ||
      (v.operation !== "grant" && v.operation !== "revoke") || typeof v.input.reason !== "string") return null;
    return v;
  } catch { return null; }
}

export function AdminAllowancesPage({ adapter = httpAdminAllowanceAdapter }: { adapter?: AdminAllowanceAdapter }) {
  const { session } = useAuth();
  const userId = session.status === "authenticated" ? session.identity.user.id : "anonymous";
  const storageKey = `relay:allowance-request:${userId}`;
  const [params, setParams] = useSearchParams();
  const [pending, setPending] = useState<SavedRequest | null>(() => restore(storageKey));
  const workspaceId = pending?.workspaceId ?? params.get("workspace") ?? "";
  const [search, setSearch] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [workspaces, setWorkspaces] = useState<AllowancePage<AllowanceWorkspace> | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<Failure | null>(null);
  const [loaded, setLoaded] = useState<LoadedWorkspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState<Failure | null>(null);
  const [revision, setRevision] = useState(0);
  const [key, setKey] = useState<AllowanceKey | "">("");
  const [limitMode, setLimitMode] = useState<"" | "finite" | "unlimited">("");
  const [amount, setAmount] = useState("");
  const [startMode, setStartMode] = useState("now");
  const [start, setStart] = useState("");
  const [endMode, setEndMode] = useState("none");
  const [end, setEnd] = useState("");
  const [reason, setReason] = useState("");
  const [confirmUnlimited, setConfirmUnlimited] = useState(false);
  const [revoke, setRevoke] = useState<AllowanceGrant | null>(null);
  const [sending, setSending] = useState(false);
  const [mutationError, setMutationError] = useState<Failure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [paging, setPaging] = useState(false);
  const sendingRef = useRef(false);
  const operatorRef = useRef(userId);
  operatorRef.current = userId;
  const current = useRef(workspaceId);
  current.current = workspaceId;
  const mounted = useRef(true);
  const editor = useRef<HTMLHeadingElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSearching(true); setSearchError(null); setWorkspaces(null);
    adapter.workspaces(searchQuery, null, controller.signal).then((result) => {
      if (!controller.signal.aborted) setWorkspaces(result);
    }).catch((error: unknown) => { if (!controller.signal.aborted) setSearchError(failure(error)); })
      .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    return () => controller.abort();
  }, [adapter, searchQuery, revision]);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null); setReadError(null); setRevoke(null); setReason(""); setMutationError(null);
    if (!workspaceId) { setLoading(false); return () => controller.abort(); }
    setLoading(true);
    Promise.all([adapter.summary(workspaceId, controller.signal), adapter.grants(workspaceId, null, controller.signal), adapter.audit(workspaceId, null, controller.signal)])
      .then(([summary, grants, audit]) => { if (!controller.signal.aborted) setLoaded({ summary, grants, audit }); })
      .catch((error: unknown) => { if (!controller.signal.aborted) setReadError(failure(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [adapter, workspaceId, revision]);

  const reauth = `/sign-in?returnTo=${encodeURIComponent(`/admin/allowances${workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : ""}`)}&reason=session-expired`;
  function notice(error: Failure) {
    return <InlineNotice title={error.auth ? "Reauthentication required" : error.denied ? "Access denied" : "Allowances unavailable"} tone="error">
      <p>{error.message}</p>
      {error.auth ? <Link to={reauth}>Reauthenticate</Link> : error.denied ? <Link to="/dashboard">Return to workspace</Link> : <Button variant="quiet" onClick={() => setRevision((v) => v + 1)}>Refresh allowances</Button>}
    </InlineNotice>;
  }
  async function more(section: "workspaces" | "grants" | "audit") {
    const expected = workspaceId;
    const expectedQuery = searchQuery;
    setPaging(true);
    try {
      if (section === "workspaces" && workspaces?.nextCursor) {
        const next = await adapter.workspaces(searchQuery, workspaces.nextCursor);
        if (mounted.current && current.current === expected && expectedQuery === searchQuery) setWorkspaces((previous) => previous ? { items: [...previous.items, ...next.items], nextCursor: next.nextCursor } : previous);
      } else if (section === "grants" && loaded?.grants.nextCursor) {
        const next = await adapter.grants(workspaceId, loaded.grants.nextCursor);
        if (mounted.current && current.current === expected) setLoaded((previous) => previous ? { ...previous, grants: { items: [...previous.grants.items, ...next.items], nextCursor: next.nextCursor } } : previous);
      } else if (section === "audit" && loaded?.audit.nextCursor) {
        const next = await adapter.audit(workspaceId, loaded.audit.nextCursor);
        if (mounted.current && current.current === expected) setLoaded((previous) => previous ? { ...previous, audit: { items: [...previous.audit.items, ...next.items], nextCursor: next.nextCursor } } : previous);
      }
    } catch (error) { if (mounted.current && current.current === expected) setReadError(failure(error)); }
    finally { if (mounted.current) setPaging(false); }
  }
  async function send(request: SavedRequest) {
    if (sendingRef.current || operatorRef.current !== userId) return;
    try { sessionStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setMutationError({ message: "Enable session storage in this browser so Relay can safely retry an interrupted change." }); return; }
    sendingRef.current = true;
    setPending(request); setSending(true); setMutationError(null); setSuccess(null);
    try {
      const result = await adapter.mutate(request.workspaceId, request.operation, request.input, request.key);
      sessionStorage.removeItem(storageKey);
      if (!mounted.current || operatorRef.current !== userId) return;
      setPending(null); setParams({ workspace: request.workspaceId }, { replace: true });
      setSuccess(`${request.operation === "grant" ? "Grant added" : "Grant revoked"}${result.replayed ? " (confirmed from the saved request)" : ""}. Recorded usage is preserved.`);
      setReason(""); setAmount(""); setRevoke(null); setConfirmUnlimited(false); setRevision((v) => v + 1);
    } catch (error) {
      if (!mounted.current || operatorRef.current !== userId) return;
      const definitive = error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403 && error.status !== 408 && error.status !== 429;
      if (definitive) { sessionStorage.removeItem(storageKey); setPending(null); }
      setMutationError(definitive || (error instanceof ApiError && [401, 403].includes(error.status)) ? failure(error)
        : { message: "The change may have been saved. Retry the saved request to confirm its outcome without creating another grant." });
    } finally { sendingRef.current = false; if (mounted.current && operatorRef.current === userId) setSending(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!loaded || pending || sending) return;
    setMutationError(null);
    if (!reason.trim()) { setMutationError({ message: "Enter a reason for this change." }); return; }
    if (revoke) {
      void send({ workspaceId, operation: "revoke", input: { grantId: revoke.id, reason: reason.trim() }, key: crypto.randomUUID() });
      return;
    }
    if (!key || (key !== "tools.execute" && (!limitMode || (limitMode === "finite" && !/^(0|[1-9][0-9]{0,28})$/.test(amount)) || (limitMode === "unlimited" && !confirmUnlimited)))) {
      setMutationError({ message: "Choose an allowance and enter an explicit whole-number limit, or confirm unlimited usage." }); return;
    }
    if ((startMode !== "now" && !Number.isFinite(Date.parse(start))) || (endMode !== "none" && !Number.isFinite(Date.parse(end)))) {
      setMutationError({ message: "Enter a valid start and end date." }); return;
    }
    const effectiveAt = startMode === "now" ? null : new Date(start).toISOString();
    const expiresAt = endMode === "none" ? null : new Date(end).toISOString();
    if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(effectiveAt ?? new Date().toISOString())) {
      setMutationError({ message: "The end date must be after the start date and in the future." }); return;
    }
    void send({ workspaceId, operation: "grant", key: crypto.randomUUID(), input: {
      key, mode: key === "tools.execute" ? "enabled" : limitMode as "finite" | "unlimited",
      amount: key !== "tools.execute" && limitMode === "finite" ? amount : null,
      effectiveAt, expiresAt, reason: reason.trim(),
    } });
  }

  return <div className="allowances-page">
    <header className="allowances-header"><div><h1>Allowances</h1><p>Control which workspaces can run tools and how much they can use.</p></div>
      <Button variant="outline" disabled={loading || sending || paging} onClick={() => setRevision((v) => v + 1)}>Refresh</Button></header>
    {pending ? <InlineNotice title={sending ? "Saving change" : "Saved request needs confirmation"} tone="warning">
      <p>{sending ? "Keep this page open while Relay records the change." : "An earlier request is saved in this browser. Confirm its outcome before making another change."}</p>
      <Button pending={sending} pendingLabel="Saving" onClick={() => void send(pending)}>Retry saved request</Button>
    </InlineNotice> : null}
    {success ? <InlineNotice title="Allowance updated" tone="success"><p>{success}</p></InlineNotice> : null}
    {mutationError ? notice(mutationError) : null}
    <section className="allowance-workspace-picker" aria-labelledby="allowance-workspace-heading">
      <h2 id="allowance-workspace-heading">Choose a workspace</h2>
      <form className="allowance-search" onSubmit={(event) => { event.preventDefault(); setSearchQuery(search.trim()); }}>
        <label className="form-field"><span className="form-field__label">Workspace name, slug or ID</span>
          <input className="input" value={search} maxLength={128} onChange={(event) => setSearch(event.target.value)} disabled={!!pending || paging} type="search" placeholder="Find a workspace" /></label>
        <Button type="submit" variant="outline" pending={searching} disabled={!!pending || paging}>Search</Button>
      </form>
      {searchError ? notice(searchError) : null}
      {searching ? <p role="status">Loading workspaces…</p> : workspaces?.items.length === 0 ? <p>No workspaces match this search.</p> : workspaces ? <>
        <div className="allowance-workspace-results" aria-label="Workspace results">
          {workspaces.items.map((workspace) => <button key={workspace.id} type="button" className="allowance-workspace-option" aria-pressed={workspaceId === workspace.id} disabled={!!pending || sending || paging}
            onClick={() => { setParams({ workspace: workspace.id }); setSuccess(null); }}><strong>{workspace.name}</strong><span>{workspace.slug}</span><code>{workspace.id}</code></button>)}
        </div>
        {workspaces.nextCursor ? <Button variant="quiet" pending={paging} disabled={!!pending} onClick={() => void more("workspaces")}>More workspaces</Button> : null}
      </> : null}
    </section>
    {!workspaceId ? <div className="allowance-empty"><h2>Select a workspace to begin</h2><p>New workspaces have no execution access or usage allowance until a superadmin adds grants.</p></div> : null}
    {loading ? <p role="status">Loading workspace allowances…</p> : null}
    {readError ? notice(readError) : null}
    {loaded && !readError ? <>
      <section className="allowance-overview" aria-labelledby="allowance-overview-heading">
        <div className="allowance-section-heading"><div><h2 id="allowance-overview-heading">{loaded.summary.workspace.name}</h2><p className="allowance-id">{loaded.summary.workspace.id}</p></div>
          <span className={`allowance-status${loaded.summary.executionAllowed ? " is-active" : ""}`}>{loaded.summary.executionAllowed ? "Execution enabled" : "Execution blocked"}</span></div>
        <p>{loaded.summary.executionAllowed ? "New runs also need an available allowance for their usage type." : "Grant execution access and a usage allowance to enable new runs."}</p>
        <div className="allowance-table-scroll" tabIndex={0} role="region" aria-label="Monthly usage"><table className="allowance-table"><caption>Monthly usage · resets {date(loaded.summary.periodEndsAt, true)} UTC</caption>
          <thead><tr><th scope="col">Usage</th><th scope="col">Allowance</th><th scope="col">Used</th><th scope="col">Reserved</th><th scope="col">Available</th></tr></thead>
          <tbody>{loaded.summary.limits.map((limit) => <tr key={limit.key}><th scope="row">{names[limit.key]}</th><td>{limit.state === "none" ? "Not granted" : limit.state === "invalid" ? "Needs review" : count(limit.amount)}</td><td>{count(limit.consumed)}</td><td>{count(limit.reserved)}</td><td>{limit.state === "none" || limit.state === "invalid" ? "—" : count(limit.remaining)}</td></tr>)}</tbody>
        </table></div>
        <p className="allowance-note">Usage is shared across workspace members. Image tools share the image allowance; OCR uses one request per run.</p>
      </section>
      <div className="allowance-management">
        <section className="allowance-editor" aria-labelledby="allowance-editor-heading">
          <h2 id="allowance-editor-heading" tabIndex={-1} ref={editor}>{revoke ? `Revoke ${names[revoke.key].toLowerCase()}` : "Add a grant"}</h2>
          <p>{revoke ? "Revocation takes effect immediately for new runs. Accepted runs can finish using their existing reservations." : "Active limits add together. To lower a limit, revoke the old grant before adding its replacement. Recorded usage carries over."}</p>
          <form onSubmit={submit}>
            <fieldset disabled={!!pending || sending || paging}><legend className="sr-only">{revoke ? "Revoke grant" : "Grant allowance"}</legend>
              {revoke ? <p className="allowance-revoke-target"><strong>{revoke.key === "tools.execute" ? "Execution enabled" : `${count(revoke.amount)} per month`}</strong><code>{revoke.id}</code></p> : <>
                <label className="form-field"><span className="form-field__label">Allowance</span><select className="input" required value={key} onChange={(event) => { setKey(event.target.value as AllowanceKey); setConfirmUnlimited(false); }}><option value="">Choose an allowance</option><option value="tools.execute">Execution access</option><option value="images.generated">Images per month</option><option value="ocr.requests">OCR requests per month</option></select></label>
                {key && key !== "tools.execute" ? <>
                  <label className="form-field"><span className="form-field__label">Limit</span><select className="input" required value={limitMode} onChange={(event) => { setLimitMode(event.target.value as typeof limitMode); setConfirmUnlimited(false); }}><option value="">Choose a limit</option><option value="finite">Set an amount</option><option value="unlimited">Unlimited</option></select></label>
                  {limitMode === "finite" ? <label className="form-field"><span className="form-field__label" id="allowance-amount-label">{key === "images.generated" ? "Number of images" : "Number of OCR requests"}</span><input className="input" aria-labelledby="allowance-amount-label" aria-describedby="allowance-amount-hint" required inputMode="numeric" pattern="(0|[1-9][0-9]*)" maxLength={29} value={amount} onChange={(event) => setAmount(event.target.value)} /><span className="form-field__hint" id="allowance-amount-hint">Whole numbers only. Zero grants no available usage.</span></label> : null}
                  {limitMode === "unlimited" ? <label className="allowance-confirm"><input type="checkbox" required checked={confirmUnlimited} onChange={(event) => setConfirmUnlimited(event.target.checked)} />I authorize unlimited {names[key].toLowerCase()} for this workspace.</label> : null}
                </> : null}
                <div className="allowance-dates"><label className="form-field"><span className="form-field__label">Starts</span><select className="input" value={startMode} onChange={(event) => setStartMode(event.target.value)}><option value="now">Immediately</option><option value="scheduled">On a date</option></select></label>
                  <label className="form-field"><span className="form-field__label">Ends</span><select className="input" value={endMode} onChange={(event) => setEndMode(event.target.value)}><option value="none">No expiry</option><option value="scheduled">On a date</option></select></label></div>
                {startMode === "scheduled" ? <label className="form-field"><span className="form-field__label">Start date (local time)</span><input className="input" type="datetime-local" required value={start} onChange={(event) => setStart(event.target.value)} /></label> : null}
                {endMode === "scheduled" ? <label className="form-field"><span className="form-field__label">End date (local time)</span><input className="input" type="datetime-local" required value={end} onChange={(event) => setEnd(event.target.value)} /></label> : null}
              </>}
              <label className="form-field"><span className="form-field__label" id="allowance-reason-label">Reason for this change</span><input className="input" aria-labelledby="allowance-reason-label" aria-describedby="allowance-reason-hint" required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example, approved pilot allowance" /><span className="form-field__hint" id="allowance-reason-hint">Recorded with your account in the audit history.</span></label>
              <div className="allowance-actions"><Button type="submit" pending={sending} pendingLabel="Saving">{revoke ? "Revoke grant" : "Add grant"}</Button>{revoke ? <Button variant="quiet" onClick={() => { setRevoke(null); setReason(""); }}>Cancel revocation</Button> : null}</div>
            </fieldset>
          </form>
        </section>
        <section className="allowance-grants" aria-labelledby="allowance-grants-heading"><h2 id="allowance-grants-heading">Grant history</h2><p>Active, scheduled, expired and revoked grants.</p>
          {loaded.grants.items.length === 0 ? <p className="allowance-empty-inline">No grants yet. Add execution access and a usage limit to get started.</p> : <ul className="allowance-grant-list">
            {loaded.grants.items.map((item) => { const state = status(item, loaded.summary.asOf); return <li key={item.id}>
              <div className="allowance-section-heading"><h3>{names[item.key]}</h3><span className={`allowance-status${state === "Active" ? " is-active" : ""}`}>{state}</span></div>
              <strong className="allowance-grant-amount">{item.key === "tools.execute" ? "Tool execution enabled" : `${count(item.amount)} / month`}</strong>
              <p>{date(item.effectiveAt)} · {item.expiresAt ? `until ${date(item.expiresAt)}` : "No expiry"}</p>
              {item.reason ? <p>{item.reason}</p> : <p>Source: {item.sourceKind}</p>}
              <details><summary>Grant details</summary><dl><dt>Grant ID</dt><dd>{item.id}</dd><dt>Granted by</dt><dd>{item.operatorUserId ?? item.sourceKind}</dd>{item.revokedAt ? <><dt>Revoked</dt><dd>{date(item.revokedAt)}</dd></> : null}</dl></details>
              {item.revokedAt === null && state !== "Expired" ? <Button variant="quiet" disabled={!!pending || sending || paging} onClick={() => { setRevoke(item); setReason(""); setSuccess(null); setMutationError(null); requestAnimationFrame(() => editor.current?.focus()); }}>Revoke {names[item.key].toLowerCase()}</Button> : null}
            </li>; })}
          </ul>}
          {loaded.grants.nextCursor ? <Button variant="quiet" pending={paging} disabled={!!pending} onClick={() => void more("grants")}>Older grants</Button> : null}
        </section>
      </div>
      <section className="allowance-audit" aria-labelledby="allowance-audit-heading"><h2 id="allowance-audit-heading">Audit history</h2><p>Every successful grant and revocation, with the operator and reason.</p>
        {loaded.audit.items.length === 0 ? <p className="allowance-empty-inline">No allowance changes recorded.</p> : <ol>{loaded.audit.items.map((item) => <li key={item.id}><div><strong>{item.action === "allowance.grant" ? "Grant added" : "Grant revoked"}</strong><time dateTime={item.at}>{date(item.at)}</time></div><p>{item.reason}</p><details><summary>Operator and grant</summary><dl><dt>Operator</dt><dd>{item.operatorUserId}</dd><dt>Grant ID</dt><dd>{item.grantId}</dd></dl></details></li>)}</ol>}
        {loaded.audit.nextCursor ? <Button variant="quiet" pending={paging} disabled={!!pending} onClick={() => void more("audit")}>Older changes</Button> : null}
      </section>
    </> : null}
  </div>;
}
