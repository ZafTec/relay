import {
  type KeyboardEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";

export type ReleaseActionKind = "publish" | "unpublish";

interface ReleaseActionDialogProps {
  readonly kind: ReleaseActionKind;
  readonly version: string;
  readonly blockers?: readonly string[];
  readonly requiresSecurityAcknowledgement?: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
  )).filter((element) => !element.hasAttribute("hidden"));
}

export function ReleaseActionDialog({
  kind,
  version,
  blockers = [],
  requiresSecurityAcknowledgement = false,
  pending,
  error,
  onConfirm,
  onClose,
}: ReleaseActionDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [securityAcknowledged, setSecurityAcknowledged] = useState(false);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => headingRef.current?.focus(), 0);

    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    if (pending) dialogRef.current?.focus();
  }, [pending]);

  function close() {
    if (!pending) onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab" || dialogRef.current === null) return;

    const focusable = focusableElements(dialogRef.current);
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first === undefined || last === undefined) {
      event.preventDefault();
      dialogRef.current.focus();
      return;
    }
    const active = document.activeElement as HTMLElement;
    if (!focusable.includes(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const publishing = kind === "publish";
  const title = publishing
    ? `Publish ${version} to the public changelog?`
    : `Unpublish ${version}?`;
  const description = publishing
    ? "The latest saved revision will become visible on the public changelog."
    : "The published revision will leave the public changelog. Stored release history remains archived in admin.";

  return (
    <div
      className="admin-action-dialog-scrim product-surface"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialogRef}
        className="admin-action-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        aria-busy={pending || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="admin-action-dialog__header">
          <p className="mono-label">Confirm {publishing ? "publication" : "unpublish"}</p>
          <h2 id={`${id}-title`} ref={headingRef} tabIndex={-1}>{title}</h2>
        </header>
        <div className="admin-action-dialog__body">
          <p id={`${id}-description`}>{description}</p>
          {blockers.length > 0 ? (
            <div className="admin-action-dialog__blockers" role="alert">
              <strong>Publication blocked</strong>
              <ul>
                {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
              </ul>
            </div>
          ) : null}
          {publishing && requiresSecurityAcknowledgement ? (
            <label className="admin-security-acknowledgement">
              <input
                type="checkbox"
                checked={securityAcknowledged}
                disabled={pending}
                onChange={(event) => setSecurityAcknowledged(event.currentTarget.checked)}
              />
              <span>
                <strong>Confirm public disclosure</strong>
                <small>
                  I reviewed the security-category items for public disclosure. This
                  browser confirmation is not stored as a separate approval record.
                </small>
              </span>
            </label>
          ) : null}
          {error ? (
            <InlineNotice title={`${publishing ? "Publication" : "Unpublish"} not completed`} tone="error">
              <p>{error}</p>
            </InlineNotice>
          ) : null}
        </div>
        <footer className="admin-action-dialog__actions">
          <Button variant="outline" disabled={pending} onClick={close}>
            Cancel
          </Button>
          <Button
            pending={pending}
            pendingLabel={publishing ? "Publishing..." : "Unpublishing..."}
            disabled={
              blockers.length > 0
              || (publishing
                && requiresSecurityAcknowledgement
                && !securityAcknowledged)
            }
            onClick={onConfirm}
          >
            {publishing ? `Publish ${version}` : `Unpublish ${version}`}
          </Button>
        </footer>
      </div>
    </div>
  );
}
