# HTTP, MCP, OAuth resource protection, and live events

Phase: Wave 4\
Primary owners: interface-contract owner, then HTTP/SSE and MCP worktrees\
Depends on: auth, domain services, queue/capacity, artifacts, metering

## Objective

Expose one application service layer through a versioned HTTP API, authenticated
MCP v2 endpoint, and workspace-scoped dashboard SSE without duplicating business
rules.

## Shared interface rules

HTTP, MCP, and dashboard actions use the same:

- Session/token identity
- Workspace membership authorization
- Tool/version resolution
- Idempotency
- Entitlement and reservation checks
- Queue admission/capacity decisions
- Structured errors
- Audit and telemetry context
- Run/artifact/share identities

No transport can bypass metering or use client-supplied workspace IDs as proof.

## Contract ownership

One worktree owns:

```text
packages/contracts/
  public IDs and enums
  input/output schemas
  error codes
  pagination
  idempotency
  event envelopes
```

HTTP, MCP, and web agents consume those contracts. They do not each define a
slightly different run or artifact type.

## HTTP resources

Proposed initial routes:

```text
GET  /api/v1/tools
GET  /api/v1/tools/:toolKey
POST /api/v1/tools/:toolKey/estimate
POST /api/v1/tool-runs
GET  /api/v1/tool-runs
GET  /api/v1/tool-runs/:runId
POST /api/v1/tool-runs/:runId/cancel

GET  /api/v1/artifacts
GET  /api/v1/artifacts/:artifactId
GET  /api/v1/artifacts/:artifactId/versions
POST /api/v1/artifacts/uploads
POST /api/v1/artifacts/uploads/:uploadId/complete

POST   /api/v1/share-links
DELETE /api/v1/share-links/:shareLinkId

GET /api/v1/usage
GET /api/v1/events
```

The v3 canvases use shorter `/api/v1/runs` and artifact-specific share paths.
Before implementation, the contract owner records one route decision and updates
API examples/fixtures. Do not support both merely to hide inconsistency.

## HTTP behavior

- JSON request size is bounded.
- File bytes use direct S3 upload, never normal API/MCP bodies.
- Cursor pagination has stable deterministic ordering.
- Filtering fields are allow-listed.
- Mutations accept `Idempotency-Key`.
- A matching replay returns the original result/run.
- Same key with a different canonical payload returns conflict.
- Asynchronous invocation returns `202`, run identity, current status, queue
  reason, and reservation summary.
- Resource not found and unauthorized ownership avoid leaking cross-workspace
  existence.
- Cancellation is a request and may resolve in a completion race.
- Download/share resolution generates fresh delivery authorization.

## Error envelope

Example:

```json
{
  "error": {
    "code": "tool_queue_full",
    "message": "The tool queue is temporarily at capacity.",
    "retryable": true,
    "retryAfterSeconds": 60,
    "requestId": "req_...",
    "details": {}
  }
}
```

Public messages are sanitized. Details are schema-controlled and never contain
provider payloads, SQL, prompts, credentials, signed URLs, or stack traces.

Categorize errors:

```text
validation/authentication/authorization      4xx
entitlement/quota                            403 or domain-specific 4xx
duplicate idempotency payload                409
client/API rate limit                        429
bounded tool capacity rejection              429
coordination/dependency unavailable           503
unexpected internal                          500
```

Normal accepted queue waiting is not an error.

## Dashboard SSE

SSE is distinct from MCP Streamable HTTP.

Flow:

1. Browser fetches durable current state.
2. Browser opens one authenticated workspace-scoped `/api/v1/events` stream.
3. Server sends compact invalidation/update events.
4. Browser refetches affected resources when needed.
5. Reconnect reloads durable state before trusting new events.

Events include monotonic IDs when replay is supported:

```text
run.created
run.status_changed
run.progress_changed
run.completed
artifact.created
share_link.changed
usage.changed
tool.availability_changed
session.permission_changed
```

Redis Pub/Sub is low-latency fan-out, not durable history. Important events come
from the PostgreSQL outbox. Missing a Pub/Sub event remains recoverable.

Nginx must disable proxy buffering/cache/gzip for SSE and use a long read
timeout. Send heartbeats more frequently than proxy timeout.

The UI exposes `connected`, `reconnecting`, `stale`, `offline`,
`resynchronized`, and `permission_changed` states without announcing every
progress tick to assistive technology.

## MCP SDK

Use the official v2 split packages selected in the Wave 0 spike:

```text
@modelcontextprotocol/server
@modelcontextprotocol/client     tests only
@modelcontextprotocol/hono       optional thin middleware
zod v4 or another Standard Schema implementation
```

Do not add new code using the v1 `@modelcontextprotocol/sdk` package.

Pin one MCP protocol version and implement its exact transport semantics. The
2026-07-28 v2 SDK differs from the older 2025 Streamable HTTP session model, so
old GET/DELETE/session-header examples must not be copied blindly.

Mount at:

```text
POST /mcp
```

Add only the methods required by the pinned current protocol and SDK. Validate
Host and any present Origin before body processing. Native non-browser clients
may omit Origin; a present unapproved Origin is rejected.

Set a small request-body limit because artifacts are references, not embedded
file payloads.

## MCP tools

Management tools remain stable and typed, for example:

```text
relay.tools.list
relay.tools.get
relay.runs.get
relay.runs.list
relay.runs.cancel
relay.artifacts.get
relay.artifacts.list
relay.artifacts.create_upload
relay.artifacts.create_share_link
relay.artifacts.revoke_share_link
```

Executable published catalog tools are exposed with their actual typed schemas.
A generic raw-JSON executor is not the only image-generation interface.

Exact names remain a contract decision. v3 fixture names such as
`relay.run_tool` are not automatically authoritative.

Asynchronous execution returns structured data:

```json
{
  "runId": "run_...",
  "status": "queued",
  "queueReason": "global_tool_rate",
  "reservation": {
    "metric": "images.generated",
    "amount": 2
  }
}
```

Status tools return output-set/artifact IDs and freshly authorized managed URLs
when complete.

## OAuth resource protection

Use Better Auth's direct OAuth 2.1 Provider composition as approved. Do not add
the historical deprecated MCP plugin. If the implementation agent wants the
newer Better Auth MCP convenience package, that is an ADR requiring confirmation
that it preserves every direct provider/resource-server requirement.

Resource:

```text
https://relay.zaftech.co/mcp
```

Initial scopes:

```text
openid
profile
email
offline_access
tools:read
tools:execute
runs:read
runs:cancel
artifacts:read
artifacts:write
artifacts:share
usage:read
```

`offline_access` is authorization-server behavior, not a required resource
scope.

Every MCP request validates:

- Signature/JWKS
- Issuer
- Exact audience/resource
- Expiry and not-before
- Required scopes
- DPoP when token-bound
- Current client status
- Current workspace membership
- Resource ownership
- Tool availability and entitlement

Cookie-only Better Auth sessions do not authenticate `/mcp`.

Expose RFC 8414 authorization metadata and RFC 9728 protected-resource metadata,
including the path-aware metadata location for a resource ending in `/mcp`.
Unauthenticated responses include the correct `WWW-Authenticate` challenge.

## Client registration

Prefer:

1. Operator pre-registration initially.
2. CIMD after a Deno-safe SSRF-resistant transport is proven.
3. Do not open unauthenticated Dynamic Client Registration merely for
   convenience.

A secure CIMD transport must pin DNS resolution, reject special-use addresses,
preserve TLS SNI/certificate validation, refuse redirects, and enforce strict
size/time/concurrency limits. A resolve/check/global-fetch sequence is
vulnerable to DNS rebinding.

## Trace propagation

HTTP uses W3C `traceparent` internally, but public proxy policy should not let
an untrusted caller force arbitrary trace identity/sampling without review.

Queue tickets carry only adapter-generated `traceparent`/`tracestate`. Do not
persist baggage, user prompts, or arbitrary client metadata in Redis.

## Expected tests

### HTTP

- Schema validation and canonical error envelopes
- Stable cursor pagination under concurrent inserts
- Idempotent replay and different-payload conflict
- Workspace non-disclosure/isolation
- Queue accepted versus bounded rejection behavior
- Cancellation races
- Upload request size versus direct-upload enforcement
- Share/download authorization and no durable raw storage URL

### SSE

- Authenticated workspace scoping
- One workspace cannot subscribe to another
- Initial durable fetch plus update
- Disconnect/reconnect/resync
- Redis Pub/Sub event loss recovery
- Last-event behavior if replay is implemented
- Permission removal closes or invalidates stream
- Nginx first-event latency proves no buffering
- Heartbeat survives configured proxy timeout

### MCP

- Official SDK v2 client discovery/list/call
- Official conformance suite for pinned protocol
- Invalid Host/Origin rejected
- Oversized request rejected before parsing
- Cookie-only/missing/wrong issuer/audience/expired token rejected
- Missing scope returns correct challenge
- Valid token plus removed workspace membership denied
- No sticky session requirement across API replicas unless the selected protocol
  requires state
- Request-scoped SSE/cancellation follows pinned protocol
- Typed image-tool and management-tool schemas
- Structured run/artifact result
- No prompt/token/URL leakage in errors or telemetry

### OAuth metadata

- Authorization and protected-resource discovery routes
- Exact resource identifier
- PKCE S256
- Redirect URI matching
- Workspace selection before consent
- Consent tied to selected workspace
- Refresh/expiry/revocation behavior
- DPoP proxy/replay test if enabled
- CIMD SSRF suite before enabling CIMD

## Completion gate

This phase completes when HTTP and MCP prove identical authorization/metering
semantics, the pinned MCP conformance suite passes, SSE loss is recoverable from
durable state, and reverse-proxy behavior is tested rather than assumed.
