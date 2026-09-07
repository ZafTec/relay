# Connect agents, save files, and receive notifications

## OAuth clients

Sign in, open **Workspace settings**, and copy the MCP URL. A superadmin can
open **Manage OAuth clients** (`/admin/oauth-clients`) to register the exact
redirect URI supplied by an agent. Choose its permissions and authentication
method. Copy the client ID and the one-time secret into the agent. Public
clients use PKCE without a secret. All authorization-code clients require PKCE
with S256.

The endpoint accepts the SDK's stateless 2025-03-26, 2025-06-18 and 2025-11-25
compatibility flows as well as the 2026-07-28 protocol. Agents can use normal
initialization without forcing a protocol revision. Both paths revalidate OAuth
scopes and workspace membership for each request; Relay does not issue MCP
session IDs.

The agent sends you to Relay to sign in, select a workspace, and approve access.
Registration does not grant usage allowances. Execution still needs an explicit
`tools.execute` capability and the applicable image or OCR allowance. Client
creation, rotation, and deletion require a recently authenticated superadmin
session. Clients are managed by the superadmin who registered them. Dynamic
registration and client-credentials grants are disabled.

Rotating a secret requires updating the agent. Deleting a client invalidates its
authorizations. If a creation response is lost, refresh the list and rotate the
client's secret to obtain a new copy.

## Superadmin invitations

Open `/admin/superadmins`, enter a colleague's email, and create an invitation.
Copy the link and send it to that person. Creating a link does not send an
email. The recipient must sign in with that verified email, authenticate
recently, and explicitly accept. Invitations expire after seven days and can be
revoked. The inviter must still be a superadmin when the invitation is accepted.
Accepting an old invitation again cannot restore a role that was independently
revoked.

## Image generation and editing

The catalog and dashboard provide generation and editing tools for GPT Image 2,
FLUX.2 Pro, MAI Image 2.5, and MAI Image 2.5 Flash, plus document OCR. Inputs
are pinned to verified artifact versions in the current workspace.

- GPT editing accepts up to 16 reference images, an optional PNG mask, and input
  fidelity. The mask must match the first reference's dimensions.
- FLUX editing accepts up to eight references.
- MAI generation produces one PNG. Each edge is 768–1,365 pixels and total area
  cannot exceed 1,048,576 pixels. Editing accepts one PNG or JPEG.

Provider calls with an ambiguous result are not automatically resubmitted. Every
output is stored as an artifact; its run exposes the artifact/version IDs.
Partial-image streaming is not implemented.

## Upload content from an agent

`relay.artifacts.upload_content` accepts actual base64 bytes or UTF-8 text, up
to 4 MiB decoded. The agent must be able to access the attachment bytes; a chat
attachment ID or local filename alone is insufficient. Large files can use
`relay.artifacts.create_upload` followed by `relay.artifacts.complete_upload`.

Example upload arguments:

```json
{
  "name": "notes.txt",
  "mimeType": "text/plain",
  "encoding": "text",
  "content": "Notes to keep in my workspace.",
  "access": "temporary",
  "expiresInSeconds": 300
}
```

Supply a stable `io.relay/idempotency-key` in the MCP call's `_meta`, and reuse
it when retrying the same operation. Upload requires `artifacts:write` and
`artifacts:read`.

`relay.artifacts.get_access` also creates an access URL for an existing upload
or tool output. Temporary URLs last 1–3,600 seconds, defaulting to 300. Choose
`access: "permanent"` for a non-expiring, revocable share link; omit
`expiresInSeconds`. Permanent access additionally requires `artifacts:share` and
an idempotency key. Anyone holding a share link can read that version while the
file is retained and the link remains active. Files stay private by default.

## Email notifications

Notifications start disabled. In **Workspace settings → Email notifications**,
choose completed/failed runs and save. An agent with the appropriate scopes can
use `relay.notifications.get` or `relay.notifications.configure`. Configuration
requires `{ "completed": true, "failed": true, "confirm": true }` after the user
explicitly requests the change. Set both booleans to false to opt out.

Emails go to the user's current verified sign-in address for runs they create in
that workspace. Messages contain an authenticated run link, without prompts or
attachments. Delivery rechecks membership and preferences. An email already
being sent may still arrive after opt-out.

The worker uses Deno SMTPClient with the existing relay configured by `SMTP_HOST`,
`SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, and `SMTP_SECURITY`
(`starttls`, `tls`, or private-network `plain`). `NOTIFICATIONS_APP_URL`
defaults to the authentication origin. An absent host leaves email disabled.
Provide the same SMTP settings to the API and worker: the API exposes availability
and preferences, while the worker sends messages. Local development placeholders
are in `.env.example`.

Delivery is stored in PostgreSQL and runs within the existing worker process.
Temporary failures retry after 1 minute, 5 minutes, 15 minutes, and 1 hour, with
at most five attempts. Permanent SMTP rejections stop immediately. Each attempt
has a 30-second timeout and a fenced lease. A stable Message-ID helps identify
retries, but an ambiguous SMTP acceptance can still produce duplicate email.
Recent status is visible in settings and through MCP.

The [canonical ZafTech policies](legal.md) govern hosted-service use. The source
code is distributed under the [MIT license](../LICENSE).
