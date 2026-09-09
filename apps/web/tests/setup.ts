import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import "../src/styles/tokens.css";
import "../src/styles/globals.css";

// jsdom has no layout or scrolling; browser tests verify the visible result.
HTMLElement.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
