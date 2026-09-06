import {
  type KeyboardEvent,
  type ReactNode,
  useId,
  useLayoutEffect,
  useRef,
} from "react";
import { Button } from "./Button";

interface ConfirmDialogProps {
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly confirmPendingLabel?: string;
  readonly cancelLabel?: string;
  readonly pending?: boolean;
  readonly tone?: "default" | "danger";
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
  )).filter((element) => !element.hasAttribute("hidden"));
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  confirmPendingLabel,
  cancelLabel = "Cancel",
  pending = false,
  tone = "default",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const id = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();

    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!pending) onCancel();
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
    if (!focusable.includes(document.activeElement as HTMLElement)) {
      event.preventDefault();
      if (event.shiftKey) last.focus();
      else first.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className="confirm-dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !pending) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        aria-busy={pending || undefined}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        <p id={`${id}-description`}>{description}</p>
        <div className="confirm-dialog__actions">
          <Button variant="quiet" disabled={pending} onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "outline" : "accent"}
            pending={pending}
            pendingLabel={confirmPendingLabel}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
