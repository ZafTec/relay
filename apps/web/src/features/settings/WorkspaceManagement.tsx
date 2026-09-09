import { type FormEvent, useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { AuthAdapterError } from "../../auth/types";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { ImagePicker } from "../../components/ui/ImagePicker";
import { DeleteWorkspace } from "./DeleteWorkspace";
import { ApiError } from "../../lib/api/client";
import {
  httpWorkspaceAdapter,
  type ManagedWorkspace,
  type WorkspaceAdapter,
  type WorkspaceList,
  type WorkspaceUpdate,
} from "../../lib/api/workspaces";
import "./workspaces.css";

function failure(error: unknown): string {
  if (
    (error instanceof ApiError || error instanceof AuthAdapterError) &&
    error.status === 401
  ) return "Sign in again to manage your workspaces.";
  if (error instanceof ApiError && error.status === 403) {
    return "Only a workspace owner can change its details.";
  }
  if (error instanceof ApiError && error.status === 409) {
    return error.code === "idempotency_conflict"
      ? "This creation request already completed with different details. Refresh your workspaces before starting another."
      : error.message;
  }
  return "Relay could not confirm this change. Retry with the same details, or refresh your workspaces.";
}

export function WorkspaceManagement(
  { adapter = httpWorkspaceAdapter }: { adapter?: WorkspaceAdapter },
) {
  const auth = useAuth();
  const sessionId = auth.session.status === "authenticated"
    ? auth.session.identity.session.id
    : "";
  const active = auth.workspace.status === "ready"
    ? auth.workspace.workspace
    : null;
  const workspaceLoading = auth.workspace.status === "loading" ||
    auth.workspace.status === "idle";
  const [list, setList] = useState<WorkspaceList | null>(null);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editor, setEditor] = useState<"create" | ManagedWorkspace | null>(
    null,
  );
  const [draft, setDraft] = useState<WorkspaceUpdate>({ name: "", slug: "" });
  const [busy, setBusy] = useState<"suggest" | "save" | "switch" | "image" | null>(null);
  const requestKey = useRef("");
  const mounted = useRef(true);
  const pending = useRef(false);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const current = list?.items.find((item) => item.id === active?.id);
  const atLimit = list
    ? list.items.filter((item) => item.role === "owner").length >=
      list.maxOwnedWorkspaces
    : false;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void adapter.list(controller.signal).then((value) => {
      if (!controller.signal.aborted) setList(value);
    }).catch(() => {
      if (!controller.signal.aborted) {
        setError("Your workspaces could not be loaded. Refresh to try again.");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [adapter, revision, sessionId]);
  useEffect(() => {
    if (editor) formHeading.current?.focus();
  }, [editor]);

  function refresh() {
    setError(null);
    setSuccess(null);
    setRevision((value) => value + 1);
    void auth.refreshWorkspace();
  }
  async function propose() {
    if (pending.current) return;
    pending.current = true;
    setBusy("suggest");
    setError(null);
    setSuccess(null);
    try {
      const suggestion = await adapter.propose();
      if (!mounted.current) return;
      requestKey.current = crypto.randomUUID();
      setDraft(suggestion);
      setEditor("create");
    } catch (error) {
      if (mounted.current) setError(failure(error));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  async function switchWorkspace(id: string) {
    if (pending.current || !id || id === active?.id) return;
    pending.current = true;
    setBusy("switch");
    setError(null);
    setSuccess(null);
    setEditor(null);
    try {
      await auth.adapter.setActiveWorkspace(id);
      await auth.refreshSession();
    } catch {
      if (mounted.current) {
        setError(
          "The active workspace could not be changed. Refresh and try again.",
        );
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || pending.current || busy) return;
    pending.current = true;
    setBusy("save");
    setError(null);
    setSuccess(null);
    const creating = editor === "create";
    try {
      const saved = creating
        ? (await adapter.create(
          { name: draft.name, slug: draft.slug },
          requestKey.current,
        )).workspace
        : await adapter.update(editor.id, draft);
      if (!mounted.current) return;
      setEditor(null);
      setRevision((value) => value + 1);
      if (creating) {
        try {
          await auth.adapter.setActiveWorkspace(saved.id);
          await auth.refreshSession();
        } catch {
          if (mounted.current) {
            setError(
              "Workspace created. Select it from the list to switch to it.",
            );
          }
        }
      } else {
        setSuccess("Workspace details saved.");
        await auth.refreshWorkspace();
      }
    } catch (error) {
      if (mounted.current) setError(failure(error));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  }
  async function copyHandle() {
    if (!active) return;
    try {
      await navigator.clipboard.writeText(active.slug);
      setSuccess(
        "Workspace handle copied. Share it with an admin to request an allowance.",
      );
    } catch {
      setError(
        "Copy is unavailable. Select the workspace handle and copy it manually.",
      );
    }
  }

  return (
    <section
      id="workspaces"
      className="settings-panel settings-panel--workspace workspace-management"
      aria-labelledby="settings-workspace-title"
      aria-busy={loading || !!busy || undefined}
    >
      <header className="settings-panel__header">
        <div>
          <h2 id="settings-workspace-title">Your workspaces</h2>
          <p>Keep each project's files, tool runs, and usage together.</p>
        </div>
        {active ? <StatusBadge>Current</StatusBadge> : null}
      </header>
      <div className="settings-panel__body">
        {workspaceLoading
          ? <Skeleton label="Loading active workspace" lines={2} />
          : null}
        {loading && !list && !workspaceLoading
          ? <Skeleton label="Loading workspaces" lines={3} />
          : null}
        {auth.workspace.status === "degraded"
          ? (
            <InlineNotice title="Workspace settings unavailable" tone="error">
              <p>{auth.workspace.message}</p>
              <Button
                variant="quiet"
                disabled={!!busy}
                onClick={() => void auth.refreshWorkspace()}
              >
                Retry workspace
              </Button>
            </InlineNotice>
          )
          : null}
        {list && list.items.length > 0
          ? (
            <label className="form-field">
              <span className="form-field__label">Active workspace</span>
              <select
                className="input"
                value={active?.id ?? ""}
                disabled={!!busy || !!editor || workspaceLoading}
                onChange={(event) => void switchWorkspace(event.target.value)}
              >
                {!active ? <option value="">Choose a workspace</option> : null}
                {list.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} · {item.slug}
                  </option>
                ))}
              </select>
            </label>
          )
          : null}
        {active
          ? (
            <div className="workspace-management__identity">
              <span className="workspace-management__handle">
                @{active.slug}
              </span>
              <div className="workspace-management__badges">
                {current?.personal ? <span>Personal workspace</span> : null}
                {current?.role
                  ? <span>{current.role === "owner" ? "Owner" : "Member"}</span>
                  : null}
              </div>
              <div className="workspace-management__actions">
                <Button variant="quiet" onClick={() => void copyHandle()}>
                  Copy handle
                </Button>
                {current?.role === "owner"
                  ? (
                    <Button
                      variant="quiet"
                      disabled={!!busy || !!editor}
                      onClick={() => {
                        setDraft({
                          name: current.name,
                          slug: current.slug,
                          logo: current.logo ?? null,
                        });
                        setEditor(current);
                        setError(null);
                        setSuccess(null);
                      }}
                    >
                      Edit details
                    </Button>
                  )
                  : null}
              </div>
              <details className="workspace-management__reference">
                <summary>Workspace ID</summary>
                <code>{active.id}</code>
              </details>
            </div>
          )
          : auth.workspace.status === "empty"
          ? <p>No active workspace. Choose one above or create a new one.</p>
          : null}
        {list
          ? (
            <>
              {!editor
                ? (
                  <div className="workspace-management__actions">
                    <Button
                      variant="outline"
                      disabled={!!busy || atLimit}
                      pending={busy === "suggest"}
                      onClick={() => void propose()}
                    >
                      New workspace
                    </Button>
                    <Button
                      variant="quiet"
                      disabled={!!busy || loading}
                      onClick={refresh}
                    >
                      Refresh
                    </Button>
                  </div>
                )
                : null}
              {atLimit
                ? (
                  <p className="workspace-management__hint">
                    You own the maximum of {list.maxOwnedWorkspaces} workspaces.
                  </p>
                )
                : null}
            </>
          )
          : null}
        {editor
          ? (
            <form
              className="workspace-management__form"
              onSubmit={(event) => void save(event)}
            >
              <h3 ref={formHeading} tabIndex={-1}>
                {editor === "create"
                  ? "Create a workspace"
                  : "Edit workspace details"}
              </h3>
              <p>
                {editor === "create"
                  ? "Use the suggested name and handle, or make them your own."
                  : "Existing files, access, and usage stay with this workspace."}
              </p>
              <fieldset disabled={!!busy}>
                <legend className="sr-only">Workspace details</legend>
                {editor !== "create"
                  ? (
                    <ImagePicker
                      label="Workspace logo"
                      value={draft.logo ?? null}
                      onChange={(logo) =>
                        setDraft((value) => ({ ...value, logo }))}
                      disabled={!!busy}
                      onBusyChange={(preparing) => setBusy(preparing ? "image" : null)}
                    />
                  )
                  : null}
                <label className="form-field">
                  <span className="form-field__label">Workspace name</span>
                  <input
                    className="input"
                    required
                    minLength={2}
                    maxLength={80}
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((value) => ({
                        ...value,
                        name: event.target.value,
                      }))}
                    autoComplete="off"
                  />
                </label>
                <label className="form-field">
                  <span
                    id="workspace-handle-label"
                    className="form-field__label"
                  >
                    Workspace handle
                  </span>
                  <input
                    className="input"
                    required
                    minLength={3}
                    maxLength={64}
                    pattern="[a-z0-9]+(-[a-z0-9]+)*"
                    value={draft.slug}
                    readOnly={editor !== "create"}
                    onChange={(event) =>
                      setDraft((value) => ({
                        ...value,
                        slug: event.target.value.toLowerCase(),
                      }))}
                    aria-labelledby="workspace-handle-label"
                    aria-describedby="workspace-handle-hint"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span id="workspace-handle-hint" className="form-field__hint">
                    {editor === "create"
                      ? "Choose a unique handle using lowercase letters, numbers, and hyphens. It cannot be changed later."
                      : "This handle is permanent. You can change the workspace name above."}
                  </span>
                </label>
              </fieldset>
              {editor === "create"
                ? (
                  <p className="workspace-management__hint">
                    A superadmin must grant execution access and a usage
                    allowance before this workspace can run tools.
                  </p>
                )
                : null}
              <div className="workspace-management__actions">
                <Button
                  type="submit"
                  pending={busy === "save"}
                  disabled={busy !== null && busy !== "save"}
                >
                  {editor === "create" ? "Create workspace" : "Save changes"}
                </Button>
                <Button
                  variant="quiet"
                  disabled={!!busy}
                  onClick={() => {
                    setEditor(null);
                    setError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          )
          : null}
        {current?.role === "owner" && !current.personal && !editor && !busy
          ? (
            <DeleteWorkspace
              key={current.id}
              workspace={current}
              adapter={adapter}
              onDeleted={async () => {
                setList(null);
                setRevision((value) => value + 1);
                await auth.refreshSession({ preserveView: true });
                setSuccess("Workspace deleted.");
              }}
            />
          )
          : null}
        {error
          ? (
            <InlineNotice title="Workspace needs attention" tone="error">
              <p>{error}</p>
              {!editor && !busy
                ? (
                  <Button variant="quiet" onClick={refresh}>
                    Refresh workspaces
                  </Button>
                )
                : null}
            </InlineNotice>
          )
          : null}
        {success
          ? (
            <p className="workspace-management__success" role="status">
              {success}
            </p>
          )
          : null}
      </div>
    </section>
  );
}
