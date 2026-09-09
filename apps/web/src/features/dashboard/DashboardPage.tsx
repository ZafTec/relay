import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  type DashboardOverviewAdapter,
  type DashboardOverviewResult,
  httpDashboardOverviewAdapter,
} from "../../lib/api/dashboard";
import { httpStorageUsageAdapter } from "../../lib/api/storage-usage";
import { formatRunTimestamp, RunStatusBadge } from "../runs/run-display";
import { StorageUsagePanel } from "../usage/StorageUsagePanel";
import { formatBytes } from "../artifacts/artifact-display";
import "../usage/usage.css";
import "./overview.css";

export function DashboardPage(
  { overviewAdapter = httpDashboardOverviewAdapter }: {
    overviewAdapter?: DashboardOverviewAdapter;
  },
) {
  usePageMetadata("Overview | Relay", "#0F1010");
  const { session, workspace, expireSession } = useAuth();
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const workspaceId = workspace.status === "ready"
    ? workspace.workspace.id
    : undefined;
  const [state, setState] = useState<
    DashboardOverviewResult | { kind: "loading" }
  >({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState({ kind: "loading" });
    if (workspaceId) {
      void overviewAdapter.load(controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        if (result.kind === "auth-expired") expireSession(sessionId);
        else setState(result);
      }).catch(() => {
        if (!controller.signal.aborted) {
          setState({
            kind: "degraded",
            message: "Your overview couldn’t be loaded. Please try again.",
          });
        }
      });
    }
    return () => controller.abort();
  }, [expireSession, overviewAdapter, reloadKey, sessionId, workspaceId]);
  const data = state.kind === "ok" ? state.overview : null;
  return (
    <div className="dashboard-page overview-page">
      <header className="dashboard-header">
        <div>
          <p className="mono-label">
            {workspace.status === "ready"
              ? workspace.workspace.name
              : "Your workspace"}
          </p>
          <h1>Overview</h1>
        </div>
        <div className="overview-actions">
          <Button
            variant="quiet"
            disabled={state.kind === "loading"}
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Refresh
          </Button>
          <LinkButton to="/dashboard/tools">Explore tools</LinkButton>
        </div>
      </header>
      <div className="dashboard-body">
        {workspace.status === "empty"
          ? (
            <InlineNotice title="Choose a workspace">
              <p>
                <Link to="/dashboard/settings#workspaces">
                  Select or create a workspace
                </Link>{" "}
                to see your activity.
              </p>
            </InlineNotice>
          )
          : null}
        {state.kind === "loading" && workspace.status !== "empty"
          ? <Skeleton label="Loading workspace overview" lines={5} />
          : null}
        {state.kind === "degraded"
          ? (
            <InlineNotice
              title="Overview unavailable"
              tone="error"
              action={
                <Button
                  variant="outline"
                  onClick={() => setReloadKey((value) => value + 1)}
                >
                  Try again
                </Button>
              }
            >
              <p>{state.message}</p>
            </InlineNotice>
          )
          : null}
        {data
          ? (
            <>
              <dl className="overview-stats">
                {[
                  ["Total runs", data.counts.runs, "/dashboard/runs"],
                  ["In progress", data.counts.activeRuns, "/dashboard/runs"],
                  ["Failed runs", data.counts.failedRuns, "/dashboard/runs"],
                  [
                    "Saved files",
                    data.counts.artifacts,
                    "/dashboard/artifacts",
                  ],
                ].map(([label, value, url]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <Link to={String(url)}>
                        {Number(value).toLocaleString()}
                      </Link>
                    </dd>
                  </div>
                ))}
              </dl>
              {data.counts.runs === 0 && data.counts.artifacts === 0
                ? (
                  <section className="overview-welcome">
                    <h2>Your workspace is ready</h2>
                    <p>
                      Choose a tool to create your first run, or add files to
                      use with your agent.
                    </p>
                    <div className="overview-actions">
                      <LinkButton to="/dashboard/tools">Find a tool</LinkButton>
                      <LinkButton variant="outline" to="/dashboard/artifacts">
                        Add files
                      </LinkButton>
                      <Link to="/dashboard/oauth-clients">
                        Connect an agent
                      </Link>
                    </div>
                  </section>
                )
                : null}
              <div className="overview-columns">
                <section
                  className="overview-panel"
                  aria-labelledby="overview-runs"
                >
                  <header>
                    <h2 id="overview-runs">Recent runs</h2>
                    <Link to="/dashboard/runs">View all</Link>
                  </header>
                  {data.runs.length
                    ? (
                      <ul className="overview-list">
                        {data.runs.map((run) => (
                          <li key={run.id}>
                            <Link to={"/dashboard/runs/" + run.id}>
                              <span>
                                <strong>{run.tool.name}</strong>
                                <time dateTime={run.acceptedAt}>
                                  {formatRunTimestamp(run.acceptedAt)}
                                </time>
                              </span>
                              <RunStatusBadge status={run.status} />
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )
                    : (
                      <p className="overview-empty">
                        Your runs will appear here when you start using a tool.
                      </p>
                    )}
                </section>
                <section
                  className="overview-panel"
                  aria-labelledby="overview-files"
                >
                  <header>
                    <h2 id="overview-files">Recent files</h2>
                    <Link to="/dashboard/artifacts">View all</Link>
                  </header>
                  {data.artifacts.length
                    ? (
                      <ul className="overview-list">
                        {data.artifacts.map((file) => (
                          <li key={file.id}>
                            <Link to={"/dashboard/artifacts/" + file.id}>
                              <span>
                                <strong>{file.name}</strong>
                                <small>{file.mediaKind}</small>
                              </span>
                              <small>
                                {file.currentVersion
                                  ? formatBytes(file.currentVersion.sizeBytes)
                                  : "Preparing"}
                              </small>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    )
                    : (
                      <p className="overview-empty">
                        Upload a file or create one with a tool to see it here.
                      </p>
                    )}
                </section>
              </div>
              <StorageUsagePanel
                adapter={httpStorageUsageAdapter}
                reloadKey={reloadKey}
              />
              <p className="overview-updated">
                Updated{" "}
                <time dateTime={data.generatedAt}>
                  {formatRunTimestamp(data.generatedAt)}
                </time>
              </p>
            </>
          )
          : null}
      </div>
    </div>
  );
}
