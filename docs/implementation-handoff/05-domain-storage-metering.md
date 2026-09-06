# Tool registry, storage, artifacts, and metering

Phase: Wave 3B\
Primary owners: domain contract owner, then catalog/storage/metering worktrees\
Depends on: migrations, workspace authorization, audit service\
Blocks: HTTP/MCP tools, provider execution, product UI

## Objective

Implement Relay's core model:

```text
published tool version
  -> authorized metered run
  -> durable output set
  -> immutable artifact versions
  -> managed delivery/share link
```

No arbitrary code upload is introduced. Tool handlers remain reviewed deployed
code.

## Proposed paths

```text
packages/domain/
  src/tools/
  src/providers/
  src/runs/
  src/artifacts/
  src/shares/
  src/entitlements/
  src/usage/
packages/storage/
packages/providers/
packages/contracts/
packages/database/src/migrations/<reserved-domain-ids>.ts
```

Wave 3.0 defines IDs, the canonical `tool_runs` state machine, capacity pools,
reservation interface, state enums, and reserved migration IDs before parallel
lanes begin. The database owner alone updates the migration manifest and shared
generated types.

## Parallel lanes

After shared contracts/migrations merge:

| Lane              | Owns                                                                      | Must not own                      |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------- |
| Catalog           | Tool/version/provider/model repositories and curation services            | Storage bytes or usage settlement |
| Storage/artifacts | S3 adapter, upload completion, artifact/version/output-set/share services | Provider execution                |
| Metering          | Entitlements, estimates, reservations, usage/provider-cost ledgers        | Billing provider integration      |
| Governance        | Audit hooks and superadmin curation authorization                         | Workspace role implementation     |

Integrate catalog first, artifacts second, metering third, then application
services that cross all three.

## IDs and terminology

Use opaque server-generated IDs with stable prefixes only when prefixes improve
operations:

```text
tool_*
tver_*
run_*
job_*
attempt_*
art_*
aver_*
outset_*
share_*
usage_*
reservation_*
```

IDs are not authorization tokens. Share-link secret tokens are generated and
stored separately as hashes.

## Tool registry schema

Suggested durable areas:

```text
relay.tools
  id
  key unique
  name
  category
  summary
  lifecycle
  active_version_id nullable
  visibility
  created_at
  updated_at

relay.tool_versions
  id
  tool_id
  version
  input_schema jsonb
  output_schema jsonb
  handler_key
  execution_mode
  max_duration_seconds
  meter_policy_id
  entitlement_key
  compatibility metadata
  published_at nullable
  deprecated_at nullable
  retired_at nullable
  immutable_hash

relay.providers
  id
  key unique
  name
  lifecycle
  configuration_reference

relay.provider_models
  id
  provider_id
  key
  display_name
  capability_schema jsonb
  pricing_policy_id
  lifecycle
  region_constraints

relay.tool_provider_bindings
  id
  tool_version_id
  provider_model_id
  capacity_pool_id
  routing_order
  enabled
  routing_policy_id

relay.routing_policies
  id
  revision
  policy jsonb
  effective_at
  immutable_hash

relay.routing_decisions
  id
  tool_run_id unique
  routing_policy_id
  routing_policy_revision
  selected_binding_id
  provider_id
  provider_model_id
  requested_model_version nullable
  fallback_used
  fallback_reason nullable
  selected_at
```

Published tool versions are immutable. Updating schema, handler, meter, or
provider semantics creates a new version.

Lifecycle:

```text
draft -> internal -> published -> deprecated -> retired
                    \-> disabled <-/
```

Every publish/disable/deprecate/retire/routing change is system-superadmin only
and audited. Tool schema semantics remain immutable, while operational routing
may change only through a versioned routing policy. Every run references an
immutable routing-decision record containing policy ID/revision, selected
binding, requested provider/model, fallback outcome/reason, and selection
timestamp. The decision owns the one-to-one relationship through unique
`tool_run_id`; the run does not store a redundant reverse ID. Attempts reference
the decision and record the actual provider model version observed at execution,
so history never depends on mutable binding rows.

Provider and model names in v3 (`Halide XL`, `Aurora Fast`) remain fixtures
until the owner selects real integrations.

## Handler registry

Code registers handlers by stable key:

```ts
interface ToolHandler<I, O> {
  key: string;
  inputSchemaVersion: number;
  validate(input: unknown): I;
  prepare(context: RestrictedToolContext, input: I): Promise<PreparedOperation>;
  normalize(result: ProviderResult): Promise<O>;
}
```

Database `handler_key` selects only a handler that exists in the deployed
registry. Unknown handlers make the tool version unavailable; database content
never becomes executable code. Handlers receive capability-limited orchestration
APIs and cannot bypass admission, reservation, capacity permits, retry
classification, artifact ingestion, or settlement.

A startup validation reports:

- Published versions with missing handlers
- Handler/schema-version mismatch
- Enabled bindings with missing provider adapters
- Invalid meter or entitlement references

Do not fail the entire API for one disabled/misconfigured draft tool. Published
misconfiguration affects readiness only when policy marks it critical.

## Provider abstraction

Image provider boundary:

```text
capabilities
estimate
submit
inspect
retrieve
cancel
normalizeError
normalizeUsage
```

Provider responses are normalized before reaching domain services. Persist
provider operation ID, actual model version, safety outcome, normalized usage,
and protected provenance. Do not persist provider URLs as durable results.

Explicit provider/model selection is honored unless an approved visible routing
policy permits substitution. Any fallback is recorded in estimate, run, receipt,
and audit evidence.

## Artifact model

```text
relay.artifacts
  id
  workspace_id
  name
  media_kind
  current_version_id nullable
  source_run_id nullable
  created_by
  retention_policy_id nullable
  deleted_at nullable
  created_at

relay.artifact_versions
  id
  artifact_id
  sequence
  object_key unique
  storage_version_id nullable
  sha256
  etag nullable
  size_bytes
  mime_type
  width nullable
  height nullable
  duration_ms nullable
  source
  source_run_id nullable
  parent_version_id nullable
  metadata jsonb
  verification_status
  created_at

relay.output_sets
  id
  run_id unique
  requested_count
  produced_count
  completeness
  warnings jsonb

relay.output_items
  id
  output_set_id
  name
  ordinal
  status
  artifact_version_id nullable
  error_code nullable
```

Rules:

- Immutable object key per artifact version
- Unique `(artifact_id, sequence)`
- Optimistic current-version update
- Generated output normally creates a new artifact at sequence one
- Multi-output siblings remain distinct artifacts in one output set
- Partial failure preserves successful siblings
- MIME, filename, dimensions, and provider metadata are untrusted until verified
- Soft delete precedes asynchronous purge
- Restore creates a new head version rather than rewriting history

## S3 adapter

Domain interface:

```text
createUploadUrl
completeUpload or headObject
createDownloadUrl
putObject
getObjectStream
headObject
deleteObject
```

Configuration supports internal and public signing endpoints separately. Host,
path, and signed headers must not be rewritten after signature generation.

Provider behavior:

```text
MinIO             force path style
Cloudflare R2     region auto, virtual host where configured
AWS S3            actual region, virtual host
```

Use explicit credentials; do not allow the generic AWS credential chain to read
home directories, execute credential processes, or probe metadata endpoints in
the compiled container unless separately approved.

### Direct upload

1. Reserve storage/quota and create a pending upload plus artifact/version and
   immutable key transactionally.
2. Set a short pending-upload expiry.
3. Return short-lived signed PUT URL plus exact required headers.
4. Browser/client uploads directly.
5. Completion is idempotent and performs `HEAD`.
6. Verify expected key, size, content type, upload ID, and portable checksum.
7. Mark available and compare-and-swap current version.
8. On mismatch, mark failed and enqueue deletion.
9. A sweeper expires abandoned uploads, releases quota, and reconciles orphaned
   objects.

Use `Content-MD5` as a portable single-part transfer check when supported, and
store SHA-256 as Relay provenance. Do not assume ETag equals MD5. A worker may
stream and verify SHA-256 before marking cryptographically verified.

Use signed `If-None-Match: *` where the selected provider proves support. Random
immutable keys remain the primary overwrite protection.

### Generated outputs

Workers ingest provider bytes into Relay-controlled storage before a run
succeeds. If storage fails after output retrieval, retry persistence without
regenerating when captured data remains available.

## Share links and managed delivery

```text
relay.share_links
  id
  workspace_id
  artifact_id
  artifact_version_id nullable
  token_hash
  follow_current
  expires_at nullable
  max_resolutions nullable
  resolution_count
  require_auth
  content_disposition
  revoked_at nullable
  created_by
  created_at
```

A Relay share link is durable policy. Resolution authorizes the token, applies
limits, selects a version, then creates a short S3 signature or proxies bytes
when future requirements demand it. With redirect/presign delivery Relay can
enforce URL issuance/resolution count, not actual byte downloads because one
issued bearer URL may be reused. Name the policy `max_resolutions`; an
enforceable `max_downloads` feature requires Relay-proxied delivery.

Revocation prevents future Relay resolutions. It cannot invalidate a previously
issued S3 bearer URL immediately, so storage signatures remain short-lived.

The route remains an open contract between `/s/:token` and v3's `/share/:token`.
Resolve it before public URL implementation; do not ship both accidentally.

## Entitlements

Core application services ask capability/limit APIs, never plan names:

```text
can(workspace, capability)
limit(workspace, metric)
```

Initial capabilities may include:

```text
tools.execute.<tool-key>
artifacts.upload
artifacts.share
storage.max_bytes
runs.max_concurrent
runs.max_queued
```

Scheduling class is separate from entitlement. A paid workspace may have a
higher scheduler weight, but weight does not itself authorize a tool.

### Explicit MVP allowances

Owner decision, 2026-09-06: require explicit usage allowances before execution.
Automatic unlimited grants on sign-in or during migration are rejected.

- Creating or revisiting a personal workspace establishes membership only.
- A workspace must have an active `tools.execute` capability grant and an
  explicit limit for the tool's metric: `images.generated` in `image` units or
  `ocr.requests` in `request` units, both using `calendar_month` periods.
- Missing or exhausted allowances deny admission before a job/provider call.
  An unlimited grant is valid only when deliberately assigned by an operator.
- Seeded meter policies count output images and OCR requests. They do not
  establish customer prices, subscription quotas, or provider-cost rates.
- Superadmins manage explicit grants at `/admin/allowances`, with fresh-session
  authorization, effective windows, revocation, audit history, and idempotent
  retries. See [the operator guide](../allowance-management.md) and
  [#36](https://github.com/ZafTec/relay/issues/36). Capacity settings remain
  separate from usage grants. Production allowance values must still be chosen
  and assigned explicitly by an authorized operator.

The predeployment baseline no longer seeds `relay.mvp.defaults.v1` grants.
Databases created from the earlier branch may still contain those grants and
have a different migration checksum. Do not overwrite their ledger or reset
them implicitly: use a fresh disposable database for tests, and review any
retained database and revoke legacy automatic grants before enabling execution.

## Metering model

Separate:

- Estimate
- Reservation
- Customer usage event
- Provider-cost event
- Adjustment

Suggested tables:

```text
relay.meter_policies
relay.pricing_policies
relay.usage_reservations
relay.usage_events
relay.provider_cost_events
relay.usage_buckets
relay.entitlement_grants
relay.subscription_snapshots
```

All ledgers are append-only. Every event has a unique idempotency key.
Historical runs reference the policy revisions used.

Async lifecycle:

1. Check entitlement.
2. Estimate using tool/version/model/input.
3. Atomically reserve conservative capacity.
4. Create run/job/outbox.
5. Record upstream cost as attempts execute.
6. Commit actual customer usage at the approved settlement point.
7. Release unused reservation.
8. Correct later errors through compensating events.

Provider cost and customer charge are not the same. System retries may create
provider cost without customer usage depending on the versioned policy.

## Expected tests

### Catalog

- Lifecycle transition matrix
- Published version immutability
- Handler and schema hash validation
- Missing handler/provider binding behavior
- Superadmin-only publication and audited changes
- Deprecated/disabled/retired discovery and invocation behavior
- No executable code can be supplied through database/API input

### Storage contract

Run the same suite against MinIO and selected external provider sandboxes:

- Presigned PUT succeeds with exact headers
- Altered bytes/checksum fails
- Reuse of immutable key fails or is detected according to provider capability
- Missing/changed signed headers fail
- Expired URL and wrong method fail
- `HEAD` verifies expected metadata and size
- Path-style and virtual-host URLs are correct
- CORS permits only intended origin/method/headers
- Source-free compiled image uses explicit credentials and no filesystem chain
- SDK candidate size/cold-start evidence is recorded

### Artifacts/share

- Workspace isolation on every read/mutation
- Unique versions and optimistic head updates
- Partial output preserves successful items
- Soft delete/purge/restore behavior
- Pinned versus follow-current share links
- Expiry, resolution-limit exhaustion, revocation, and concurrent resolution
  counting
- Pending-upload TTL, quota release, idempotent completion, and orphan cleanup
- Raw provider/storage URL never appears in durable result

### Metering

- Concurrent reservations cannot overspend allowance
- Duplicate settlement is idempotent
- Success commits actual and releases excess
- Failure/cancel/timeout policies release or settle correctly
- Partial output follows policy
- Provider cost remains separate from customer usage
- Adjustment preserves original event history
- Historical receipt remains explainable after policy changes

## Completion gate

This phase is complete when catalog publication controls deployed handlers,
MinIO contract tests pass through a provider-neutral adapter, artifacts are
immutable and workspace-scoped, share links are policy resources, and concurrent
usage reservations settle exactly once.
