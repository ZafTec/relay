import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { RelayBrand } from "../../components/brand/RelayBrand";
import { Button, LinkButton } from "../../components/ui/Button";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  type StatusAdapter,
  type StatusBuildSnapshot,
  type StatusReadinessCheck,
  type StatusReadinessSnapshot,
  httpStatusAdapter,
} from "../../lib/api/status";
import "./status.css";

type ReadinessState = StatusReadinessSnapshot | { readonly kind: "loading" };
type BuildState = StatusBuildSnapshot | { readonly kind: "loading" };

interface StatusPageProps {
  statusAdapter?: StatusAdapter;
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

function StatusHeader() {
  return (
    <header className="service-status-header">
      <div className="service-status-header__inner">
        <div className="service-status-header__brand">
          <RelayBrand />
          <span>Status</span>
        </div>
        <nav className="service-status-header__nav" aria-label="Primary">
          <Link className="service-status-header__link" to="/docs">Docs</Link>
          <Link className="service-status-header__link" to="/status" aria-current="page">Status</Link>
          <LinkButton className="service-status-header__dashboard" to="/dashboard">Open dashboard</LinkButton>
        </nav>
        <a className="service-status-header__json" href="/health/ready">JSON</a>
      </div>
    </header>
  );
}

function readinessPresentation(state: ReadinessState): {
  readonly title: string;
  readonly metadata: string;
} {
  switch (state.kind) {
    case "loading":
      return {
        title: "Checking Relay readiness",
        metadata: "Requesting the current readiness response",
      };
    case "operational":
      return {
        title: "All reported checks operational",
        metadata: `${state.readiness.service} reported ready`,
      };
    case "degraded":
      return {
        title: "Relay readiness is degraded",
        metadata: `${state.readiness.service} reported a dependency failure`,
      };
    case "unknown":
      return {
        title: "Current readiness unknown",
        metadata: state.message,
      };
  }
}

function StatusSummary({
  readiness,
  refreshing,
  onRefresh,
}: {
  readiness: ReadinessState;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const presentation = readinessPresentation(readiness);

  return (
    <section className={`service-status-summary service-status-summary--${readiness.kind}`}>
      <div
        className="service-status-summary__message"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-busy={readiness.kind === "loading" || undefined}
        aria-labelledby="service-status-title"
      >
        <div>
          <p className="service-status-summary__label">Readiness</p>
          <h1 id="service-status-title">{presentation.title}</h1>
          <p className="service-status-summary__metadata">{presentation.metadata}</p>
        </div>
      </div>
      <div className="service-status-summary__actions">
        <a className="button button--outline" href="/health/ready">
          <span className="button__label">Readiness JSON</span>
        </a>
        <Button
          variant="ink"
          pending={refreshing}
          pendingLabel="Checking status"
          onClick={onRefresh}
        >
          Check again
        </Button>
      </div>
    </section>
  );
}

function CheckRow({ check }: { check: StatusReadinessCheck }) {
  const operational = check.status === "ok";

  return (
    <li className={operational ? "service-check service-check--operational" : "service-check service-check--degraded"}>
      <div className="service-check__copy">
        <strong>{check.name}</strong>
        {check.message ? <span>{check.message}</span> : null}
      </div>
      <span className="service-check__state">{operational ? "Operational" : "Degraded"}</span>
    </li>
  );
}

function BuildIdentity({ state }: { state: BuildState }) {
  return (
    <section className="service-status-panel" aria-labelledby="build-identity-title" aria-busy={state.kind === "loading" || undefined}>
      <p className="service-status-panel__label">Build identity</p>
      <h2 id="build-identity-title">Running version</h2>
      {state.kind === "loading" ? <Skeleton label="Loading build identity" lines={2} /> : null}
      {state.kind === "available" ? (
        <dl className="service-status-build">
          <div>
            <dt>Version</dt>
            <dd><code>{state.build.version}</code></dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd><code>{state.build.revision}</code></dd>
          </div>
        </dl>
      ) : null}
      {state.kind === "unknown" ? (
        <p className="service-status-panel__empty">{state.message}</p>
      ) : null}
    </section>
  );
}

function ReportedChecks({ state }: { state: Extract<StatusReadinessSnapshot, { kind: "operational" | "degraded" }> }) {
  return (
    <section className="service-status-panel" aria-labelledby="reported-checks-title">
      <p className="service-status-panel__label">Current response</p>
      <h2 id="reported-checks-title">Reported checks</h2>
      {state.readiness.checks.length > 0 ? (
        <ul className="service-checks">
          {state.readiness.checks.map((check) => <CheckRow key={check.name} check={check} />)}
        </ul>
      ) : (
        <p className="service-status-panel__empty">
          The readiness response did not list dependency checks.
        </p>
      )}
    </section>
  );
}

function UnknownReadiness({ message }: { message: string }) {
  return (
    <section className="service-status-panel service-status-panel--unknown" aria-labelledby="unknown-evidence-title">
      <p className="service-status-panel__label">Verification boundary</p>
      <h2 id="unknown-evidence-title">No last-known state is substituted</h2>
      <p>{message}</p>
      <p>
        Relay does not reuse an earlier result or infer availability from this page.
      </p>
    </section>
  );
}

function LoadingReadiness() {
  return (
    <section className="service-status-panel service-status-panel--loading" aria-label="Loading readiness details">
      <Skeleton label="Loading readiness details" lines={3} />
    </section>
  );
}

export function StatusPage({ statusAdapter = httpStatusAdapter }: StatusPageProps) {
  usePageMetadata("Service status | Relay", "#F5F4ED");
  const [readiness, setReadiness] = useState<ReadinessState>({ kind: "loading" });
  const [build, setBuild] = useState<BuildState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setReadiness({ kind: "loading" });
    setBuild({ kind: "loading" });

    void (async () => {
      try {
        const result = await statusAdapter.loadReadiness(controller.signal);
        if (active) setReadiness(result);
      } catch (error) {
        if (!active || isAbortError(error)) return;
        setReadiness({
          kind: "unknown",
          message: "Relay readiness could not be verified. The service may still be available.",
        });
      }
    })();

    void (async () => {
      try {
        const result = await statusAdapter.loadBuild(controller.signal);
        if (active) setBuild(result);
      } catch (error) {
        if (!active || isAbortError(error)) return;
        setBuild({ kind: "unknown", message: "Build identity could not be verified." });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [reloadKey, statusAdapter]);

  const refreshing = readiness.kind === "loading" || build.kind === "loading";

  return (
    <div className="service-status-page public-surface">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <StatusHeader />

      <main id="main-content" className="service-status-main">
        <p className="kicker"><span>// 01</span> Service status</p>
        <StatusSummary
          readiness={readiness}
          refreshing={refreshing}
          onRefresh={() => setReloadKey((value) => value + 1)}
        />

        <div className="service-status-grid">
          {readiness.kind === "loading" ? <LoadingReadiness /> : null}
          {readiness.kind === "operational" || readiness.kind === "degraded" ? (
            <ReportedChecks state={readiness} />
          ) : null}
          {readiness.kind === "unknown" ? <UnknownReadiness message={readiness.message} /> : null}
          <BuildIdentity state={build} />
        </div>

        <details className="service-status-scope">
          <summary>What this page can verify</summary>
          <div>
            <p>
              Relay reports only the current API readiness response, its named dependency checks,
              and the running build identity exposed by the service.
            </p>
            <p>
              These endpoints do not publish historical uptime percentages or incident records,
              so this page does not present either as fact.
            </p>
            <dl className="service-status-endpoints">
              <div>
                <dt><code>/health/ready</code></dt>
                <dd>Current readiness and dependency checks</dd>
              </div>
              <div>
                <dt><code>/version</code></dt>
                <dd>Running version and source revision</dd>
              </div>
            </dl>
          </div>
        </details>
      </main>

      <footer className="service-status-footer">
        <p>Current service facts only. No sample incidents or historical availability.</p>
        <nav aria-label="Status footer">
          <Link to="/docs">Docs</Link>
          <a href="/health/ready">Readiness JSON</a>
        </nav>
      </footer>
    </div>
  );
}
