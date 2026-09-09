import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { httpWorkspaceAdapter, type ManagedWorkspace } from "../../lib/api/workspaces";

interface SwitchableWorkspace { readonly id: string; readonly name: string }

function initial(name: string): string {
  return name.trim().charAt(0).toUpperCase() || "R";
}

export function WorkspaceSwitcher() {
  const auth = useAuth();
  const active = auth.workspace.status === "ready" ? auth.workspace.workspace : null;
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ManagedWorkspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  function closeAndRestoreFocus() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeAndRestoreFocus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setError(null);
    void httpWorkspaceAdapter.list(controller.signal).then((result) => {
      if (!controller.signal.aborted) setItems(result.items);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Your workspaces could not be loaded.");
    });
    return () => controller.abort();
  }, [open]);

  useEffect(() => {
    if (open) {
      setFocusedId(active?.id ?? null);
      panelRef.current?.querySelector<HTMLElement>("[aria-selected='true']")?.focus();
    }
  }, [open, active?.id]);

  function navigateOptions(event: ReactKeyboardEvent<HTMLUListElement>) {
    const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("[role='option']:not(:disabled)"));
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (current + 1) % options.length
      : event.key === "ArrowUp" ? (current - 1 + options.length) % options.length
      : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); options[next]?.focus(); }
  }

  async function switchTo(workspace: SwitchableWorkspace) {
    if (switching) return;
    if (workspace.id === active?.id) { closeAndRestoreFocus(); return; }
    setSwitching(workspace.id);
    setError(null);
    try {
      await auth.adapter.setActiveWorkspace(workspace.id);
      await auth.refreshSession();
      if (alive.current) setOpen(false);
    } catch {
      if (alive.current) setError("The active workspace could not be changed. Try again.");
    } finally {
      if (alive.current) setSwitching(null);
    }
  }

  if (auth.workspace.status === "loading" || auth.workspace.status === "idle") {
    return (
      <div className="workspace-switcher" role="status">
        <span className="workspace-switcher__avatar" aria-hidden="true">·</span>
        <span className="workspace-switcher__name">Loading workspace</span>
      </div>
    );
  }

  if (auth.workspace.status === "degraded") {
    return (
      <div className="workspace-switcher" role="status">
        <span className="workspace-switcher__avatar workspace-switcher__avatar--warn" aria-hidden="true">▲</span>
        <span className="workspace-switcher__name">Workspace unavailable</span>
      </div>
    );
  }

  if (!active) {
    return (
      <Link className="workspace-switcher workspace-switcher--empty" to="/dashboard/settings#workspaces">
        <span className="workspace-switcher__avatar" aria-hidden="true">＋</span>
        <span className="workspace-switcher__name">Choose a workspace</span>
      </Link>
    );
  }

  return (
    <div className="workspace-switcher" ref={rootRef} onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }}>
      <button
        type="button"
        ref={triggerRef}
        className="workspace-switcher__trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
        }}
      >
        <span className="workspace-switcher__avatar" aria-hidden="true">{initial(active.name)}</span>
        <span className="workspace-switcher__name">{active.name}</span>
        <span className="workspace-switcher__chevron" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="workspace-switcher__panel" ref={panelRef}>
          <p className="workspace-switcher__eyebrow">Organizations</p>
          {error ? <p className="workspace-switcher__error" role="alert">{error}</p> : null}
          <ul id={listId} className="workspace-switcher__list" role="listbox" aria-label="Your workspaces" aria-busy={switching !== null} onKeyDown={navigateOptions}>
            {(items ?? [active]).map((workspace) => (
              <li key={workspace.id} role="presentation">
                <button
                  type="button"
                  role="option"
                  aria-selected={workspace.id === active.id}
                  tabIndex={workspace.id === (focusedId ?? active.id) ? 0 : -1}
                  onFocus={() => setFocusedId(workspace.id)}
                  className="workspace-switcher__option"
                  disabled={switching !== null}
                  onClick={() => void switchTo(workspace)}
                >
                  <span className="workspace-switcher__avatar" aria-hidden="true">{initial(workspace.name)}</span>
                  <span className="workspace-switcher__option-name">{workspace.name}</span>
                  {workspace.id === active.id ? <span className="workspace-switcher__check" aria-hidden="true">✓</span> : null}
                  <span className="sr-only">{workspace.id === active.id ? "Current workspace" : "Switch to this workspace"}</span>
                </button>
              </li>
            ))}
          </ul>
          <Link className="workspace-switcher__create" to="/dashboard/settings#workspaces" onClick={() => setOpen(false)}>
            <span className="workspace-switcher__avatar workspace-switcher__avatar--ghost" aria-hidden="true">＋</span>
            Create workspace
          </Link>
        </div>
      ) : null}
    </div>
  );
}
