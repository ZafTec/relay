import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { notificationsApi, type NotificationState } from "../../lib/api/notifications";

export function NotificationSettings({ email }: { email: string }) {
  const [state, setState] = useState<NotificationState | null>(null);
  const [draft, setDraft] = useState({ completed: false, failed: false });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [mustRefresh, setMustRefresh] = useState(false);
  const active = useRef(true);
  const saving = useRef(false);
  const generation = useRef(0);
  async function refresh(signal?: AbortSignal) {
    const version = ++generation.current;
    try {
      const result = await notificationsApi.get(signal);
      if (active.current && !signal?.aborted && version === generation.current) {
        setState(result); setDraft({ completed: result.completed, failed: result.failed }); setError(""); setMustRefresh(false);
      }
    } catch {
      if (active.current && !signal?.aborted && version === generation.current) setError("Email settings could not be loaded. Try again.");
    }
  }
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => { active.current = false; controller.abort(); };
  }, []);
  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving.current || mustRefresh) return;
    saving.current = true; setBusy(true); setError(""); setMessage(""); generation.current++;
    try {
      const result = await notificationsApi.update(draft);
      if (active.current) {
        setState(result); setDraft({ completed: result.completed, failed: result.failed });
        setMessage(result.completed || result.failed ? "Email preferences saved." : "Email notifications are off.");
      }
    } catch {
      if (active.current) { setMustRefresh(true); setError("Relay could not confirm the change. Refresh settings to see whether it was saved."); }
    } finally { saving.current = false; if (active.current) setBusy(false); }
  }
  const dirty = state !== null && (state.completed !== draft.completed || state.failed !== draft.failed);
  return <section className="settings-notifications settings-panel" aria-labelledby="notification-title">
    <header className="settings-panel__header">
      <div><h2 id="notification-title">Email notifications</h2><p>Know when your work is ready, without keeping Relay open.</p></div>
      {state ? <StatusBadge tone={state.completed || state.failed ? "ready" : "muted"}>{state.completed || state.failed ? "On" : "Off"}</StatusBadge> : null}
    </header>
    <div className="settings-panel__body">
      {error ? <InlineNotice title="Settings need attention" tone="error" action={<Button variant="outline" disabled={busy} onClick={() => void refresh()}>Refresh settings</Button>}><p>{error}</p></InlineNotice> : null}
      {!state && !error ? <Skeleton label="Loading email preferences" lines={3} /> : null}
      {state ? <>
        <p className="notification-recipient">Send updates to <strong>{email}</strong> for runs you create in this workspace.</p>
        {!state.configured ? <InlineNotice title="Email is not configured" tone="info"><p>Your administrator needs to connect an email relay before notifications can be enabled.</p></InlineNotice> : null}
        <form onSubmit={(event) => void save(event)}>
          <fieldset className="notification-options" disabled={busy || mustRefresh}>
            <legend className="sr-only">Choose your email updates</legend>
            <label><input type="checkbox" checked={draft.completed} disabled={!state.configured && !draft.completed} onChange={(event) => { setDraft((value) => ({ ...value, completed: event.target.checked })); setMessage(""); }} /><span><strong>Run completed</strong><span>A link to your results when a run finishes.</span></span></label>
            <label><input type="checkbox" checked={draft.failed} disabled={!state.configured && !draft.failed} onChange={(event) => { setDraft((value) => ({ ...value, failed: event.target.checked })); setMessage(""); }} /><span><strong>Run failed</strong><span>A link to the run so you can review what happened.</span></span></label>
          </fieldset>
          <p className="notification-help">Emails contain a link that requires sign-in. Prompts and files are never attached. Changes apply to future runs; an email already being sent may still arrive.</p>
          <div className="notification-actions"><Button type="submit" disabled={!dirty || mustRefresh} pending={busy} pendingLabel="Saving preferences">Save preferences</Button><span role="status">{message}</span></div>
        </form>
        <details className="notification-history"><summary>Recent email activity{state.deliveries.length ? ` (${state.deliveries.length})` : ""}</summary>
          <p>Temporary delivery failures retry after 1 minute, 5 minutes, 15 minutes, then 1 hour. Delivery stops after 5 attempts or a permanent rejection.</p>
          {state.deliveries.length === 0 ? <p>No email activity yet. Notifications start after you opt in.</p> : <ul>{state.deliveries.map((delivery) => <li key={delivery.id}>
            <Link to={`/dashboard/runs/${delivery.runId}`}>{delivery.event === "succeeded" ? "Run completed" : "Run failed"}</Link>
            <span>{delivery.status === "failed" ? "Could not deliver" : delivery.status === "retrying" ? "Will retry" : delivery.status === "sent" ? "Sent" : delivery.status === "cancelled" ? "Cancelled" : "Queued"}{delivery.attempts > 0 ? ` · ${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}` : ""}</span>
            {delivery.nextAttemptAt ? <time dateTime={delivery.nextAttemptAt}>Next attempt: {new Date(delivery.nextAttemptAt).toLocaleString()}</time> : null}
          </li>)}</ul>}
          <Button variant="quiet" disabled={busy} onClick={() => void refresh()}>Refresh activity</Button>
        </details>
      </> : null}
    </div>
  </section>;
}
