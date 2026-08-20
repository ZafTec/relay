# Relay design-agent suggestions

Status: required revision backlog\
Audience: the next Relay design agent\
Product authority:
[`../../../docs/product-and-roadmap.md`](../../../docs/product-and-roadmap.md)\
Implementation status:
[`../../../docs/implementation-status.md`](../../../docs/implementation-status.md)

## Read this before changing the handoff

The current designs were created for an earlier storage-first product. Relay's
approved direction is now:

> Relay is a curated tool and artifact registry for AI agents. Tools execute
> asynchronously, outputs persist as durable artifacts, all work is metered, and
> agents receive managed URLs.

The initial catalog focuses on multiple metered image generators. Storage
remains an essential substrate, but it is not the primary information
architecture or product story.

Do not implement application code. Produce a revised, reviewable design handoff
only. Work in a design branch or worktree, keep commits design-specific, and do
not silently replace the owner-approved Ledger identity.

## Current handoff verdict

Neither existing handoff is implementation-ready for the current product.

- `design/relay/` is the tracked Git authority, but it covers only the older
  landing, auth, dashboard shell, and changelog direction. Its referenced
  `.dc.html` source is not included with it.
- `design/Relay design handoff checklist/design/relay/` is broader and includes
  docs, status, files, jobs, usage, settings, and profile. The package is
  untracked, duplicates the tracked handoff, and still models Relay as storage
  plus generic jobs.
- The newer handoff is useful as a component and state library. It is detailed
  enough to implement the wrong product if its information architecture and copy
  are copied unchanged.

Do not declare the revision complete by adding more screens to the duplicate
folder. The final deliverable must establish one canonical, tracked handoff
after owner approval.

## Preserve these foundations

The revision should preserve or deliberately evolve these strong elements:

- Ledger mark and slab/version geometry, pending explicit owner review
- Public paper and product onyx surface split
- Plus Jakarta Sans and JetBrains Mono pairing
- Sharp geometry, one-pixel borders, one-accent system, and restrained elevation
- Direct ZafTech voice and claims discipline
- Mono metadata for IDs, versions, states, provider/model names, and usage
- Seven-state control thinking: default, hover, focus, active, disabled,
  loading, and error
- Existing alert, dialog, drawer, shell, progress, status, and version-history
  patterns
- Honest empty states and explicit consequences
- Changelog, sign-in, docs, and public-status foundations
- Job attempt, retry, cancellation, and log patterns after correcting their
  contracts
- Original custom SVG approach instead of generic stock imagery

Do not preserve the storage-first route hierarchy or copy merely to maintain
visual consistency.

## Canonical product language

Use these terms consistently in navigation, screen copy, diagrams, mock data,
and component names:

| Term             | Meaning in the UI                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| Tool             | A curated capability an agent can discover and invoke.                                           |
| Tool version     | The immutable input/output, handler, execution, and meter contract.                              |
| Provider         | The external service or internal engine executing the tool.                                      |
| Provider model   | The selected model/engine and capability/pricing snapshot.                                       |
| Run              | One durable accepted invocation visible to users and agents.                                     |
| Job              | The asynchronous queue execution behind a run. Prefer “run” in primary product copy.             |
| Attempt          | One provider submission, retrieval, or recovery segment within a job.                            |
| Artifact         | A durable uploaded input or generated output owned by a workspace.                               |
| Artifact version | One immutable representation of an artifact.                                                     |
| Output set       | The named collection of zero, one, or many outputs from a run.                                   |
| Managed URL      | A Relay-controlled way to deliver an artifact. Do not show a provider URL as the durable result. |
| Share link       | A revocable Relay resource with expiration and access policy, separate from an S3 signature.     |
| Estimate         | Pre-run projected use or range.                                                                  |
| Reservation      | Capacity held before execution.                                                                  |
| Usage receipt    | Settled customer consumption after execution.                                                    |
| Provider cost    | Internal upstream cost, not interchangeable with customer usage.                                 |
| Workspace        | The tenant and authorization boundary.                                                           |

Use `run` as the primary noun in navigation and customer-facing flows. Use `job`
inside operational detail where queue behavior matters.

## Proposed information architecture

### Public

```text
/
/tools or /docs/tools
/docs
/changelog
/status
/sign-in
```

The landing page may preview the catalog without publishing callable tools to an
unauthenticated visitor. Keep Product, Docs, Changelog, Status, Sign in, and
Open dashboard legible at all viewport sizes.

### Authenticated product

```text
/dashboard                 Overview and recent activity
/dashboard/tools           Curated catalog
/dashboard/tools/:toolKey  Tool contract, examples, availability, and run entry
/dashboard/runs            Run history
/dashboard/runs/:runId     Full run detail or addressable drawer/sheet
/dashboard/artifacts       Artifact gallery and list
/dashboard/artifacts/:id   Artifact detail and versions
/dashboard/usage           Estimate, reserved, settled, and breakdown views
/dashboard/settings        Workspace, MCP clients, access, retention, and future billing
/profile                   Account, providers, workspaces, and sessions
```

Primary product navigation should be:

```text
Overview / Tools / Runs / Artifacts / Usage / Settings
```

If Overview adds little value after the first-run experience, the default
`/dashboard` may become Tools or Runs. Design both the zero-state and a mature
workspace before deciding.

### System superadmin

```text
/admin/tools
/admin/tools/:toolKey
/admin/providers
/admin/changelog
/admin/audit
```

Superadmin is platform-scoped and separate from workspace owner/admin/member.

## Golden path to design completely

The implementation-blocking flow is:

```text
browse tool
  -> inspect contract and meter
  -> configure inputs
  -> review estimate and reservation
  -> run
  -> observe live state and attempts
  -> inspect one or many output artifacts
  -> create or copy a managed share link
```

Design the golden path using at least two realistic image generators or provider
models. Use the same representative prompt where useful so differences in
capability, output, latency, and meter unit are understandable.

The path must work for:

- An authenticated person in the dashboard
- An AI agent reading the MCP tool schema and structured result
- A first run in an empty workspace
- A returning user with many runs and artifacts
- Desktop, tablet, and mobile
- Keyboard-only and reduced-motion operation

## Required screens

### P0 — Core product screens

1. **Revised landing page**
   - Hero statement about curated tools, durable artifacts, metering, and
     managed delivery
   - Custom hero flow: agent -> registry -> asynchronous run -> image artifacts
     -> managed URL
   - Realistic catalog preview with more than one image generator
   - Representative generated outputs, clearly labelled as examples
   - Typed MCP contract example
   - Failure/retry and meter proof, not generic feature claims
   - Published changelog preview only when data exists

2. **Tool catalog**
   - Search and category/capability filters
   - Curated tool cards or rows
   - Availability, lifecycle, output type, provider/model, meter unit, and
     expected latency
   - Empty, loading, no-match, unavailable, degraded, deprecated, and
     entitlement-blocked states

3. **Tool detail and contract**
   - Stable tool name and tool version
   - Provider/model options or explicit routing policy
   - Human description and machine contract
   - Input and output schema
   - Limits, expected latency, safety behavior, usage unit, and estimate method
   - Generated examples with prompt/parameter provenance appropriate for display
   - Version history and deprecation notice
   - MCP and HTTP invocation examples using `/api/v1`

4. **Typed image-run composer**
   - Prompt and optional negative prompt
   - Dimensions or aspect ratio
   - Output count
   - Seed and quality when supported
   - Optional reference-artifact input
   - Provider-specific options in a clearly bounded advanced section
   - Validation messages tied to fields
   - Estimate range, reservation amount, policy summary, and available balance
   - Submit, submitting, duplicate/idempotent replay, and blocked states

5. **Run list**
   - Tool, version, provider/model, state, progress, output count, estimated and
     settled usage, actor/client, and time
   - Filters for state, tool, provider/model, actor/client, and date
   - Live SSE status, reconnecting, stale, offline, and resynchronized states
   - Desktop table and mobile list with equivalent actions

6. **Run detail**
   - Run identity, tool/version, provider/model, actor/client, idempotency key,
     and timestamps
   - Inputs with secret/private fields redacted
   - Estimate, reservation, actual usage, provider cost visibility appropriate
     to role, and settlement state
   - Job progress and all attempts
   - Provider operation identity where operator-only
   - Retry classification and exact next action
   - `cancel_requested` state and late-cancellation outcome
   - Output set with per-output status
   - Full terminal receipt and artifact links

7. **Artifact gallery and list**
   - Image-first gallery plus dense list mode
   - Thumbnail, artifact/version ID, media facts, source tool/run, created time,
     managed-link state, and usage where appropriate
   - Search and filters for type, tool, provider/model, run, date, and sharing
   - Empty, loading, no-match, broken-preview, unavailable-byte, deleted, and
     retention-pending states

8. **Artifact detail**
   - Large accessible preview and metadata
   - Current and immutable versions
   - Source run, tool/version, provider/model, inputs/provenance, checksum,
     size, dimensions, and content type
   - Output-set siblings
   - Download, create share link, copy managed URL, revoke, delete, and restore
     actions according to permissions
   - Mobile full-screen detail treatment, not an unspecified desktop drawer

9. **Share-link management**
   - Create link for current or pinned version
   - Expiration, download limit, authentication, and content-disposition policy
   - Copy confirmation and one-time secret handling where applicable
   - Active, expiring, expired, exhausted, revoked, and resolution-error states
   - Explicit copy that revocation blocks future Relay resolutions but does not
     retroactively invalidate an already issued short-lived S3 bearer URL
   - Public recipient page and inaccessible/expired page

10. **Usage and meter detail**
    - Estimated, reserved, settled, released, and delayed/reconciling values
    - Breakdown by tool, provider/model, run, artifact, actor/client, and date
    - Retry, cancellation, partial-output, and provider-failure treatment
    - Workspace allowance and concurrency limits
    - Accessible data equivalent for every chart

### P1 — Administration and integration screens

11. **Tool-registry admin**
    - Draft, internal, published, deprecated, disabled, and retired lifecycle
    - Immutable version publication and active-version selection
    - Contract, handler key, provider bindings, examples, entitlement, meter,
      and availability metadata
    - Publish, disable, deprecate, restore, and retire confirmation flows
    - Diff/preview and audit history
    - No code-upload control

12. **Provider/model admin**
    - Provider health and credentials status without exposing secrets
    - Model capabilities, pricing inputs, region, availability, rate limits, and
      retirement
    - Explicit routing and fallback policy
    - Incident disablement and impact preview

13. **MCP client onboarding**
    - Create/register client or token according to the final OAuth flow
    - Copy configuration and connect from a representative MCP client
    - Scope and workspace selection
    - Test connection
    - Connected, consent denied, expired, revoked, insufficient-scope, and
      wrong-audience states

14. **Revised docs quickstart**
    - Discover tool
    - Invoke image tool
    - Check run
    - Read output artifacts and managed URLs
    - Complete both cURL and MCP examples rather than claiming missing steps

15. **Status integration**
    - Control plane, queue, artifact delivery, and provider/tool availability
    - Explain whether existing runs or only new submissions are affected
    - Never publish fabricated uptime or incident claims

## Required components

Add implementation-level specifications for:

- `ToolCard` and dense `ToolRow`
- `ToolLifecycleBadge`
- `ToolVersionBadge`
- `CapabilityMatrix`
- `ProviderModelSelector`
- `SchemaField` family and `SchemaDrivenForm`
- `ReferenceArtifactPicker`
- `MeterEstimate`
- `UsageReservationSummary`
- `RunReceipt`
- `RunStateTimeline`
- `AttemptLedger`
- `RetryDecision`
- `SseConnectionStatus`
- `OutputSetGrid`
- `ArtifactCard`
- `ArtifactGallery`
- `ArtifactPreview`
- `ArtifactVersionHistory`
- `ManagedUrlPanel`
- `ShareLinkPolicyForm`
- `ShareLinkRow`
- `PublicShareView`
- `ToolPublishChecks`
- `ProviderHealthPanel`
- `McpConnectionGuide`

For each component, define:

- Props and data contract
- Events and side effects
- Permission behavior
- Loading, empty, error, disabled, and stale states
- Keyboard model and focus order
- ARIA semantics and announcement behavior
- Responsive behavior
- Long text, localization, and overflow behavior
- Which facts are illustrative in the handoff

## State matrix that must be visible

### Tool and provider

- Published and available
- Internal or entitlement-blocked
- Deprecated with replacement
- Temporarily disabled
- Provider degraded
- Model retired between saved configuration and execution
- Unsupported parameter combination

### Run and attempt

- Queued
- Running
- Succeeded
- Succeeded with partial outputs or warnings
- Failed before provider submission
- Provider submission confirmed; result pending
- Ambiguous provider submission under reconciliation
- Retrieval failed after confirmed completion
- Storage failed after output retrieval
- Rate-limited with retry time
- Provider timeout
- Safety or moderation rejection
- Deterministic schema or policy failure with no retry
- `cancel_requested`
- Cancelled before provider consumption
- Cancelled after partial or billable consumption
- Cancellation arrived too late and run succeeded
- No workers available

### Artifact and delivery

- Multiple outputs
- One output failed while siblings succeeded
- Preview processing
- Stored and ready
- Metadata exists but bytes are temporarily unavailable
- Managed URL provisioning delayed
- Share link active, expiring, expired, exhausted, or revoked
- Deleted and purge pending
- Version pinned versus follow-current

### Metering

- Estimate exact, ranged, or unavailable
- Reservation accepted or insufficient
- Settled
- Partially settled
- Released
- Reconciliation delayed
- Corrected by append-only adjustment
- Retry with and without customer charge

### Live updates

- Connected
- Reconnecting
- Stale data
- Offline
- Resynchronized from durable state
- Permission changed while connected

## Copy corrections

Replace or remove these old messages and concepts:

| Old direction                                            | Required direction                                                                     |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| “Durable object storage” as the primary definition       | Curated asynchronous tools with durable artifacts and managed delivery                 |
| “Relay is not an image generator with storage bolted on” | Image generation is the first tool family; Relay is broader than any one provider      |
| “Files in. Work underway. URLs out.”                     | “Call the tool. Track the work. Share the result.” or approved equivalent              |
| First action is request upload URL                       | First action is browse or invoke a curated tool                                        |
| Every job requires an asset/version                      | Each tool's schema defines whether it needs no input artifact, one, or many            |
| Every result becomes a new file version                  | A run produces an output set containing one or more durable artifacts                  |
| Raw `store.example.com` URL as result                    | Relay-managed URL and share-link resource; S3 signature is delivery plumbing           |
| `LIVE · 5s poll` in the dashboard                        | SSE connected/reconnecting/stale/resynchronized language                               |
| Retry every failed job                                   | Retry only classified transient or safely resumable failures                           |
| `Owner` and `Engineer`                                   | `owner`, `admin`, and `member`, with approved display capitalization                   |
| “Metered and accurate” on illustrative data              | Label sample values as illustrative in the screen itself                               |
| Usage equals storage/minutes/egress                      | Show estimate, reservation, settled tool usage, and provider cost as separate concepts |

Use direct operational language. Do not claim uptime, accuracy, certification,
provider availability, cost savings, or shipped behavior without evidence.

## Contract corrections

Resolve all of these before handoff approval:

1. **SSE versus polling** — Dashboard uses one workspace-scoped SSE connection,
   reconnects, and refetches durable state. MCP status tools may poll.
2. **URL model** — Share links are durable Relay resources. S3 signatures are
   short-lived bearer capabilities and are not the stored result.
3. **Retry model** — `schema_mismatch`, safety rejection, and deterministic
   policy failures do not auto-retry. Ambiguous provider submission is
   reconciled, not resubmitted blindly.
4. **Cancellation** — Include `cancel_requested` and the race where completion
   wins.
5. **API namespace** — Use `/api/v1`, not `/v1` or a separate undocumented API
   host.
6. **Roles** — Use workspace `owner`, `admin`, and `member`. Keep `superadmin`
   platform-scoped.
7. **Metering terms** — Feature flags, entitlements, reservations, customer
   usage, provider costs, and subscriptions are distinct.
8. **Storage setting** — MVP storage is deployment-configured. Do not present
   customer S3 credentials as a required workspace onboarding step.
9. **Deletion copy** — Soft deletion and async purge do not guarantee that
   already issued S3 signatures stop immediately.
10. **Tool names** — Do not fossilize the old generic job kinds. Use realistic
    versioned image-tool fixtures approved with engineering.

## New custom assets

Provide original assets for:

- Hero diagram:
  `agent -> registry -> async run -> output set -> image artifacts -> managed URL`
- Meter path: `estimate -> reserve -> provider use -> settle or release`
- Retry decision diagram distinguishing submission certainty
- Artifact provenance diagram linking inputs, tool version, provider/model, run,
  attempts, output set, and artifact versions
- Tool/generator icon family derived from the Ledger geometry
- Provider/model placeholder treatment that does not misuse third-party marks
- Official Google and GitHub OAuth marks under their brand rules
- Representative generated outputs from at least two approved providers/models
- Thumbnail, card, detail, and comparison crops for those outputs
- Input/reference-image fixtures when image-to-image is supported

Do not use stock photography for core product visuals. Generated examples must
be owned or licensed for commercial product use, include provenance, and avoid
implying that sample quality or providers are already generally available.

## Accessibility corrections

The written design intent is strong, but the source package does not yet provide
an implementation-safe accessibility contract. Fix all of the following:

- Use semantic `<table>` markup where the interaction is tabular, or fully
  specify an ARIA grid with keyboard behavior. `display: grid` alone is not a
  table contract.
- Associate every input and select with a visible label and error description.
- Use real checkbox/switch controls for toggles; define checked, disabled, and
  read-only semantics.
- Make every interactive target at least 44 by 44 CSS pixels, including row
  actions, tabs, filters, and mobile toggles.
- Define focus-visible treatment for links, buttons, menus, tabs, fields, cards,
  drawers, dialogs, and scrollable figures.
- Define initial focus, trap, Escape behavior, close behavior, and focus return
  for dialogs and mobile sheets.
- Add `aria-live` or status behavior for SSE changes, progress, copy
  confirmations, connection tests, and completed runs without announcing every
  noisy progress tick.
- Give progress bars value semantics and text equivalents.
- Give charts an adjacent table or concise accessible summary containing the
  same facts.
- Make horizontally scrollable diagrams keyboard-focusable and label the region.
- Correct paper-surface diagram text that uses a token already documented below
  AA contrast.
- Specify alt text for every diagram and meaningful generated image. Separate
  descriptive alt text from prompt/provenance metadata.
- Test 200% text scaling, 320px reflow, keyboard-only flows, screen-reader
  announcements, high contrast, and reduced motion.

## Responsive coverage

Supply a route, state, and viewport matrix with at least:

```text
390px mobile
768px or 834px tablet
1024px compact desktop
1440px desktop
```

Required additions include:

- Mobile and tablet tool catalog, detail, composer, run detail, artifact detail,
  and share-link flows
- Full-page mobile sheets for details that use a desktop drawer
- Mobile/tablet Settings, Profile, Changelog, and superadmin behavior
- Full-route loading, error, permission, destructive, and offline states—not
  only isolated component specimens
- Explicit header behavior instead of allowing the complete desktop navigation
  to become an excessively tall mobile header

Container queries are welcome, but each route still needs observable behavior at
representative widths.

## Design-system and handoff packaging

The final package must be usable without reverse-engineering screenshots:

1. Consolidate the approved result into one tracked `design/relay/` directory.
2. Do not delete either current package until the owner approves the replacement
   and the Git history is clear.
3. Include every source dependency. The current `.dc.html` files require
   `support.js`, the `_ds` bundle, remote React, and missing component sources;
   they are not self-contained offline artifacts.
4. Provide an offline-openable or reproducibly buildable source bundle with
   export instructions.
5. Include a manifest of routes, screen names, viewports, states, source files,
   exported PNGs, and checksums.
6. Connect source components to one Relay token artifact. Do not duplicate
   thousands of inline color literals.
7. Include the exact WOFF2 files and OFL licenses for every declared weight.
   Plus Jakarta Sans 500 is currently specified but absent from the newer
   bundle.
8. Resolve the wordmark conflict: written guidance says live sentence-case text,
   while the exported wordmark is outlined uppercase artwork.
9. Resolve the mark slab-count conflict between the written small-size rule and
   actual 24px examples.
10. Keep all illustrative values visibly labelled inside each screen/export.
11. Remove stale `SOON` and `PLANNED` labels where complete routes now exist, or
    retain them only when they accurately represent the approved milestone.
12. Provide component contracts, not inert visual montages with buttons that
    have no represented behavior.

## Acceptance checklist

The design is implementation-ready only when all boxes can be checked.

### Product alignment

- [ ] Landing and dashboard state the registry-and-artifact product accurately.
- [ ] Navigation is Tools, Runs, Artifacts, Usage, and Settings, with any
      Overview role explicitly justified.
- [ ] At least two image generators/models appear as realistic catalog entries.
- [ ] The complete dashboard and MCP golden path is designed.
- [ ] Tool, run, attempt, output set, artifact, version, managed URL, and share
      link are used consistently.
- [ ] Multi-output and partial-output behavior is unambiguous.
- [ ] Estimate, reservation, settled usage, and provider cost are distinct.
- [ ] No provider or S3 URL is presented as the durable result identity.

### Architecture conformance

- [ ] Dashboard live state uses SSE semantics and durable resynchronization.
- [ ] All six job states include `cancel_requested`.
- [ ] Retry actions appear only when safe and explain meter consequences.
- [ ] `/api/v1` is used in every HTTP example.
- [ ] Workspace roles are owner/admin/member; superadmin is platform-scoped.
- [ ] MVP object storage is deployment-configured, not required per workspace.
- [ ] Share-link and short-lived signature behavior is accurately explained.

### Coverage

- [ ] Every P0 screen exists at desktop and mobile widths.
- [ ] Tablet and compact-desktop behavior is specified.
- [ ] Core full-page loading, empty, error, offline, permission, destructive,
      and stale states exist.
- [ ] Tool admin, provider admin, and MCP onboarding are included.
- [ ] Representative generated-image fixtures and custom diagrams are included.

### Accessibility

- [ ] Semantic and keyboard contracts exist for tables, galleries, forms,
      drawers, sheets, dialogs, charts, progress, and live updates.
- [ ] All touch targets meet 44 by 44 pixels.
- [ ] WCAG A/AA automated checks report no violations on representative exports
      or prototypes.
- [ ] Keyboard-only and screen-reader walkthroughs are documented.
- [ ] 320px reflow, 200% text, high contrast, and reduced motion are verified.

### Package quality

- [ ] One canonical tracked handoff exists after owner approval.
- [ ] Every source opens offline with zero missing resources or console errors.
- [ ] Screens regenerate deterministically from included source.
- [ ] Tokens and required font files are complete and actually consumed.
- [ ] Asset licenses and generated-output provenance are complete.
- [ ] The route/state/viewport manifest matches every export.
- [ ] The handoff references the current product and architecture documents.
- [ ] The owner has approved the final handoff and its commit hash is recorded.

## Recommended design delivery order

1. Re-read the canonical product document and resolve open product questions
   with the owner before drawing.
2. Produce low-fidelity IA and the golden path first.
3. Confirm tool, run, artifact, share-link, and meter contracts with
   engineering.
4. Adapt the Ledger identity and component foundation to the approved IA.
5. Design the P0 desktop flow using real provider-like fixtures.
6. Design mobile and intermediate-width behavior.
7. Add admin, docs, status, and secondary surfaces.
8. Run accessibility and package validation.
9. Present one coherent review set and record owner decisions.
10. Consolidate into the canonical tracked handoff only after approval.
