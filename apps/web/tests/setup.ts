import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import "../src/styles/tokens.css";
import "../src/styles/globals.css";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});
