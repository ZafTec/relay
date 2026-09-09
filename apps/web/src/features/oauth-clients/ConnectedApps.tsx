import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";
import { Button } from "../../components/ui/Button";
import { Disclosure } from "../../components/ui/Disclosure";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { ApiError, fetchJson } from "../../lib/api/client";
import { describeScope } from "../../auth/oauth-request";

interface Connection {
  id: string;
  clientId: string;
  name: string;
  workspaceId: string;
  workspaceName: string;
  scopes: string[];
  connectedAt: string;
}
export function ConnectedApps() {
  const { session, expireSession } = useAuth();
  const sessionId = session.status === "authenticated"
    ? session.identity.session.id
    : undefined;
  const [items, setItems] = useState<Connection[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void fetchJson<{ items: Connection[] }>("/api/v1/workspaces/connections", {
      signal: controller.signal,
      cache: "no-store",
    }).then((result) => {
      if (
        !Array.isArray(result.items) ||
        result.items.some((item) =>
          typeof item.id !== "string" || typeof item.name !== "string" ||
          typeof item.workspaceName !== "string" ||
          !Array.isArray(item.scopes) || item.scopes.some((scope) =>
            typeof scope !== "string"
          )
        )
      ) throw new TypeError("Invalid connections");
      if (!controller.signal.aborted) setItems(result.items);
    }).catch((error) => {
      if (!controller.signal.aborted) {
        if (error instanceof ApiError && error.status === 401) {
          expireSession(sessionId);
        } else setError(true);
      }
    });
    return () => controller.abort();
  }, [revision, sessionId, expireSession]);
  async function disconnect(id: string) {
    if (busy) return;
    setBusy(true);
    setError(false);
    try {
      await fetchJson(
        "/api/v1/workspaces/connections/" + encodeURIComponent(id),
        { method: "DELETE" },
      );
      setItems((current) => current?.filter((item) => item.id !== id) ?? null);
      setConfirm(null);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="oauth-client-list"
      aria-labelledby="connected-apps-title"
    >
      <div className="oauth-connections-heading">
        <div>
          <h2 id="connected-apps-title">Connected apps</h2>
          <p>
            Apps you’ve authorized, including automatic connections such as
            Claude.
          </p>
        </div>
        <Button
          variant="quiet"
          disabled={busy}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh connections
        </Button>
      </div>
      {error
        ? (
          <InlineNotice title="Connections unavailable" tone="error">
            <p>
              Couldn’t load or update your connections. Please refresh and try
              again.
            </p>
          </InlineNotice>
        )
        : null}
      {!items && !error
        ? <Skeleton label="Loading connected apps" lines={2} />
        : null}
      {items?.length === 0
        ? (
          <p className="oauth-clients-empty">
            No apps connected yet. Add the MCP URL to your agent, then approve
            its connection.
          </p>
        )
        : null}
      {items?.map((item) => (
        <article className="oauth-client-row" key={item.id}>
          <div className="oauth-client-row__identity">
            <h3>{item.name}</h3>
            <p>{item.workspaceName}</p>
          </div>
          <Disclosure
            title="Connection details"
            description="Permissions and disconnect"
          >
            <ul>
              {item.scopes.map((scope) => (
                <li key={scope}>{describeScope(scope).title}</li>
              ))}
            </ul>
            {confirm === item.id
              ? (
                <div role="alert">
                  <p>
                    Disconnect {item.name} from{" "}
                    {item.workspaceName}? You can connect it again from your
                    agent.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() => void disconnect(item.id)}
                  >
                    {busy ? "Disconnecting…" : "Confirm disconnect"}
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={busy}
                    onClick={() => setConfirm(null)}
                  >
                    Cancel
                  </Button>
                </div>
              )
              : (
                <Button
                  variant="quiet"
                  className="oauth-client-delete"
                  disabled={busy}
                  onClick={() => setConfirm(item.id)}
                >
                  Disconnect app
                </Button>
              )}
          </Disclosure>
        </article>
      ))}
    </section>
  );
}
