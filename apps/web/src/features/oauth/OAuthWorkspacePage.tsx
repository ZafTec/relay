import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import type { RelayWorkspace } from "../../auth/types";
import { OAuthLayout } from "../../components/layout/OAuthLayout";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { RadioCard } from "../../components/ui/FormField";
import { Skeleton } from "../../components/ui/Skeleton";

export function OAuthWorkspacePage() {
  usePageMetadata("Choose workspace | Relay", "#141A16");
  const { adapter, session, workspace, refreshSession } = useAuth();
  const [workspaces, setWorkspaces] = useState<RelayWorkspace[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(true);
  const [continuing, setContinuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);

  const activeWorkspaceId = session.status === "authenticated"
    ? session.identity.session.activeWorkspaceId
    : null;

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void adapter.listWorkspaces().then((items) => {
      if (!active) return;
      setWorkspaces(items);
      const preferred = items.find((item) => item.id === activeWorkspaceId)?.id ?? items[0]?.id ?? "";
      setSelectedId(preferred);
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setWorkspaces([]);
      setSelectedId("");
      setError("Relay could not load eligible workspaces. Authorization was not changed.");
      setLoading(false);
    });
    return () => { active = false; };
  }, [activeWorkspaceId, adapter, reloadVersion]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((item) => item.id === selectedId) ?? null,
    [selectedId, workspaces],
  );

  async function continueAuthorization() {
    if (!selectedWorkspace) return;
    setContinuing(true);
    setError(null);
    try {
      if (selectedWorkspace.id !== activeWorkspaceId) {
        await adapter.setActiveWorkspace(selectedWorkspace.id);
        await refreshSession();
      }
      await adapter.continueOAuthWorkspace();
      setContinuing(false);
    } catch {
      setContinuing(false);
      setError("Relay could not bind this authorization to the workspace. Nothing was authorized.");
    }
  }

  return (
    <OAuthLayout>
      <section className="oauth-panel" aria-labelledby="oauth-workspace-title">
        <div className="oauth-panel__heading">
          <p className="mono-label">Workspace authorization</p>
          <h1 id="oauth-workspace-title">Choose where this MCP client can act</h1>
          <p>Relay scopes every tool call, run, and artifact to the selected workspace.</p>
        </div>

        {loading ? <Skeleton label="Loading eligible workspaces" lines={3} /> : null}
        {error ? (
          <InlineNotice
            title="Workspace selection unavailable"
            tone="error"
            action={
              <Button variant="outline" onClick={() => setReloadVersion((value) => value + 1)}>
                Retry workspace list
              </Button>
            }
          >
            <p>{error}</p>
          </InlineNotice>
        ) : null}

        {!loading && !error && workspaces.length === 0 ? (
          <InlineNotice
            title="No eligible workspace"
            tone="error"
            action={<Button variant="outline" onClick={() => void refreshSession()}>Check session</Button>}
          >
            <p>Relay did not find a workspace for this account. Authorization was not changed.</p>
          </InlineNotice>
        ) : null}

        {!loading && workspaces.length > 0 ? (
          <>
            <fieldset className="workspace-options" disabled={continuing}>
              <legend>Eligible workspaces</legend>
              {workspaces.map((item) => (
                <RadioCard
                  key={item.id}
                  id={`workspace-${item.id}`}
                  name="workspace"
                  value={item.id}
                  title={item.name}
                  metadata={`@${item.slug}${item.id === activeWorkspaceId ? " / active" : ""}`}
                  checked={selectedId === item.id}
                  onChange={() => setSelectedId(item.id)}
                />
              ))}
            </fieldset>
            {workspace.status === "degraded" ? (
              <InlineNotice title="Current workspace details are degraded" tone="warning">
                <p>The eligible list loaded, but Relay could not refresh the active workspace label.</p>
              </InlineNotice>
            ) : null}
            <div className="oauth-panel__actions">
              <Button
                pending={continuing}
                pendingLabel="Binding workspace"
                disabled={!selectedWorkspace}
                onClick={() => void continueAuthorization()}
              >
                Continue with workspace
              </Button>
              <LinkButton to="/dashboard" variant="outline">Cancel</LinkButton>
            </div>
            <p className="oauth-panel__escape">This connection stays bound to the workspace you choose. <Link to="/dashboard/settings#workspaces">Manage your workspaces</Link>.</p>
          </>
        ) : null}
      </section>
    </OAuthLayout>
  );
}
