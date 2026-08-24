import axe from "axe-core";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { EmptyState } from "../../src/components/ui/EmptyState";
import { InlineNotice } from "../../src/components/ui/InlineNotice";
import { StatusBadge } from "../../src/components/ui/StatusBadge";
import { LandingPage } from "../../src/features/landing/LandingPage";

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
    },
  });
  expect(results.violations).toEqual([]);
}

describe("accessibility primitives", () => {
  it("exposes glyph and text status without color-only meaning", async () => {
    const { container } = render(
      <main className="product-surface">
        <h1>State specimen</h1>
        <StatusBadge tone="warning">Action required</StatusBadge>
        <InlineNotice title="Provider unavailable" tone="error">
          <p>No request was submitted.</p>
        </InlineNotice>
        <EmptyState label="Empty" title="No results"><p>Run a tool to create one.</p></EmptyState>
      </main>,
    );

    expect(screen.getByText("Action required")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Provider unavailable");
    await expectNoAxeViolations(container);
  });

  it("keeps the landing page landmark and heading structure axe-clean", async () => {
    const { container } = render(
      <MemoryRouter>
        <LandingPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toBeInTheDocument();
    await expectNoAxeViolations(container);
  });
});
