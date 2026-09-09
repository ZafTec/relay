import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { usePageMetadata } from "../../app/usePageMetadata";
import { RelayBrand } from "../../components/brand/RelayBrand";
import { LinkButton } from "../../components/ui/Button";
import "./docs.css";

const quickstartSteps = [
  {
    id: "discover-tool",
    number: "01",
    title: "Discover a published tool",
    copy: "List the authorized catalog, then inspect the active version, input schema, output schema, execution mode, and maximum duration before invoking it.",
  },
  {
    id: "create-run",
    number: "02",
    title: "Create a run",
    copy: "POST a tool key and schema-valid input with an idempotency key. Relay returns an accepted run or a typed capacity, availability, or idempotency result.",
  },
  {
    id: "track-run",
    number: "03",
    title: "Track durable state",
    copy: "Read the run resource and connect to the workspace event stream. A run records accepted, started, and terminal state without exposing internal queue jobs as customer resources.",
  },
  {
    id: "use-artifacts",
    number: "04",
    title: "Use the artifacts",
    copy: "Inspect output items and artifact versions, request managed delivery, or create a governed share link. Provider URLs are not durable results.",
  },
] as const;

const httpContracts = [
  { method: "GET", path: "/api/v1/tools", description: "List published tools visible to the active workspace." },
  { method: "GET", path: "/api/v1/tools/:toolKey", description: "Read the active version and schemas for one tool." },
  { method: "POST", path: "/api/v1/runs", description: "Create an idempotent run for a published tool." },
  { method: "GET", path: "/api/v1/runs", description: "List runs in the active workspace." },
  { method: "GET", path: "/api/v1/runs/:runId", description: "Read one workspace-owned run." },
  { method: "POST", path: "/api/v1/runs/:runId/cancel", description: "Cancel or request cancellation for a run." },
  { method: "GET", path: "/api/v1/artifacts", description: "List workspace artifacts." },
  { method: "GET", path: "/api/v1/artifacts/:artifactId", description: "Read artifact versions and active share records." },
  { method: "POST", path: "/api/v1/artifacts/:artifactId/download", description: "Create a managed artifact download authorization." },
  { method: "POST", path: "/api/v1/artifacts/uploads", description: "Create a direct object-storage upload authorization." },
  { method: "POST", path: "/api/v1/artifacts/uploads/:uploadId/complete", description: "Verify and complete a direct upload." },
  { method: "POST", path: "/api/v1/artifacts/:artifactId/share-links", description: "Create a governed public share link." },
  { method: "DELETE", path: "/api/v1/artifacts/:artifactId/share-links/:shareLinkId", description: "Revoke an artifact share link." },
  { method: "GET", path: "/api/v1/usage", description: "Read bounded consumed and reserved usage summaries." },
  { method: "GET", path: "/api/v1/events", description: "Stream workspace events with resumable SSE." },
  { method: "GET", path: "/api/v1/changelog", description: "List reviewed, published release notes." },
  { method: "GET", path: "/api/v1/changelog/:slug", description: "Read one published release note." },
  { method: "GET", path: "/s/:token", description: "Resolve an active managed share token." },
] as const;

const mcpContracts = [
  { name: "relay.tools.list", scope: "tools:read", description: "List published tools." },
  { name: "relay.tools.get", scope: "tools:read", description: "Read one tool contract." },
  { name: "relay.runs.list", scope: "runs:read", description: "List workspace runs." },
  { name: "relay.runs.get", scope: "runs:read", description: "Read one run." },
  { name: "relay.runs.cancel", scope: "runs:cancel", description: "Cancel or request cancellation." },
  { name: "relay.artifacts.list", scope: "artifacts:read", description: "List workspace artifacts." },
  { name: "relay.artifacts.get", scope: "artifacts:read", description: "Read artifact versions and shares." },
  { name: "relay.artifacts.create_upload", scope: "artifacts:write", description: "Create a direct upload authorization." },
  { name: "relay.artifacts.create_share_link", scope: "artifacts:share", description: "Create an artifact share link." },
  { name: "relay.artifacts.revoke_share_link", scope: "artifacts:share", description: "Revoke an artifact share link." },
] as const;

const searchEntries = [
  ...httpContracts.map((entry) => ({
    href: "#http-contracts",
    label: `${entry.method} ${entry.path}`,
    description: entry.description,
    keywords: `${entry.method} ${entry.path} ${entry.description}`,
  })),
  ...mcpContracts.map((entry) => ({
    href: "#mcp-contracts",
    label: entry.name,
    description: `${entry.scope}. ${entry.description}`,
    keywords: `${entry.name} ${entry.scope} ${entry.description}`,
  })),
  {
    href: "#service-endpoints",
    label: "GET /health/ready",
    description: "Current API readiness and dependency checks.",
    keywords: "GET /health/ready readiness health dependencies",
  },
  {
    href: "#service-endpoints",
    label: "GET /version",
    description: "Running version and source revision.",
    keywords: "GET /version build revision version",
  },
] as const;

function DocsHeader() {
  return (
    <header className="docs-header">
      <div className="docs-header__inner">
        <RelayBrand />
        <nav className="docs-header__nav" aria-label="Primary">
          <Link className="docs-header__link" to="/changelog">Changelog</Link>
          <Link className="docs-header__link" to="/docs" aria-current="page">Docs</Link>
          <LinkButton className="docs-header__dashboard" to="/dashboard">Open dashboard</LinkButton>
        </nav>
      </div>
    </header>
  );
}

function DocsSectionNavigation() {
  return (
    <aside className="docs-sidebar">
      <nav aria-label="Documentation">
        <div className="docs-sidebar__group">
          <p>Start here</p>
          <a href="#quickstart">Quickstart</a>
          <a href="#workflow">Tool workflow</a>
          <a href="#search-contracts">Search</a>
        </div>
        <div className="docs-sidebar__group">
          <p>Reference</p>
          <a href="#http-contracts">HTTP API</a>
          <a href="#mcp-contracts">MCP tools</a>
          <a href="#service-endpoints">Service endpoints</a>
        </div>
      </nav>
    </aside>
  );
}

function DocsSearch() {
  const [query, setQuery] = useState("");
  const results = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return searchEntries.filter((entry) => entry.keywords.toLocaleLowerCase().includes(normalized));
  }, [query]);
  const hasQuery = query.trim().length > 0;

  return (
    <section className="docs-search" id="search-contracts" aria-labelledby="docs-search-title">
      <div className="docs-section-heading">
        <p>Contract search</p>
        <h2 id="docs-search-title">Find an implemented contract</h2>
      </div>
      <form role="search" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="docs-search-input">Search HTTP paths and MCP tool names</label>
        <input
          id="docs-search-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Try runs, artifacts, or tools:read"
          aria-describedby="docs-search-help"
        />
        <p id="docs-search-help">Searches the implemented HTTP and MCP adapter contracts on this page.</p>
      </form>
      <div className="docs-search__results" aria-live="polite" aria-atomic="true">
        {!hasQuery ? <p>Enter a resource, path, tool name, or OAuth scope.</p> : null}
        {hasQuery && results.length === 0 ? <p>No implemented contracts match this search.</p> : null}
        {results.length > 0 ? (
          <ul>
            {results.map((entry) => (
              <li key={entry.label}>
                <a href={entry.href}><code>{entry.label}</code></a>
                <span>{entry.description}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function HttpContractTable() {
  return (
    <div className="docs-table-scroll" tabIndex={0} role="region" aria-label="HTTP API routes table">
      <table className="docs-contract-table">
        <caption>Workspace and public HTTP routes</caption>
        <thead>
          <tr>
            <th scope="col">Method</th>
            <th scope="col">Path</th>
            <th scope="col">Purpose</th>
          </tr>
        </thead>
        <tbody>
          {httpContracts.map((entry) => (
            <tr key={`${entry.method}-${entry.path}`}>
              <td><code>{entry.method}</code></td>
              <td><code>{entry.path}</code></td>
              <td>{entry.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function McpContractTable() {
  return (
    <div className="docs-table-scroll" tabIndex={0} role="region" aria-label="MCP management tools table">
      <table className="docs-contract-table">
        <caption>Stable MCP management tool names</caption>
        <thead>
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">Required scope</th>
            <th scope="col">Purpose</th>
          </tr>
        </thead>
        <tbody>
          {mcpContracts.map((entry) => (
            <tr key={entry.name}>
              <td><code>{entry.name}</code></td>
              <td><code>{entry.scope}</code></td>
              <td>{entry.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocsPage() {
  usePageMetadata("Quickstart | Relay Docs", "#F5F4ED");

  return (
    <div className="docs-page public-surface">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <DocsHeader />

      <div className="docs-shell">
        <DocsSectionNavigation />

        <main id="main-content" className="docs-main">
          <article>
            <header className="docs-intro" id="quickstart">
              <nav className="docs-breadcrumb" aria-label="Breadcrumb">
                <Link to="/">Relay</Link>
                <span aria-hidden="true">/</span>
                <span aria-current="page">Docs</span>
              </nav>
              <h1>Quickstart</h1>
              <p className="docs-intro__lead">
                Discover a tool, create a run, follow durable state, and use the resulting artifacts through Relay's implemented HTTP or MCP contracts.
              </p>
              <ul className="docs-intro__facts" aria-label="Quickstart characteristics">
                <li>Workspace scoped</li>
                <li>Idempotent runs</li>
                <li>Durable artifacts</li>
              </ul>
            </header>

            <section className="docs-workflow" id="workflow" aria-labelledby="workflow-title">
              <div className="docs-section-heading">
                <p>Four-step workflow</p>
                <h2 id="workflow-title">From catalog to managed result</h2>
              </div>
              <ol className="docs-steps">
                {quickstartSteps.map((step) => (
                  <li key={step.id}>
                    <section id={step.id} aria-labelledby={`${step.id}-title`}>
                      <span className="docs-step__number" aria-hidden="true">{step.number}</span>
                      <div>
                        <h3 id={`${step.id}-title`}>{step.title}</h3>
                        <p>{step.copy}</p>
                      </div>
                    </section>
                  </li>
                ))}
              </ol>
            </section>

            <aside className="docs-contract-note" aria-labelledby="contract-note-title">
              <div>
                <h2 id="contract-note-title">Implemented transport contracts</h2>
                <p>
                  These names are defined by Relay's shared contracts and mounted HTTP or MCP adapters. Authenticated resources require a current session, active workspace membership, and a runtime configured with application services.
                </p>
              </div>
            </aside>

            <DocsSearch />

            <section className="docs-reference" id="http-contracts" aria-labelledby="http-contracts-title">
              <div className="docs-section-heading">
                <p>HTTP API</p>
                <h2 id="http-contracts-title">Canonical resource paths</h2>
              </div>
              <p className="docs-reference__lead">
                Workspace routes use the public noun <strong>run</strong>. Mutating requests enforce their documented idempotency and authorization requirements.
              </p>
              <HttpContractTable />
            </section>

            <section className="docs-reference" id="mcp-contracts" aria-labelledby="mcp-contracts-title">
              <div className="docs-section-heading">
                <p>MCP</p>
                <h2 id="mcp-contracts-title">OAuth-protected management tools</h2>
              </div>
              <p className="docs-reference__lead">
                Relay's MCP adapter uses Streamable HTTP at <code>/mcp</code> when application services are configured. Published catalog tools are registered dynamically and require <code>tools:execute</code>; the management names below are stable.
              </p>
              <McpContractTable />
            </section>

            <section className="docs-reference" id="service-endpoints" aria-labelledby="service-endpoints-title">
              <div className="docs-section-heading">
                <p>Service metadata</p>
                <h2 id="service-endpoints-title">Deployment identity and readiness</h2>
              </div>
              <dl className="docs-endpoints">
                <div>
                  <dt><code>GET /health/ready</code></dt>
                  <dd>Current API readiness and reported dependency checks.</dd>
                </div>
                <div>
                  <dt><code>GET /version</code></dt>
                  <dd>Version and source revision for the running build.</dd>
                </div>
              </dl>
            </section>
          </article>
        </main>

        <aside className="docs-on-page" aria-label="Page contents">
          <nav aria-label="On this page">
            <p>On this page</p>
            {quickstartSteps.map((step) => (
              <a key={step.id} href={`#${step.id}`}>{step.title}</a>
            ))}
            <a href="#search-contracts">Search contracts</a>
            <a href="#http-contracts">HTTP API</a>
            <a href="#mcp-contracts">MCP tools</a>
          </nav>
        </aside>
      </div>

      <footer className="docs-footer">
        <p>Relay documentation distinguishes adapter contracts from deployed availability.</p>
      </footer>
    </div>
  );
}
