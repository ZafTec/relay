import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/globals.css";

// Load telemetry independently so a collector or SDK failure cannot block React.
// Production previews and local tests must never report to the live collector.
if (
  import.meta.env.PROD &&
  globalThis.location.origin === import.meta.env.VITE_APP_ORIGIN &&
  import.meta.env.VITE_FARO_COLLECTOR_URL
) {
  void import("./observability/faro")
    .then(({ startBrowserTelemetry }) => startBrowserTelemetry())
    .catch(() => {});
}

const root = document.getElementById("root");
if (!root) throw new Error("Relay root element was not found.");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
