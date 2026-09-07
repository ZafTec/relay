# ADR 0001: MCP OAuth via Better Auth's `mcp` plugin, not a hand-built provider

Status: accepted\
Date: 2026-08-21\
Owner: repository owner (euaelesh), recorded by implementation agent

## Context

[`06-http-mcp-events.md`](../implementation-handoff/06-http-mcp-events.md) and
[`00-research-decisions.md`](../implementation-handoff/00-research-decisions.md)
originally planned a hand-built Better Auth direct OAuth 2.1 Provider
composition for `/mcp`: custom authorization/token endpoints, custom RFC 9728
protected-resource metadata, and custom per-request bearer/DPoP verification.
Both documents explicitly allowed swapping in Better Auth's newer MCP
convenience package instead, conditioned on an ADR confirming it preserves every
direct provider/resource-server requirement.

The owner selected that swap and pointed to the current Better Auth docs for the
`mcp` plugin, the `agent-auth` plugin, and the Hono integration as the intended
shape of Relay's auth.

## Decision

Use `@better-auth/mcp` (currently `1.7.1`, matching the pinned `better-auth`
version) plus the mandatory `jwt()` plugin as the OAuth 2.1 authorization-server
and resource-server implementation for `/mcp`, instead of a hand-built provider.
The same Better Auth instance serves both:

- Browser/dashboard users: session cookies via `auth.handler` mounted at
  `app.all("/api/auth/*", (c) => auth.handler(c.req.raw))` in Hono, per the
  Better Auth Hono integration doc.
- MCP clients: OAuth 2.1 authorization-code-with-PKCE flow against
  `mcp()`-provided endpoints, short-lived JWT access tokens carrying
  `aud: "https://relay.example.test/mcp"`, verified per request by
  `requireMcpAuth()`.

Concretely:

```ts
export const auth = betterAuth({
  // ...existing Google/GitHub/organization config...
  plugins: [
    jwt(), // stable signing key + /jwks; mandatory for mcp()
    mcp({
      loginPage: "/sign-in",
      consentPage: "/consent",
      resource: "https://relay.example.test/mcp",
    }),
  ],
});

const mcpServerHandler = createMcpHandler(() => new McpServer(/* ... */));

const POST = requireMcpAuth(
  auth,
  (request, accessTokenClaims) => mcpServerHandler.fetch(request),
  { resource: "https://relay.example.test/mcp" },
);
```

Endpoints this replaces the hand-built versions of:

```text
/oauth2/authorize   (was: custom authorize)
/oauth2/token       (was: custom token)
/oauth2/userinfo
/oauth2/register    (automatic MCP registration; see policy update below)
/jwks               (from jwt() plugin)
```

`/.well-known/oauth-protected-resource/mcp` and authorization-server metadata
continue to be required and are still asserted by conformance tests; the plugin
is expected to emit them for the configured `resource`, and this must be
verified against the pinned version during the Wave 0 spike, not assumed.

## Access tokens are still `Authorization: Bearer` — clarifying the "no

## tokens on headers" requirement

The MCP `2026-07-28` Streamable HTTP transport is stateless JSON-RPC over
`POST`; there is no non-header channel to carry per-request credentials, and
every conforming MCP client (including Claude) sends
`Authorization: Bearer <token>` (optionally DPoP-bound). `requireMcpAuth()`
reads that header. This is unchanged by this ADR and is not what the owner's "no
auth tokens on headers" requirement rules out.

What this ADR removes is a **hand-built, manually-issued/managed token**: before
this decision, the implementation would have had to mint, store, rotate, and
validate its own OAuth tokens end-to-end. After this decision, Better Auth's
`mcp`/`jwt` plugins own the entire token lifecycle — issuance, signing key
rotation via JWKS, audience binding, expiry, and DPoP verification — so no
application code ever handles a raw static credential, and no user ever pastes a
manually-generated token into a header. The bearer header itself is standard
OAuth transport, produced and consumed automatically by the OAuth flow.

## Consequences

Compatibility update, 2026-09-07: the endpoint also enables the official SDK's
stateless path for revisions 2025-03-26, 2025-06-18 and 2025-11-25, including
the client's default initialization flow. The 2026-07-28 path remains supported.
Both pass through the same Host/Origin, OAuth, scope and current-membership
checks on every request. MCP session IDs are not issued. Official SDK client
tests cover discovery, tool calls and membership revocation for all four
revisions; a local compiled-runtime check covers native OAuth, consent, PKCE,
client-secret rotation and revocation through the default client flow.

- `06-http-mcp-events.md`'s "OAuth resource protection" and "Client
  registration" sections are superseded by this ADR; the underlying resource
  identifier, scopes, DPoP, and metadata requirements they describe still apply
  and still need conformance tests, but the implementation mechanism is the
  Better Auth plugin, not a hand-built provider.
- `00-research-decisions.md`'s "MCP decisions" section is updated to record this
  package selection instead of leaving it as an open ADR trigger.
- Registration policy update, 2026-09-07: Dynamic Client Registration is enabled
  for automatic MCP connection, with exact safe redirects, S256 PKCE, workspace
  selection and explicit permission consent. Manual client ID/secret setup
  remains available to superadmins. Registration never grants execution or usage
  allowances. Administration scopes are excluded from default access and require
  a current verified superadmin. See [connection guidance](../mcp-and-notifications.md).
- `@better-auth/mcp`'s exact behavior (metadata routes, DPoP handling, error
  shapes) must still be proven against the official MCP conformance suite in
  Wave 0/Wave 4B; adopting the package is not itself a substitute for that
  proof.
- Not decided by this ADR: whether Relay also exposes an Agent Auth protocol
  surface (`@better-auth/agent-auth`) for non-MCP agent clients. Nothing in
  `product-and-roadmap.md` currently calls for it; revisit only if the owner
  asks for agent self-registration/capability-grant flows beyond MCP.

## Alternatives considered

- Hand-built direct OAuth 2.1 Provider (the handoff's original plan): more
  control, much more code to write and prove correct ourselves; rejected in
  favor of the maintained plugin now that the owner has reviewed it.
- Cookie-only MCP auth: rejected — incompatible with the MCP spec and with every
  standard remote MCP client; `06-http-mcp-events.md` already recorded
  "Cookie-only Better Auth sessions do not authenticate `/mcp`," and this ADR
  does not change that.
