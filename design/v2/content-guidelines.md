# Relay — content guidelines

## Positioning

Relay is durable infrastructure for work that does not finish in one request.

Primary line: **Files in. Work underway. URLs out.**

Supporting line: *Relay gives MCP clients durable object storage, observable
background jobs, and signed delivery URLs — without routing file bytes through
the application.*

Relay is not a consumer cloud drive, a workflow builder, or an image generator
with storage bolted on. Copy never implies any of those.

## Voice

Short, direct, specific, operational — written by the engineers who run the
system. Second person for the reader's problem, third-person-free.

Say: direct-to-S3 uploads, immutable versions, durable job state, signed URLs,
traceable work, failures that can be retried and inspected.

Never say: revolutionary, seamless, effortless, game-changing, cutting-edge,
limitless, best-in-class, AI-powered, enterprise-grade, blazing fast.

No emoji. No exclamation points. Periods and the occasional em dash.

## Casing

- Sentence case for headings and body.
- UPPERCASE with 0.10–0.14em tracking only for mono labels, buttons, kickers and
  metadata.
- Section kickers: `// 01 Section name` — exact form, slash-prefixed.
- Product nouns stay lowercase in prose: workspace, asset, version, job, signed
  URL. Tool names stay in code voice: `relay.enqueue_job`.

## Claims discipline

Do not write, imply, or mock up:

- customer names, logos or counts
- uptime, latency, throughput or cost-saving figures
- certifications or audits
- unreleased features described in the past tense

Allowed proof is what the system does: S3 API compatibility, presigned PUT/GET,
immutable versions, durable job state, workspace-scoped signing, OAuth-only auth.

Illustrative content must be marked in the artefact itself — `ILLUSTRATIVE`,
`SAMPLE`, `PREVIEW · NOT SHIPPED`, `SOON`, `PLANNED`. The landing page states
plainly: "No customer logos, uptime figures, or benchmark claims on this page —
only what the system does."

## Naming conventions used across the designs

| Kind | Form | Examples |
|---|---|---|
| Asset key | path-like, lowercase, extension | `renders/quarterly-map.png` |
| Version | `v` + integer | `v1`, `v2`, `v3` |
| Checksum | `sha` + first 6 | `sha 9f21c4` |
| Job id | `job_` + 6 hex | `job_8f31c0` |
| Workspace id | `ws_` + 4 hex | `ws_a1f9` |
| Object prefix | `relay/<workspace>/…` | `relay/ws_a1f9/…` |
| MCP tool | `relay.<verb>_<noun>` | `relay.create_upload_url`, `relay.get_job` |
| Job state | uppercase | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED` |
| Release | semver, mono | `0.4.0`, tag `v0.4.0`, commit `9f21c4a` |
| Changelog category | uppercase | `ADDED`, `IMPROVED`, `FIXED`, `SECURITY`, `BREAKING` |

## Error message shape

Three parts, in order: what failed, what did not change, what to do.

> Upload URL expired. The object was not written. Request a new URL and retry.

> Job minutes limit reached. New jobs are rejected; reads and downloads
> continue. Raise the workspace limit or wait for the next period.

Typed error codes appear in mono inside the message (`url_expired`,
`access_denied`) — they are what an engineer searches for.

## Changelog writing

One line per item, present tense, user-facing effect first, mechanism second.

> Job progress is reported per step. `relay.get_job` returns the current stage
> and the count of completed steps.

Breaking items state the removal version: "The old field is accepted until
0.6.0." Security items describe the fix, never the exploit, and are published
only after the fix is deployed everywhere and any embargo has ended.

## Landing-page copy deck (as designed)

- Hero: *Files in. Work underway. URLs out.*
- `// 02` What Relay actually runs — S3-compatible object store · Presigned PUT
  and GET · Assets with immutable versions · Durable background jobs
- `// 03` Request to result — *The request ends. The work continues.*
- `// 04` Versions — *Every write keeps its predecessor*
- `// 05` MCP tools — *Tools an MCP client can hold*
- `// 06` Deployment — *Bring your own S3-compatible store*
- `// 07` Usage & entitlements — *Limits that fail predictably* (`PLANNED · NOT SHIPPED`)
- `// 08` Security & isolation — *A workspace is the boundary, not a filter*
- `// 09` Changelog — three most recent published releases
- `// 10` Get started — *Point a client at Relay.*
- Footer: ZafTech Solutions · Addis Ababa, Ethiopia · Terms · Privacy · Data processing
