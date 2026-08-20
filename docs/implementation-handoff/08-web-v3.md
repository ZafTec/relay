# Web implementation from design v3

Phase: Wave 2C foundation and Wave 4 route groups\
Primary owner: web foundation worktree, then route-specific worktrees\
Depends on: committed/approved v3 for Wave 2C; auth/API/SSE contracts for later
route integration\
Current status: normalized and committed at `1eb7a3d`; owner-authorized as the
current implementation reference with explicit unresolved fixture/product facts

## Objective

Implement a semantic, accessible React/Vite application that faithfully uses the
approved Ledger visual system and registry-first v3 flows without shipping
design canvas runtime code, stale fixtures, or unresolved product assumptions.

## Design source

Actual current locations:

```text
design/v3/*.dc.html                      raw canvas sources
design/v3/HANDOFF.md                     pivot handoff
design/v3/IMPLEMENTATION-MANIFEST.md      source precedence and exceptions
design/v3/ACCESSIBILITY.md               accessibility contract
design/v3/DESIGN.md                      design system
design/v3/tokens.json                    token values
design/v3/brand/                         logo and icons
design/v3/assets/                        diagrams
design/v3/screens/                       mostly stale review exports
```

Before UI implementation:

1. Verify v3 commit `1eb7a3d` and its implementation manifest are reachable from
   the worktree baseline.
2. Resolve product assumptions listed below before affected production copy or
   contracts are implemented.
3. Re-export current canvases or explicitly use `.dc.html` as temporary visual
   source while browser snapshots become the implementation baseline.

Do not flatten or reformat the raw design package in place. Copy approved assets
and derive production tokens/components under `apps/web`.

## Files that never ship

Do not import or copy into the production bundle:

```text
design/v3/support.js
design/v3/image-slot.js
design/v3/_ds/_ds_bundle.js
design-host bridges
x-dc/sc-if/sc-for custom canvas elements
unpkg React/Babel runtime loaders
```

Raw canvases contain thousands of inline styles, template expressions, and inert
controls. They are visual evidence, not JSX source.

## Proposed web structure

```text
apps/web/
  src/
    app/
      router/
      providers/
      errors/
    auth/
    components/
      ui/
      brand/
      layout/
      public/
      product/
      admin/
    features/
      tools/
      runs/
      artifacts/
      usage/
      settings/
      changelog/
      docs/
      status/
    lib/
      api/
      contracts/
      session/
      events/
      formatting/
      testing/
    styles/
      tokens.css
      fonts.css
      globals.css
  public/relay/
  tests/
```

Choose routing/query/form dependencies during the web foundation spike. Do not
add TanStack Pacer now. A later concrete debounce/batching need can justify it.

## Shared foundation is serial

One worktree must establish before route parallelism:

- Vite/React app and production build
- Router and route-error boundaries
- API client/error/idempotency conventions
- Browser-safe auth/session adapter interfaces and fixture implementation
- Protected-route boundary and safe-return-URL contract
- Workspace-context interface
- Event-client interface without inventing final SSE payloads
- CSS tokens generated from the approved JSON
- Self-hosted font declarations
- Brand/diagram asset copy procedure
- Public, dashboard, and superadmin layouts
- Semantic button/link/form/table/dialog/sheet primitives
- Test fixture boundary
- Unit, browser, accessibility, and screenshot harness

Parallel branches must not each create their own token system, router, session
provider, or primitives. After Better Auth merges, one short serial integration
replaces the auth fixtures with the real browser client/session provider. After
Wave 4A, another serial integration replaces the event fixture with the real SSE
client and resynchronization contract.

## Route implementation order

### Route group 1 — landing, sign-in, protected overview

Run in parallel after shared foundation:

```text
apps/web/src/features/landing
apps/web/src/features/auth
apps/web/src/features/dashboard-overview
```

Merge and pass browser gate together. This preserves the agreed first user
slice.

### Route group 2 — public/governance

Parallel after public shell and backend contracts:

```text
changelog public/admin
docs/search
status
profile basics
```

Sample changelog/status values do not ship. Empty or unknown states render until
real data exists.

### Route group 3 — registry resources

Parallel after catalog/artifact contracts:

```text
tool catalog/detail
artifact gallery/detail/share
admin tool registry
admin providers
workspace settings base
```

The final image composer waits for a real provider/model and meter policy.

### Route group 4 — execution and usage

Parallel after run/SSE/meter contracts:

```text
runs list/detail/live states
usage/receipts/breakdowns
```

### Route group 5 — first image tool

Integrate the real schema-driven composer, estimate/reservation, outputs, and
share flow only after the provider vertical slice is operational.

## Required cleanup and reconciliation

### Product copy

Correct remaining storage-first text in App Screens and content guidance. Use:

```text
Tools / Runs / Artifacts / Usage / Settings
```

Use `run` as the customer noun and `job` only in operational detail.

### Fixture facts

Treat as illustrative until approved:

- Halide XL and Aurora Fast
- Prices, balances, rate limits, latency, counts, uptime, incidents
- Pro plan wording
- Release entries
- Provider routing order

Fixtures live only in tests/story fixtures and carry clear labels. Production
adapters never fall back to them.

### Open routes/names

Resolve before implementation:

- `/s/:token` versus v3 `/share/:token`
- `/api/v1/tool-runs` versus v3 `/api/v1/runs`
- Top-level versus artifact-nested share creation
- Exact MCP tool names
- MCP onboarding route
- Addressable run/artifact detail route versus drawer-only behavior

### Missing assets

- Official Google and GitHub marks
- Real licensed generated-image examples
- Plus Jakarta Sans weight actually used by design or an approved weight mapping
- Complete license files
- Current screen exports for new/changed canvases

Do not fetch fonts, React, or product assets from public CDNs in production.

## Component extraction

Implement contracts from v3, not its raw markup. Priority shared components:

```text
RelayMark / RelayLockup
Button / LinkButton
FormField / Select / Textarea / Checkbox
InlineNotice / InlineAlert
StatusBadge
SemanticDataTable
Dialog / FullScreenSheet / Drawer
ProgressBar
Skeleton
CodeBlock
PublicHeader / Footer
DashboardRail / PageHeader / CurrentWorkspaceLabel / SessionMenu
Future multi-workspace phase: WorkspaceSwitcher
ToolCard / ToolRow / ToolLifecycleBadge
SchemaDrivenForm / ProviderModelSelector
MeterEstimate / UsageReservationSummary / RunReceipt
RunStateTimeline / AttemptLedger / RetryDecision / SseConnectionStatus
OutputSetGrid / ArtifactCard / Gallery / Preview / VersionHistory
ManagedUrlPanel / ShareLinkPolicyForm / PublicShareView
ToolPublishChecks / ProviderHealthPanel / McpConnectionGuide
```

Every component contract includes props/data, events, permissions, async states,
keyboard behavior, ARIA behavior, responsive rules, overflow, and fixture
policy.

Use real `<table>` elements for tabular data unless a complete ARIA grid is
justified. The v3 accessibility contract supersedes the old div-grid table
inventory.

## Accessibility contract

Required implementation behavior:

- One `h1` and correct landmarks per page
- Visible labels and linked validation messages
- Real checkbox semantics for toggles
- 44×44 minimum interactive targets
- 2px focus-visible ring with 2px offset
- Dialog/sheet initial focus, trap, Escape, and focus return
- Polite live regions for copy/progress transitions
- Alerts for blocking errors
- Progress ARIA values and text equivalent
- Accessible table equivalent for charts
- Keyboard-focusable horizontally scrolling diagrams
- Long identifiers wrapping at 320px/zoom
- Status never color-only
- Reduced-motion behavior

The static design has not proven these; engineering/QA owns verification.

## Responsive matrix

Test at minimum:

```text
320px reflow
390px mobile
768/834px tablet
1024px compact desktop
1440px desktop
200% text zoom
Windows forced colors
prefers-reduced-motion
```

Missing design widths are implemented by applying documented layout rules,
followed by screenshot review. Material visual ambiguity is returned to design,
not silently invented.

## State expectations

At least:

- Auth loading/provider denied/unavailable/callback failure/session expired
- Tools loading/empty/no match/blocked/degraded/deprecated/retired
- Composer validation/estimating/reserving/replay/insufficient allowance
- Runs queued/running/partial/failed/reconciling/rate-limited/cancel requested/
  cancelled/completion race
- SSE connected/reconnecting/stale/offline/resynchronized/permission changed
- Artifacts loading/empty/no match/preview processing/bytes unavailable/deleted
- Share active/expiring/expired/exhausted/revoked/public unavailable
- Usage empty/delayed/corrected/export preparing
- Admin publish blocked/confirm/disabled/provider incident
- Generic 401/403/404/500/offline boundaries

## Expected tests

### Foundation

- Production build and static web image succeed.
- No imports or requests to design runtime, unpkg, remote fonts, or placeholder
  editor resources.
- Token-generation output is deterministic.
- Shared primitives pass unit and axe tests.
- Router protection and safe return URL work.

### Landing/auth/dashboard gate

- Correct landmarks and one `h1`.
- Keyboard navigation and focus order.
- CTAs target real routes.
- Google/GitHub states and official accessible marks.
- Anonymous `/dashboard` redirect and authenticated render.
- Session expiry and sign-out.
- Workspace context and superadmin conditional navigation.
- No fake changelog/status/usage/provider claims.
- Viewport matrix and no horizontal overflow.
- Screenshot comparison against approved current references.

### Product golden path

```text
browse tool
-> inspect contract/meter
-> configure
-> estimate/reserve
-> submit idempotently
-> queued/running SSE
-> reconnect/resync
-> output artifacts
-> artifact detail
-> create/copy share
-> public resolve
-> revoke/expire/exhaust
```

Test success, multi-output, partial output, deterministic rejection, safe retry,
ambiguous reconciliation, cancellation race, storage failure, allowance denial,
and permission removal.

### Accessibility

- Automated axe with dynamic states opened
- Keyboard-only golden path
- VoiceOver and NVDA golden path
- Dialog/drawer/sheet focus behavior
- 320px/200%/forced-colors/reduced-motion
- Chart equivalent tables
- SSE announcements once per meaningful transition

## Completion gate

The frontend is ready when it builds independently from raw design runtime,
matches the approved v3 visual intent at required viewports, consumes real typed
contracts, contains no production fixture claims, and passes the complete
accessibility/golden-path gate.
