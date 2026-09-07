# Workspace allowance management

The superadmin dashboard at `/admin/allowances` manages explicit MVP execution
grants. Better Auth supplies the authenticated session and workspace membership;
Relay supplies the current superadmin role, metering ledger, and audit history.
Workspace owners cannot grant themselves usage.

## First setup

1. Apply migrations with the deployment migrator account. Migration
   `0002_allowance_management` adds the audited management function and removes
   direct application-role inserts into entitlement grants. It does not assign
   allowances or reset recorded usage.
2. Sign in through Google or GitHub. If the installation has no superadmin yet,
   use the existing one-time `relay admin bootstrap-superadmin` command from the
   deployment environment with `DATABASE_URL` for `relay_migrator`, the existing
   user's immutable ID in `RELAY_BOOTSTRAP_USER_ID`, and a unique 16–128 character
   `RELAY_BOOTSTRAP_IDEMPOTENCY_KEY`. See the
   [superadmin boundary](implementation-handoff/03-auth-workspaces.md#system-superadmin).
   Keep migrator credentials out of the API and web runtime.
3. Sign in again and open **Superadmin → Allowances**. Reads and changes require
   a session created within the last 15 minutes and a current superadmin role.
4. Search by workspace name, memorable slug, exact ID, or owner name/email, then
   select the target workspace.
   This is a platform operation; the user's active workspace is not the target.

## Assign an allowance

Add each intended grant explicitly:

| Grant | Operator choice | Effect |
| --- | --- | --- |
| Execution access | Enabled | Allows new tool admissions when their metric allowance is available |
| Images per month | Whole-number amount or confirmed unlimited | Shared by both image tools and all workspace members |
| OCR requests per month | Whole-number amount or confirmed unlimited | One request per OCR run |

Choose immediate effect or a start date, no expiry or an end date, and record a
reason. Dates entered in the browser use the operator's local timezone. Monthly
usage periods reset at midnight UTC on the first of each month; they are not
rolling 30-day windows. No default production quota is supplied by the UI.

Finite active grants **add together**. For example, an active grant of 20 images
and another of 5 produce a total allowance of 25, including images already used
or reserved that month. Any active unlimited grant makes that metric unlimited.
Zero is an explicit finite allowance with no additional available usage.

Execution access alone does not grant image or OCR usage. A metric grant alone
does not grant execution access. Missing, expired, or exhausted allowances block
new admission before a provider call.

## Change or revoke an allowance

Use **Revoke** on the relevant grant, enter a reason, and confirm. To lower or
replace a limit, revoke the previous grant before adding its replacement. This
can temporarily block new runs between the two actions. To increase an allowance,
add only the intended increment or revoke and replace the old grant.

Revocation takes effect immediately for new reservations. Accepted runs retain
their original reservations and can finish; this is not a run-cancellation
control. Used and reserved amounts are preserved, even if a reduced allowance
falls below them. The available amount then displays zero.

Grant history includes scheduled, expired, and revoked grants. Audit history
records each successful change with the operator, reason, and grant ID. Older
entries can be loaded on either list. Legacy grants remain visible; this workflow
does not silently revoke or reconcile grants from earlier database baselines.

## Interrupted requests

The browser saves the exact request and its idempotency key in session storage
before sending it. If the connection fails, use **Retry saved request**. The same
key confirms the original result without adding another grant. The saved request
survives page reload and reauthentication in that browser tab. Do not clear tab
storage or close the tab while an outcome is unresolved; inspect grant/audit
history first if the saved request is lost.

The API derives the operator from the Better Auth session, checks the trusted
browser origin, and applies authorization again inside PostgreSQL. Grant writes,
audit events, and replay records commit together. New admission shares a
workspace lock with grant changes so requests waiting behind revocation cannot
reserve against the prior allowance.

Usage grants are independent of provider capacity, scheduling, prices, billing,
storage quotas, and release/deployment readiness.
