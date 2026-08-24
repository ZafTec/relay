import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { useAuth } from "../../auth/AuthProvider";
import { Button, LinkButton } from "../../components/ui/Button";
import { InlineNotice } from "../../components/ui/InlineNotice";
import { Skeleton } from "../../components/ui/Skeleton";
import { StatusBadge } from "../../components/ui/StatusBadge";
import {
  httpToolDetailAdapter,
  type ToolDetail,
  type ToolDetailAdapter,
  type ToolDetailLoadResult,
  type ToolLifecycle,
} from "../../lib/api/tools";
import "./tools.css";

type DetailPageState =
  | Exclude<ToolDetailLoadResult, { readonly kind: "auth-expired" }>
  | { readonly kind: "loading" };

export interface ToolDetailPageProps {
  readonly toolAdapter?: ToolDetailAdapter;
  readonly toolKey?: string;
}

function isAbortError(error: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && error instanceof DOMException &&
      error.name === "AbortError") ||
    (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError"
    )
  );
}

function lifecycleBadge(lifecycle: ToolLifecycle) {
  return lifecycle === "published"
    ? <StatusBadge tone="ready">Published</StatusBadge>
    : <StatusBadge tone="warning">Deprecated</StatusBadge>;
}

function pageHeading(state: DetailPageState, toolKey: string): string {
  if (state.kind === "found") return state.tool.key;
  if (state.kind === "not-found") return "Tool not found";
  if (state.kind === "degraded") return "Tool contract unavailable";
  return toolKey.length > 0 ? toolKey : "Tool contract";
}

function schemaText(schema: ToolDetail["inputSchema"]): string {
  return JSON.stringify(schema, null, 2);
}

function ToolContract({ tool }: { readonly tool: ToolDetail }) {
  return (
    <>
      <section
        className="tool-execution-state"
        aria-labelledby="tool-execution-title"
      >
        <div>
          <h2 id="tool-execution-title">Execution unavailable</h2>
          <p>
            Execution is unavailable until a real provider and meter policy are
            configured.
          </p>
        </div>
        <StatusBadge tone="pending">Read only</StatusBadge>
      </section>

      <section
        className="tool-contract-section"
        aria-labelledby="tool-facts-title"
      >
        <div className="tool-contract-section__heading">
          <h2 id="tool-facts-title">Contract facts</h2>
          <p>Published fields returned by the active tool contract.</p>
        </div>
        <dl className="tool-facts">
          <div>
            <dt>Name</dt>
            <dd>{tool.name}</dd>
          </div>
          <div>
            <dt>Category</dt>
            <dd>{tool.category ?? "Not categorized"}</dd>
          </div>
          <div>
            <dt>Lifecycle</dt>
            <dd>{tool.lifecycle}</dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>
              <code>v{tool.version}</code>
            </dd>
          </div>
          <div>
            <dt>Execution mode</dt>
            <dd>
              <code>{tool.executionMode}</code>
            </dd>
          </div>
          <div>
            <dt>Maximum duration</dt>
            <dd>
              <code>{tool.maxDurationSeconds} seconds</code>
            </dd>
          </div>
          <div>
            <dt>Tool ID</dt>
            <dd>
              <code>{tool.id}</code>
            </dd>
          </div>
          <div>
            <dt>Active version ID</dt>
            <dd>
              <code>{tool.activeVersionId}</code>
            </dd>
          </div>
        </dl>
      </section>

      <div className="tool-schema-ledger">
        <section
          className="tool-schema"
          aria-labelledby="tool-input-schema-title"
        >
          <header>
            <h2 id="tool-input-schema-title">Input schema</h2>
            <span>JSON</span>
          </header>
          <pre tabIndex={0} aria-label={`Input schema for ${tool.key}`}>
            <code>{schemaText(tool.inputSchema)}</code>
          </pre>
        </section>
        <section
          className="tool-schema"
          aria-labelledby="tool-output-schema-title"
        >
          <header>
            <h2 id="tool-output-schema-title">Output schema</h2>
            <span>JSON</span>
          </header>
          <pre tabIndex={0} aria-label={`Output schema for ${tool.key}`}>
            <code>{schemaText(tool.outputSchema)}</code>
          </pre>
        </section>
      </div>
    </>
  );
}

export function ToolDetailPage({
  toolAdapter = httpToolDetailAdapter,
  toolKey,
}: ToolDetailPageProps) {
  const params = useParams<{ toolKey: string }>();
  const resolvedToolKey = toolKey ?? params.toolKey ?? "";
  const { expireSession, session } = useAuth();
  const sessionId = session.status === "authenticated" ? session.identity.session.id : undefined;
  const [state, setState] = useState<DetailPageState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const heading = pageHeading(state, resolvedToolKey);
  const title = state.kind === "found"
    ? `${state.tool.key} | Relay`
    : "Tool contract | Relay";
  usePageMetadata(title, "#141A16");

  useEffect(() => {
    if (resolvedToolKey.length === 0) {
      setState({ kind: "not-found" });
      return;
    }

    const controller = new AbortController();
    let active = true;
    setState({ kind: "loading" });

    void toolAdapter.get(resolvedToolKey, controller.signal).then((result) => {
      if (result.kind === "auth-expired") {
        expireSession(sessionId);
        return;
      }
      if (!active) return;
      setState(result);
    }).catch((error: unknown) => {
      if (!active || isAbortError(error)) return;
      setState({
        kind: "degraded",
        message:
          "Relay could not load the tool contract. No contract data was shown.",
      });
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [expireSession, reloadKey, resolvedToolKey, sessionId, toolAdapter]);

  return (
    <div className="tool-detail-page">
      <header className="tool-detail-header">
        <nav className="tool-breadcrumb" aria-label="Breadcrumb">
          <Link to="/dashboard/tools">Tools</Link>
          <span aria-hidden="true">/</span>
          <span aria-current="page">{resolvedToolKey || "Tool"}</span>
        </nav>
        <div className="tool-detail-header__title">
          <div>
            <h1>{heading}</h1>
            {state.kind === "found"
              ? <p className="tool-detail-header__name">{state.tool.name}</p>
              : null}
          </div>
          {state.kind === "found" ? lifecycleBadge(state.tool.lifecycle) : null}
        </div>
        {state.kind === "found"
          ? (
            <p className="tool-detail-header__summary">
              {state.tool.summary ?? "No summary is published for this tool."}
            </p>
          )
          : null}
      </header>

      <div
        className={`tool-detail-body tool-detail-body--${state.kind}`}
        aria-busy={state.kind === "loading" || undefined}
      >
        {state.kind === "loading"
          ? (
            <Skeleton
              label={`Loading contract for ${resolvedToolKey || "tool"}`}
              lines={6}
            />
          )
          : null}

        {state.kind === "not-found"
          ? (
            <div className="tool-detail-state">
              <InlineNotice title="No matching tool contract">
                <p>
                  Relay could not find{" "}
                  <code>{resolvedToolKey || "the requested tool"}</code>{" "}
                  in the active workspace catalog.
                </p>
              </InlineNotice>
              <LinkButton variant="outline" to="/dashboard/tools">
                Back to tools
              </LinkButton>
            </div>
          )
          : null}

        {state.kind === "degraded"
          ? (
            <div className="tool-detail-state">
              <InlineNotice
                title="Tool contract unavailable"
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
              <LinkButton variant="quiet" to="/dashboard/tools">
                Back to tools
              </LinkButton>
            </div>
          )
          : null}

        {state.kind === "found" ? <ToolContract tool={state.tool} /> : null}
      </div>
    </div>
  );
}
