import { useEffect, useState } from "react";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import {
  type DashboardOverviewAdapter,
  type DashboardOverviewResult,
  httpDashboardOverviewAdapter,
} from "../../lib/api/dashboard";

interface DashboardPageProps {
  overviewAdapter?: DashboardOverviewAdapter;
}

export function DashboardPage({ overviewAdapter = httpDashboardOverviewAdapter }: DashboardPageProps) {
  usePageMetadata("Overview | Relay", "#141A16");
  const { session, workspace, expireSession } = useAuth();
  const sessionId = session.status === "authenticated" ? session.identity.session.id : undefined;
  const [state, setState] = useState<DashboardOverviewResult | { kind: "loading" }>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    void overviewAdapter.load(controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      setState(result);
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setState({
        kind: "degraded",
        message: "Relay could not load the overview. No workspace data was changed.",
      });
    });
    return () => controller.abort();
  }, [expireSession, overviewAdapter, reloadKey, sessionId]);

  const workspaceId = workspace.status === "ready" ? workspace.workspace.id : null;

  return (
    <div className="dashboard-page">
      <header className="dashboard-header">
        <div>
          <p className="mono-label">{workspaceId ? `Workspace ${workspaceId}` : "Workspace context"}</p>
          <h1>Overview</h1>
        </div>
        <Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>Refresh</Button>
      </header>

      <div className="dashboard-body">
        {workspace.status === "empty" ? (
          <InlineNotice title="No active workspace" tone="error">
            <p>Relay could not resolve a workspace for this session. Sign out, then sign in again.</p>
          </InlineNotice>
        ) : null}

        {state.kind === "loading" ? <Skeleton label="Loading dashboard overview" lines={4} /> : null}

        {state.kind === "degraded" ? (
          <InlineNotice
            title="Overview unavailable"
            tone="error"
            action={<Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>Try again</Button>}
          >
            <p>{state.message}</p>
          </InlineNotice>
        ) : null}

        {state.kind === "empty" ? (
          <EmptyState
            label="API connected / summary contract pending"
            title="No overview data is exposed yet"
            actions={<Button variant="outline" onClick={() => setReloadKey((value) => value + 1)}>Check again</Button>}
            aside={
              <div className="connection-ledger">
                <StatusBadge tone="ready">API available</StatusBadge>
                <dl>
                  <div><dt>Service</dt><dd>{state.serviceName}</dd></div>
                  <div><dt>Counts</dt><dd>Not requested</dd></div>
                  <div><dt>Fallback data</dt><dd>None</dd></div>
                </dl>
              </div>
            }
          >
            <p>
              The current API confirms service availability but does not publish a dashboard
              summary. Relay does not invent run, artifact, tool, or usage counts.
            </p>
          </EmptyState>
        ) : null}

        <section className="dashboard-contract" aria-labelledby="dashboard-contract-title">
          <div>
            <p className="mono-label">Resource views</p>
            <h2 id="dashboard-contract-title">The rail exposes only implemented web routes.</h2>
          </div>
          <div className="dashboard-contract__rows">
            {[
              ["Tools", "Catalog and contract views", "Available"],
              ["Runs", "Run and live-event views", "Available"],
              ["Artifacts", "Registry and share views", "Available"],
              ["Usage", "Usage summary view", "Available"],
              ["Settings", "Workspace context view", "Available"],
            ].map(([name, description, status]) => (
              <div key={name}>
                <strong>{name}</strong>
                <span>{description}</span>
                {status === "Available"
                  ? <StatusBadge>Available</StatusBadge>
                  : <StatusBadge tone="pending">Soon</StatusBadge>}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
