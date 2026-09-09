# Connect agents, save files, and receive notifications

## OAuth clients

Sign in, open **Workspace settings**, and copy the MCP URL into your agent's
connection settings. Compatible agents register automatically, open Relay for
sign-in, and let you choose a workspace and approve individual permissions.
Removing a permission from consent leaves that capability unavailable to the
agent. Public clients use PKCE without a secret; confidential clients receive
credentials during registration. All authorization-code clients require S256
PKCE and exact callback URLs. HTTPS callbacks and local loopback callbacks are
supported; wildcard callbacks are rejected.

For agents that ask you to supply a client ID, open **Manage OAuth clients**
(`/dashboard/oauth-clients`) from Settings. Create a client with the exact
callback URL supplied by the agent, choose its permissions and authentication
method, and copy the client ID and one-time secret into the agent. Public
clients do not have a secret. Manual registration still leads to the same
workspace selection and permission approval flow. A current superadmin also
sees an additional, opt-in section for requesting platform-wide `admin:*`
scopes on a client; those still require consent and never bypass workspace
usage allowances.

The endpoint accepts the SDK's stateless 2025-03-26, 2025-06-18 and 2025-11-25
compatibility flows as well as the 2026-07-28 protocol. Agents can use normal
initialization without forcing a protocol revision. Both paths revalidate OAuth
scopes and workspace membership for each request; Relay does not issue MCP
session IDs.

Registration does not grant usage allowances. Execution still needs an explicit
`tools.execute` capability and the applicable image or OCR allowance. Client
creation, rotation, and deletion require a recently authenticated superadmin
session when managed manually. Managed clients belong to the superadmin who
registered them. Client-credentials grants are disabled.

Rotating a secret requires updating the agent. Deleting a client invalidates its
authorizations. If a creation response is lost, refresh the list and rotate the
client's secret to obtain a new copy.

## Workspaces and storage usage

Workspaces have a readable name and a memorable slug, such as **Calm Cedar** and
`calm-cedar-4821`. In **Workspace settings**, create a workspace, edit the proposed
name and slug before saving, switch between your workspaces, or rename one you
own. Each account can own up to 20 workspaces. Creating a workspace grants
ownership; it does not grant execution access or usage allowances.

Existing generated personal workspace labels are upgraded during migration.
Custom names and slugs are preserved. Workspace IDs, memberships, files, tokens,
and allowances remain attached to the same workspace.

The **Usage** page shows storage separately from tool activity. Stored bytes
include retained versions and files waiting for physical deletion. Upload
reservations include abandoned uploads waiting for cleanup; that cleanup amount
is shown separately and counted only once. Available space uses the same limit
as upload enforcement. A failed capacity lookup is shown as unavailable.

Agents with `usage:read` can call `relay.usage.storage` without arguments. The
HTTP equivalent is `GET /api/v1/usage/storage`. Both use the current workspace
and return exact decimal byte strings, including stored, reserved, cleanup,
limit, and available bytes. A null limit means explicitly unlimited storage.

## Administration through MCP

Superadmins can explicitly approve administration scopes during connection.
These permissions are excluded from default access; workspace ownership alone
does not grant them. Each call rechecks the current verified account, browser
session, and superadmin role. Administrative mutations also require recent
authentication; sign in again and reconnect when prompted.

| Scope family | Available operations |
| --- | --- |
| `admin:allowances:read` / `write` | Find workspaces, inspect allowances and audit history, grant and revoke allowances |
| `admin:capacity:read` / `write` | Inspect and revise execution capacity policies |
| `admin:superadmins:read` / `write` | List administrators, create and revoke invitation links |
| `admin:changelog:read` / `write` | Inspect, draft, revise, publish and unpublish releases |
| `admin:oauth:read` / `write` | List, inspect, create, update, rotate and delete owned OAuth clients |

Tools use the `relay.admin.` prefix, for example
`relay.admin.allowances.workspaces` and `relay.admin.oauth.create`. The agent
discovers only administrative operations covered by its consented scopes.
Writes require a stable 16–128 character `io.relay/idempotency-key` in call
metadata. Allowance, capacity, changelog, and invitation mutations retain their
existing replay protection and audit boundaries.

OAuth client operations use Better Auth's native management endpoints, which
do not deduplicate requests using that metadata key. Creation and secret rotation
return a secret once. Never automatically retry an uncertain creation or
rotation: inspect the client list and obtain the user's instruction before
creating another client or rotating again. OAuth tools are marked
non-idempotent. Changing a client's authentication method requires a new client.
Native OAuth administrative writes need at least two database connections
(`DATABASE_POOL_MAX` is 10 by default); a pool of one is rejected explicitly.

Creating a superadmin invitation returns its acceptance URL without sending
email. The recipient must sign in with the invited verified address and accept.

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
  cannot exceed 1,048,576 pixels. Editing accepts one PNG or JPEG. Valid provider
  outputs may exceed that area slightly because of tile rounding; Relay allows
  at most 5% response tolerance while retaining dimension, file-size and format
  checks. The generation input budget is unchanged.

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

In the file's **Create share link** dialog, the default is anyone with the link,
the latest version, no expiry, unlimited opens, and inline viewing. Create the
link and copy its visible URL. **Advanced options** contains restrictions and
version choices. Revoke the link to stop future access.

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
