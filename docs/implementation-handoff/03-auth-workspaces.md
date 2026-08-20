# Authentication and workspace implementation

Phase: Wave 2A\
Primary owner: auth worktree\
Depends on: runtime/configuration, PostgreSQL pool, migration runner\
Blocks: protected HTTP, dashboard, superadmin, MCP OAuth

## Objective

Implement OAuth-only browser authentication with Google and GitHub, one
idempotently created personal workspace per user, owner/admin/member workspace
roles, and a separate audited system-superadmin grant.

There is no email/password, magic-link, OTP, or anonymous signup path.

## Proposed paths

```text
packages/auth/
  src/auth.ts
  src/auth-client.ts
  src/config.ts
  src/session.ts
  src/workspaces.ts
  src/authorization.ts
  src/system-roles.ts
  src/testing/auth.test-instance.ts
apps/api/src/routes/auth/
apps/api/src/middleware/session.ts
packages/database/migrations/*auth*
```

The production package entry point must not export the test auth instance.

## Packages

Research snapshot:

```text
better-auth 1.7.1
pg 8.23.0
auth CLI 1.7.1, tooling only
```

Pin the exact versions proven in Wave 0. Upgrade Better Auth and official
`@better-auth/*` packages together.

## Server configuration

Required shape:

```text
appName: Relay
baseURL: https://relay.zaftech.co
basePath: /api/auth
database: shared pg.Pool
trustedOrigins: exact environment origins
socialProviders: google, github
plugins: organization
emailAndPassword: omitted
```

Security decisions:

- Secure, HTTP-only, host-only cookies in production
- `SameSite=Lax` for OAuth callback navigation
- No `.zaftech.co` cross-subdomain cookie
- CSRF and origin checks enabled
- Static production base URL instead of trusting arbitrary forwarded host data
- OAuth token encryption enabled
- OAuth state stored in database unless a tested alternative is approved
- Implicit same-email provider linking disabled
- Different-email linking disabled
- User cannot unlink their final login method
- Session cookie cache disabled initially so revocation and role changes remain
  immediately visible
- Database-backed Better Auth rate limiting initially; Redis secondary storage
  may be introduced later without moving durable sessions accidentally

Mount before catch-all routes:

```ts
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
```

Use `auth.api.getSession({ headers })` in protected Hono middleware.

## OAuth-only behavior

### Google

Required scopes:

```text
openid
email
profile
```

Do not request Drive/Gmail or offline access for login.

Callbacks:

```text
https://relay.zaftech.co/api/auth/callback/google
http://127.0.0.1:8000/api/auth/callback/google
```

### GitHub

Use the normal profile and email behavior so private primary emails are
resolved:

```text
read:user
user:email
```

Callbacks:

```text
https://relay.zaftech.co/api/auth/callback/github
http://127.0.0.1:8000/api/auth/callback/github
```

Use one local hostname consistently. `localhost` and `127.0.0.1` create
different cookie hosts.

Provider profiles must include a usable verified email before session creation.
No provider callback query, authorization code, state value, token, or raw
profile is logged.

## Personal workspace provisioning

Keep Better Auth's internal organization names. Translate to `workspace` only at
Relay API/UI boundaries.

Add an application mapping:

```text
relay.personal_workspaces
  user_id unique references auth.user
  organization_id unique references auth.organization
  created_at
```

Implement:

```text
ensurePersonalWorkspace(userId)
```

Required behavior:

1. Look up the mapping.
2. Serialize concurrent provisioning for the same user using a database lock or
   equivalent unique-insert protocol.
3. Create the organization server-side with `userId` and no session headers.
4. Use an opaque deterministic/recoverable personal slug, not the user's email.
5. Verify creator membership is `owner`.
6. Store the mapping.
7. Recover every partial state idempotently.
8. Set the session's `activeOrganizationId` to the result.

Use a session-create `before` database hook as the hard gate. A user-create
`after` hook may pre-provision but cannot be the only mechanism because a failed
after-hook can leave an existing user without a workspace.

Spike the server-side organization API call from the session hook to prove no
recursion or deadlock.

## Organization configuration

Initial organization behavior:

```text
allowUserToCreateOrganization: false
creatorRole: owner
disableOrganizationDeletion: true
teams: disabled
dynamic roles: disabled
invitations UI: deferred
```

The server can create the personal organization on behalf of a user without
session headers. User-facing arbitrary organization creation remains disabled.

Default roles match Relay:

```text
owner
admin
member
```

Every domain request enforces:

```text
authenticated user
  -> current membership lookup
  -> role/capability decision
  -> resource workspace predicate
```

`activeOrganizationId` is context, not proof. Membership can change after
session creation.

## System superadmin

Use an application table:

```text
relay.system_role_assignments
  id
  user_id
  role                  -- superadmin
  granted_by
  granted_at
  revoked_by nullable
  revoked_at nullable
```

Rules:

- Never grant by email match at ordinary sign-in.
- Initial grant uses an audited operator command.
- Every privileged request queries a current unrevoked grant.
- Workspace owner/admin does not imply system permission.
- System superadmin does not imply membership in every workspace.
- High-risk publish/provider/entitlement actions require a fresh session.
- Grant/revoke actions create durable audit events.

Do not add Better Auth's Admin plugin merely to obtain a generic `admin` field
without reviewing the naming and permission collision.

## Proxy, origin, and cookie policy

Production is same-origin:

```text
web: https://relay.zaftech.co
API/auth: https://relay.zaftech.co/api/*
```

Production normally needs no auth CORS.

For local development, prefer a Vite proxy for `/api`, `/mcp`, and
`/.well-known` so browser cookies remain same-origin. If cross-origin
development is required, use an exact origin and credentials; never `*` with
credentials.

Nginx must preserve:

- Host
- External HTTPS scheme through controlled forwarding
- Set-Cookie
- Location
- Query string on OAuth callbacks

Trust forwarded client-IP headers only from the known Nginx network/proxy.
Cloudflare headers must not be trusted merely because a client supplied the
header name.

## Test-only auth instance

Create a static test-only Better Auth configuration with `testUtils()` and the
organization plugin.

Do not conditionally append `testUtils()` to production plugins. Do not export
it from the production package or mount test routes.

Add an import-graph/container assertion proving production code does not include
the test instance or test-utils package path.

## UI dependency

Backend auth can be implemented before v3 UI. The following remain UI-blocked:

- Google/GitHub provider buttons and official marks
- Loading, provider unavailable, callback error, and expired-session screens
- Workspace selector
- Session menu and profile screens
- OAuth consent and MCP workspace-selection pages

Do not claim the auth milestone is complete until those browser paths pass after
v3 implementation.

## Expected tests

### Configuration and route tests

- `/api/auth/ok` succeeds from the compiled container.
- Email/password sign-up/sign-in endpoints are unavailable.
- Only Google and GitHub providers are configured.
- Generated authorization URLs contain exact callback, state, PKCE, and minimal
  scopes.
- Untrusted origins and callback URLs fail.
- Missing/mismatched OAuth state fails safely.
- Cookie attributes are correct in production and local test modes.

### Provider callback tests

PR CI does not call live Google/GitHub. Use controlled fetch interception or
provider fixtures to test:

- Google issuer/audience/signature and verified email
- GitHub private primary verified email resolution
- Missing/unverified email rejection
- `access_denied` and provider-error mapping
- Existing account sign-in
- Explicit account linking
- Implicit same-email linking rejection

A staging smoke test with dedicated provider credentials is separate from PR CI.

### Workspace tests

- First successful sign-in creates one user, provider account, session, personal
  organization, owner member, and mapping.
- Session has the personal workspace active.
- Concurrent/retried callbacks still create one workspace.
- Existing sign-in does not create another workspace.
- Partial provisioning states heal idempotently.
- Owner/admin/member matrix matches policy.
- Last owner cannot be removed or leave without transfer.
- Organization deletion is unavailable.
- Client-supplied workspace ID cannot access another workspace.
- Removed membership is rejected even if the session still names that workspace.

### Superadmin tests

- Workspace roles cannot call system routes.
- Superadmin grant and revocation are audited.
- Revocation takes effect without waiting for session expiry.
- Email/provider profile cannot self-assign the role.
- Stale session is rejected for configured high-risk actions.

### Production graph tests

- Production auth context has no `ctx.test`.
- Production import graph contains no test auth module.
- Compiled image repeats the assertion.

## Completion gate

Backend auth is ready for dependent phases when:

- Schema drift is zero after reviewed migrations.
- Compiled production handler passes OAuth/session/workspace integration tests.
- Personal workspace provisioning is idempotent under concurrency.
- Workspace and system role boundaries are enforced server-side.
- OAuth-only behavior and secure proxy/cookie assumptions are demonstrated.

The full user-facing auth milestone remains incomplete until Wave 4 browser
tests pass.
