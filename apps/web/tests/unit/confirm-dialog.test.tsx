import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, test, vi } from "vitest";
import { ConfirmDialog } from "../../src/components/ui/ConfirmDialog";

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open confirmation</button>
      {open
        ? (
          <ConfirmDialog
            title="Confirm action"
            description="Review before continuing."
            confirmLabel="Confirm"
            onConfirm={() => setOpen(false)}
            onCancel={() => setOpen(false)}
          />
        )
        : null}
    </>
  );
}

test("confirmation focus is ready for immediate keyboard navigation and restores the trigger", () => {
  vi.useFakeTimers();
  try {
    render(<DialogHarness />);
    const trigger = screen.getByRole("button", { name: "Open confirmation" });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("alertdialog");
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(cancel).toHaveFocus();
    act(() => vi.runOnlyPendingTimers());
    expect(cancel).toHaveFocus();

    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  } finally {
    vi.useRealTimers();
  }
});
