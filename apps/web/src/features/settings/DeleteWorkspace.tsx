import { type FormEvent, useState } from "react";
import { Button } from "../../components/ui/Button";
import { Disclosure } from "../../components/ui/Disclosure";
import { ApiError } from "../../lib/api/client";
import type {
  ManagedWorkspace,
  WorkspaceAdapter,
} from "../../lib/api/workspaces";

export function DeleteWorkspace(
  { workspace, adapter, onDeleted }: {
    workspace: ManagedWorkspace;
    adapter: WorkspaceAdapter;
    onDeleted(): Promise<void>;
  },
) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || confirmation !== workspace.slug) return;
    setBusy(true);
    setError("");
    try {
      await adapter.remove(workspace.id, confirmation);
      await onDeleted();
    } catch (error) {
      setError(
        error instanceof ApiError && error.status === 409
          ? error.message
          : "Couldn’t confirm deletion. Refresh your workspaces before trying again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Disclosure
      title="Delete workspace"
      className="workspace-delete"
      description="Permanently remove this workspace and its files"
    >
      <form onSubmit={(event) => void submit(event)}>
        <p>
          Everyone will lose access to{" "}
          <strong>{workspace.name}</strong>. Share links and agent connections
          will stop working. Its files will be removed by storage cleanup. This
          cannot be undone.
        </p>
        <label className="form-field">
          <span className="form-field__label">
            Type {workspace.slug} to confirm
          </span>
          <input
            className="input"
            value={confirmation}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        <Button
          type="submit"
          disabled={busy || confirmation !== workspace.slug}
          className="workspace-delete__button"
        >
          {busy ? "Deleting workspace…" : "Permanently delete workspace"}
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </Disclosure>
  );
}
