import { assert, assertEquals, assertRejects } from "@std/assert";
import { createAuth } from "@relay/auth";
import { createDatabasePool, sha256Hex } from "@relay/database";
import type {
  AllowanceMutationResult,
  AllowanceSummary,
} from "@relay/metering";
import {
  type RelayMcpAdminContext,
  RelayMcpAdminError,
  type RelayMcpAdminOperation,
} from "@relay/mcp";
import pg from "pg";
import { TEST_AUTH_CONFIG } from "../../../../packages/auth/src/test-utils.ts";
import {
  CANONICAL_SQL as INVITATION_LIST_SQL,
  migration as invitationListingMigration,
} from "../../../../packages/database/src/migrations/0008_superadmin_invitation_listing.ts";
import {
  createPostgresAdminCapacityService,
  createPostgresAdminChangelogService,
} from "../server.ts";
import { createPostgresSuperadminAccessService } from "../routes/admin_access.ts";
import { createPostgresAdminAllowanceService } from "../routes/admin_allowances.ts";
import { createMcpAdminServices } from "./mcp-admin-services.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const ownerUrl = Deno.env.get("AUTH_SECURITY_TEST_DATABASE_URL");

Deno.test("superadmin invitation listing repair retains its canonical checksum", async () => {
  assertEquals(
    await sha256Hex(INVITATION_LIST_SQL),
    invitationListingMigration.checksumSha256,
  );
});

async function fixture() {
  const pool = createDatabasePool({
    url: new URL(databaseUrl!),
    poolMax: 6,
    connectTimeoutMs: 5000,
    statementTimeoutMs: 30000,
  }, "relay-api");
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  await owner.query("set role relay_owner");
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const users = [`mcp-admin-${suffix}`, `mcp-member-${suffix}`];
  const sessions = users.map((id) => `session-${id}`);
  const workspaceId = crypto.randomUUID();
  for (let i = 0; i < users.length; i++) {
    await owner.query(
      'insert into auth."user"(id,name,email,"emailVerified") values($1,$1,$2,true)',
      [users[i], `${users[i]}@example.test`],
    );
    await owner.query(
      'insert into auth.session(id,"userId",token,"expiresAt","createdAt","updatedAt") values($1,$2,$1,now()+interval \'1 day\',now(),now())',
      [sessions[i], users[i]],
    );
  }
  await owner.query(
    "insert into auth.organization(id,name,slug,\"createdAt\") values($1,'MCP test workspace',$2,now())",
    [workspaceId, `mcp-studio-${suffix}`],
  );
  await owner.query(
    'insert into auth.member(id,"organizationId","userId",role,"createdAt") values($1,$2,$3,\'owner\',now())',
    [crypto.randomUUID(), workspaceId, users[1]],
  );
  await owner.query(
    "insert into relay.system_role_assignments(user_id,role,granted_by) values($1,'superadmin',$1)",
    [users[0]],
  );
  const auth = createAuth(pool, TEST_AUTH_CONFIG);
  const services = createMcpAdminServices({
    pool,
    publicOrigin: "http://localhost:8787",
    allowances: createPostgresAdminAllowanceService(pool),
    capacity: createPostgresAdminCapacityService(pool),
    changelog: createPostgresAdminChangelogService(pool),
    superadmins: createPostgresSuperadminAccessService(pool),
    oauth: auth.manageMcpOAuthClient,
  });
  const context = (change = "change"): RelayMcpAdminContext => ({
    sessionId: sessions[0],
    actorUserId: users[0],
    requestId: `req_${suffix}_${change}`,
    idempotencyKey: `mcp-${suffix}-${change}`,
  });
  return {
    pool,
    owner,
    users,
    sessions,
    workspaceId,
    services,
    context,
    async close() {
      await owner.query("begin");
      try {
        for (
          const [table, trigger] of [
            ["entitlement_grants", "entitlement_grants_mutation_guard"],
            [
              "allowance_operation_idempotency",
              "allowance_operation_idempotency_immutable",
            ],
          ]
        ) {
          await owner.query(
            `alter table relay.${table} disable trigger ${trigger}`,
          );
        }
        await owner.query(
          "delete from relay.entitlement_grants where workspace_id=$1",
          [workspaceId],
        );
        await owner.query(
          "delete from relay.allowance_operation_idempotency where operator_user_id=any($1::text[])",
          [users],
        );
        await owner.query(
          "delete from relay.superadmin_invitations where invited_by=any($1::text[])",
          [users],
        );
        await owner.query(
          'delete from auth."oauthClient" where "userId"=any($1::text[])',
          [users],
        );
        await owner.query(
          "delete from relay.audit_events where actor_user_id=any($1::text[])",
          [users],
        );
        await owner.query(
          "delete from relay.system_role_assignments where user_id=any($1::text[])",
          [users],
        );
        await owner.query("delete from auth.organization where id=$1", [
          workspaceId,
        ]);
        await owner.query('delete from auth."user" where id=any($1::text[])', [
          users,
        ]);
        for (
          const [table, trigger] of [
            ["entitlement_grants", "entitlement_grants_mutation_guard"],
            [
              "allowance_operation_idempotency",
              "allowance_operation_idempotency_immutable",
            ],
          ]
        ) {
          await owner.query(
            `alter table relay.${table} enable trigger ${trigger}`,
          );
        }
        await owner.query("commit");
      } catch (error) {
        await owner.query("rollback");
        throw error;
      } finally {
        await owner.end();
        await pool.end();
      }
    },
  };
}

async function rejectsWith(operation: () => Promise<unknown>, code: string) {
  const error = await assertRejects(operation, RelayMcpAdminError);
  assertEquals(error.code, code);
  return error;
}

function grant(workspaceId: string) {
  return {
    workspaceId,
    key: "images.generated",
    mode: "finite",
    amount: "5",
    effectiveAt: null,
    expiresAt: null,
    reason: "Explicit MCP test allowance",
  };
}

Deno.test({
  name:
    "MCP admin bindings recheck live authority, preserve audited grant replay, and never imply execution access",
  ignore: !databaseUrl || !ownerUrl,
  fn: async () => {
    const test = await fixture();
    try {
      const { services, context, owner, pool, users, sessions, workspaceId } =
        test;
      assertEquals(await services.authorize(context()), true);
      assertEquals(
        await services.authorize({ ...context(), actorUserId: users[1] }),
        false,
      );
      assertEquals(
        await services.authorize({
          ...context(),
          sessionId: sessions[1],
          actorUserId: users[1],
        }),
        false,
      );

      const discovery = await services.invoke(
        "allowances.workspaces",
        context(),
        {
          search: `${users[1]}@example.test`,
        },
      ) as { items: { id: string; owner: { email: string } }[] };
      assertEquals(discovery.items.map((item) => item.id), [workspaceId]);
      assertEquals(discovery.items[0].owner.email, `${users[1]}@example.test`);

      const change = context("grant");
      const [first, retry] = await Promise.all([
        services.invoke("allowances.grant", change, grant(workspaceId)),
        services.invoke("allowances.grant", change, grant(workspaceId)),
      ]) as AllowanceMutationResult[];
      assertEquals(first.grantId, retry.grantId);
      assertEquals([first.replayed, retry.replayed].sort(), [false, true]);
      const summary = await services.invoke("allowances.get", context(), {
        workspaceId,
      }) as AllowanceSummary;
      assertEquals(summary.executionAllowed, false);
      assertEquals(
        summary.limits.find((limit) => limit.key === "images.generated")
          ?.remaining,
        "5",
      );
      const audits = await pool.query<
        { actor_user_id: string; action: string; request_id: string }
      >(
        "select actor_user_id,action,request_id from relay.audit_events where workspace_id=$1 order by id",
        [workspaceId],
      );
      assertEquals(audits.rows, [{
        actor_user_id: users[0],
        action: "allowance.grant",
        request_id: change.requestId,
      }]);

      await rejectsWith(
        () =>
          services.invoke("allowances.grant", change, {
            ...grant(workspaceId),
            amount: "6",
          }),
        "idempotency_conflict",
      );
      await rejectsWith(
        () =>
          services.invoke("allowances.grant", context("forged"), {
            ...grant(workspaceId),
            actorUserId: users[1],
          }),
        "invalid_request",
      );
      await rejectsWith(
        () =>
          services.invoke("allowances.get", context(), {
            workspaceId: crypto.randomUUID(),
          }),
        "not_found",
      );
      await rejectsWith(
        () =>
          services.invoke("capacity.get", context(), {
            scopeType: "tool",
            scopeId: `missing-${workspaceId}`,
          }),
        "not_found",
      );
      await rejectsWith(
        () =>
          services.invoke("changelog.get", context(), {
            releaseId: "9223372036854775807",
          }),
        "not_found",
      );

      await owner.query(
        "update auth.session set \"createdAt\"=now()-interval '16 minutes' where id=$1",
        [sessions[0]],
      );
      assertEquals(await services.authorize(context()), true);
      await rejectsWith(
        () => services.invoke("allowances.grant", change, grant(workspaceId)),
        "reauthentication_required",
      );
      // Exercise Better Auth's actual SESSION_TOO_OLD body mapping, before its
      // broader FORBIDDEN status can turn freshness into a permission failure.
      await rejectsWith(
        () =>
          services.invoke("oauth.create", context("stale-client"), {
            client_name: "Stale test client",
            redirect_uris: ["https://agent.example.test/callback"],
            scopes: ["tools:read"],
            token_endpoint_auth_method: "none",
          }),
        "reauthentication_required",
      );
      const reads: [RelayMcpAdminOperation, Record<string, unknown>][] = [
        ["allowances.get", { workspaceId }],
        ["capacity.list", {}],
        ["changelog.list", {}],
        ["superadmins.list", {}],
      ];
      for (const [operation, input] of reads) {
        await rejectsWith(
          () => services.invoke(operation, context(), input),
          "reauthentication_required",
        );
      }

      await owner.query(
        'update auth.session set "createdAt"=now() where id=$1',
        [sessions[0]],
      );
      assertEquals(await services.authorize(context()), true);
      // Simulate revocation after the MCP adapter's preliminary authorization.
      // Every real domain service must still reject the call, including replay.
      await owner.query(
        "update relay.system_role_assignments set revoked_at=now(),revoked_by=user_id where user_id=$1 and revoked_at is null",
        [users[0]],
      );
      assertEquals(await services.authorize(context()), false);
      for (
        const [operation, input] of [...reads, ["oauth.list", {}]] as [
          RelayMcpAdminOperation,
          Record<string, unknown>,
        ][]
      ) {
        await rejectsWith(
          () => services.invoke(operation, context(), input),
          "authorization_denied",
        );
      }
      await rejectsWith(
        () => services.invoke("allowances.grant", change, grant(workspaceId)),
        "authorization_denied",
      );
      assertEquals(
        (await pool.query(
          "select id from relay.entitlement_grants where workspace_id=$1",
          [workspaceId],
        )).rowCount,
        1,
      );

      await owner.query(
        "update auth.session set \"expiresAt\"=now()-interval '1 second' where id=$1",
        [sessions[0]],
      );
      assertEquals(await services.authorize(context()), false);
      await rejectsWith(
        () => services.invoke("allowances.get", context(), { workspaceId }),
        "reauthentication_required",
      );
      await owner.query(
        'update auth."user" set "emailVerified"=false where id=$1',
        [users[1]],
      );
      assertEquals(
        await services.authorize({
          ...context(),
          sessionId: sessions[1],
          actorUserId: users[1],
        }),
        false,
      );
    } finally {
      await test.close();
    }
  },
});

Deno.test({
  name:
    "MCP superadmin invitation bindings normalize addresses, audit once, replay safely, and send no email",
  ignore: !databaseUrl || !ownerUrl,
  fn: async () => {
    const test = await fixture();
    try {
      const { services, context, owner, users } = test;
      const create = context("invite");
      const email = `${users[1]}@example.test`;
      const receipt = await services.invoke("superadmins.invite", create, {
        email: email.toUpperCase(),
      }) as {
        invitation: { id: string; email: string; revokedAt: string | null };
        url: string;
      };
      const invitation = receipt.invitation;
      assertEquals(invitation.email, email);
      assert(/^sinv_[0-9a-f]{32}$/.test(invitation.id));
      assertEquals(invitation.revokedAt, null);
      assertEquals(
        receipt.url,
        `http://localhost:8787/superadmin-invitations/${invitation.id}`,
      );
      assertEquals(
        await services.invoke("superadmins.invite", create, { email }),
        receipt,
      );
      const sameRecipient = await services.invoke(
        "superadmins.invite",
        context("same-recipient"),
        { email },
      ) as typeof receipt;
      assertEquals(sameRecipient.invitation.id, invitation.id);
      assertEquals(sameRecipient.url, receipt.url);
      await rejectsWith(
        () =>
          services.invoke("superadmins.invite", create, {
            email: `different-${email}`,
          }),
        "idempotency_conflict",
      );
      assertEquals(
        (await owner.query(
          "select id from relay.system_role_assignments where user_id=$1",
          [users[1]],
        )).rowCount,
        0,
      );
      const listing = await services.invoke(
        "superadmins.list",
        context(),
        {},
      ) as { invitations: { id: string }[] };
      assert(listing.invitations.some((item) => item.id === invitation.id));
      assertEquals(
        await services.invoke(
          "superadmins.revoke_invitation",
          context("revoke-invite"),
          { invitationId: invitation.id },
        ),
        "revoked",
      );
      assertEquals(
        await services.invoke(
          "superadmins.revoke_invitation",
          context("revoke-invite"),
          { invitationId: invitation.id },
        ),
        "replayed",
      );
      const replay = await services.invoke("superadmins.invite", create, {
        email,
      }) as typeof receipt;
      assert(replay.invitation.revokedAt !== null);
      assertEquals(
        (await owner.query<{ action: string; actor_user_id: string }>(
          "select action,actor_user_id from relay.audit_events where target_id=$1 order by id",
          [invitation.id],
        )).rows,
        [
          { action: "system_role.invitation.create", actor_user_id: users[0] },
          { action: "system_role.invitation.revoke", actor_user_id: users[0] },
        ],
      );
      // This service graph has no SMTP sender; creation only persists an
      // invitation that the recipient must accept while signed in.
    } finally {
      await test.close();
    }
  },
});

Deno.test({
  name:
    "MCP OAuth bindings adapt scopes and flat updates to native audited client management",
  ignore: !databaseUrl || !ownerUrl,
  fn: async () => {
    const test = await fixture();
    try {
      const { services, context, pool, owner, users, sessions } = test;
      const created = await services.invoke(
        "oauth.create",
        context("oauth-create"),
        {
          client_name: "MCP binding fixture",
          redirect_uris: ["https://agent.example.test/callback"],
          scopes: ["tools:read", "runs:read"],
          token_endpoint_auth_method: "client_secret_post",
        },
      ) as Record<string, unknown>;
      assert(typeof created.client_id === "string");
      assert(typeof created.client_secret === "string");
      const clientId = created.client_id;
      const read = await services.invoke("oauth.get", context(), {
        client_id: clientId,
      }) as Record<string, unknown>;
      assertEquals(read.client_name, "MCP binding fixture");
      assertEquals(read.scope, "openid offline_access tools:read runs:read");
      assertEquals("user_id" in read || "client_secret" in read, false);
      await services.invoke("oauth.update", context("oauth-update"), {
        client_id: clientId,
        client_name: "Renamed binding fixture",
        redirect_uris: ["https://agent.example.test/changed-callback"],
        scopes: ["tools:read"],
      });
      const updated = await services.invoke("oauth.get", context(), {
        client_id: clientId,
      }) as Record<string, unknown>;
      assertEquals(updated.client_name, "Renamed binding fixture");
      assertEquals(updated.redirect_uris, [
        "https://agent.example.test/changed-callback",
      ]);
      assertEquals(updated.scope, "openid offline_access tools:read");
      await owner.query(
        "insert into relay.system_role_assignments(user_id,role,granted_by) values($1,'superadmin',$2)",
        [users[1], users[0]],
      );
      await rejectsWith(
        () =>
          services.invoke("oauth.delete", {
            ...context("foreign"),
            actorUserId: users[1],
            sessionId: sessions[1],
          }, { client_id: clientId }),
        "authorization_denied",
      );
      await services.invoke("oauth.delete", context("oauth-delete"), {
        client_id: clientId,
      });
      assertEquals(
        (await pool.query(
          'select id from auth."oauthClient" where "clientId"=$1',
          [clientId],
        )).rowCount,
        0,
      );
      assertEquals(
        (await pool.query<{ action: string }>(
          "select action from relay.audit_events where target_type='oauth_client' and target_id=$1 order by id",
          [clientId],
        )).rows.map((row: { action: string }) => row.action),
        ["oauth_client.create", "oauth_client.update", "oauth_client.delete"],
      );
    } finally {
      await test.close();
    }
  },
});
