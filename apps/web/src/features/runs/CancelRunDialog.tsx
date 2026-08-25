import { useEffect, useRef } from "react";
import { Button } from "../../components/ui/Button";

export type CancelDialogState =
  | { readonly kind: "closed" }
  | { readonly kind: "confirming" }
  | { readonly kind: "pending" }
  | { readonly kind: "error"; readonly message: string };

interface CancelRunDialogProps {
  readonly runId: string;
  readonly state: CancelDialogState;
  readonly returnFocusTo: HTMLButtonElement | null;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((element) => element.getAttribute("aria-disabled") !== "true");
}

export function CancelRunDialog({
  runId,
  state,
  returnFocusTo,
  onConfirm,
  onClose,
}: CancelRunDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingRef = useRef(false);
  const open = state.kind !== "closed";
  const pending = state.kind === "pending";
  pendingRef.current = pending;

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (dialog === null) return;
      if (event.key === "Escape") {
        if (!pendingRef.current) {
          event.preventDefault();
          onClose();
        }
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialog);
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (returnFocusTo?.isConnected && !returnFocusTo.disabled) {
        window.setTimeout(() => returnFocusTo.focus(), 0);
      }
    };
  }, [onClose, open, returnFocusTo]);

  useEffect(() => {
    if (!open) return;
    if (pending) dialogRef.current?.focus();
    else headingRef.current?.focus();
  }, [open, pending, state.kind]);

  if (!open) return null;

  return (
    <div className="run-dialog-scrim">
      <div
        className="run-cancel-dialog"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-run-title"
        aria-describedby="cancel-run-description"
        aria-busy={pending || undefined}
        tabIndex={-1}
      >
        <header className="run-cancel-dialog__header">
          <div>
            <p className="mono-label">Run cancellation</p>
            <h2 id="cancel-run-title" ref={headingRef} tabIndex={-1}>
              {state.kind === "error" ? "Cancellation not confirmed" : "Request cancellation?"}
            </h2>
          </div>
          <button
            className="run-dialog-close"
            type="button"
            aria-label="Close cancellation dialog"
            disabled={pending}
            onClick={() => {
              if (!pending) onClose();
            }}
          >
            Close
          </button>
        </header>
        <div className="run-cancel-dialog__body">
          <code>{runId}</code>
          <p id="cancel-run-description">
            {state.kind === "error"
              ? state.message
              : "Relay will ask the current work to stop. If the run reaches a terminal result first, that result wins. The cancellation request is safe to send again only after this request finishes."}
          </p>
        </div>
        <footer className="run-cancel-dialog__actions">
          <Button
            variant="outline"
            pending={pending}
            pendingLabel="Requesting cancellation"
            onClick={onConfirm}
          >
            {state.kind === "error" ? "Try cancellation again" : "Request cancellation"}
          </Button>
          <Button
            variant="quiet"
            disabled={pending}
            onClick={() => {
              if (!pending) onClose();
            }}
          >
            Keep run
          </Button>
        </footer>
      </div>
    </div>
  );
}
