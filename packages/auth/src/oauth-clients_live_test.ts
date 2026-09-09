import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import { createDatabasePool } from "@relay/database";
import pg from "pg";
import { createTestAuth, withTestAuthContext } from "./test-utils.ts";
import { requireMcpAuth } from "@better-auth/mcp";
import { authorizeMcpAccessTokenClaims } from "./oauth.ts";
import { createMcpOAuthClientManager } from "./oauth-management.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const ownerUrl = Deno.env.get("AUTH_SECURITY_TEST_DATABASE_URL");
Deno.test({
  name:
    "native OAuth client creation, secret rotation, ownership and deletion are audited without secrets",
  ignore: !databaseUrl || !ownerUrl,
  fn: async () => {
    const pool = createDatabasePool({
      url: new URL(databaseUrl!),
      poolMax: 2,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 30000,
    }, "relay-api");
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const auth = createTestAuth(pool);
    const users: string[] = [];
    let jwksServer: Deno.HttpServer | undefined;
    try {
      await owner.query("set role relay_owner");
      const user = async (admin: boolean) => {
        const user = await withTestAuthContext(
          auth,
          (test) =>
            test.saveUser(
              test.createUser({
                email: `oauth-${crypto.randomUUID()}@example.test`,
                name: "OAuth fixture",
                emailVerified: true,
              }),
            ),
        );
        users.push(user.id);
        if (admin) {
          await owner.query(
            "insert into relay.system_role_assignments(user_id,role,granted_by) values($1,'superadmin',$1)",
            [user.id],
          );
        }
        const login = await withTestAuthContext(
          auth,
          (test) => test.login({ userId: user.id }),
        );
        return { ...login, id: user.id };
      };
      const admin = await user(true);
      const other = await user(true);
      const member = await user(false);
      const payload = {
        client_name: "Local test agent",
        redirect_uris: ["https://agent.example.test/callback"],
        scope: "openid offline_access tools:read",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      };
      const management = createMcpOAuthClientManager(pool, auth);
      const operator = await auth.api.getSession({ headers: admin.headers });
      assert(operator);
      const operatorSession = operator.session.id;
      // More simultaneous writes than pool slots must not deadlock while the
      // authorization lock and native Better Auth transaction use the pool.
      const concurrent = await Promise.all([1, 2, 3].map((number) =>
        management(
          operatorSession,
          admin.id,
          "create",
          { ...payload, client_name: `Concurrent fixture ${number}` },
        )
      )) as Array<{ client_id: string }>;
      assertEquals(
        new Set(concurrent.map((client) => client.client_id)).size,
        3,
      );
      await Promise.all(
        concurrent.map((client) =>
          management(operatorSession, admin.id, "delete", {
            client_id: client.client_id,
          })
        ),
      );
      const managed = await management(
        operatorSession,
        admin.id,
        "create",
        payload,
      ) as { client_id: string; client_secret: string };
      assert(typeof managed.client_secret === "string");
      const ownClients = await management(
        operatorSession,
        admin.id,
        "list",
        {},
      ) as Array<Record<string, unknown>>;
      assert(ownClients.some((item) => item.client_id === managed.client_id));
      assert(
        ownClients.every((item) =>
          !("client_secret" in item) && !("user_id" in item)
        ),
      );
      const got = await management(operatorSession, admin.id, "get", {
        client_id: managed.client_id,
      }) as Record<string, unknown>;
      assertEquals(got.client_id, managed.client_id);
      assertEquals("client_secret" in got, false);
      await management(operatorSession, admin.id, "update", {
        client_id: managed.client_id,
        client_name: "Renamed MCP client",
      });
      assertEquals(
        (await management(operatorSession, admin.id, "get", {
          client_id: managed.client_id,
        }) as Record<string, unknown>).client_name,
        "Renamed MCP client",
      );
      await assertRejects(() =>
        management(operatorSession, admin.id, "update", {
          client_id: managed.client_id,
          redirect_uris: ["https://*.example.test/callback"],
        })
      );
      const changedSecret = await management(
        operatorSession,
        admin.id,
        "rotate",
        { client_id: managed.client_id },
      ) as { client_secret: string };
      assert(typeof changedSecret.client_secret === "string");
      assertNotEquals(changedSecret.client_secret, managed.client_secret);
      await assertRejects(() =>
        management(operatorSession, other.id, "get", {
          client_id: managed.client_id,
        })
      );
      const otherSession = await auth.api.getSession({
        headers: other.headers,
      });
      assert(otherSession);
      await assertRejects(() =>
        management(otherSession.session.id, other.id, "delete", {
          client_id: managed.client_id,
        })
      );
      const memberSession = await auth.api.getSession({
        headers: member.headers,
      });
      assert(memberSession);
      await assertRejects(() =>
        management(memberSession.session.id, member.id, "list", {})
      );
      await management(operatorSession, admin.id, "delete", {
        client_id: managed.client_id,
      });
      assertEquals(
        (await pool.query(
          'select 1 from auth."oauthClient" where "clientId"=$1',
          [managed.client_id],
        )).rows.length,
        0,
      );
      assertEquals(
        (await pool.query<{ action: string }>(
          "select action from relay.audit_events where target_type='oauth_client' and target_id=$1 order by id",
          [managed.client_id],
        )).rows.map((row: { action: string }) => row.action),
        [
          "oauth_client.create",
          "oauth_client.update",
          "oauth_client.rotate_secret",
          "oauth_client.delete",
        ],
      );
      const call = async (path: string, headers: Headers, body?: unknown) => {
        const requestHeaders = new Headers(headers);
        requestHeaders.set("origin", "http://localhost:8000");
        if (body !== undefined) {
          requestHeaders.set("content-type", "application/json");
        }
        return await auth.handler(
          new Request(`http://localhost:8000/api/auth/oauth2/${path}`, {
            method: body === undefined ? "GET" : "POST",
            headers: requestHeaders,
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      };
      // Exercise the actual native HTTP endpoints used by the dashboard with
      // a non-superadmin session, including their ownership boundary.
      const memberCreated = await call(
        "create-client",
        member.headers,
        payload,
      );
      assertEquals(memberCreated.status, 201);
      const memberClient = await memberCreated.json();
      assert(typeof memberClient.client_secret === "string");
      const memberList = await call("get-clients", member.headers);
      assertEquals(memberList.status, 200);
      assertEquals(
        (await memberList.json()).map((item: { client_id: string }) =>
          item.client_id
        ),
        [memberClient.client_id],
      );
      assertEquals(
        (await (await call("get-clients", admin.headers)).json()).length,
        0,
      );
      assertEquals(
        (await call(
          `get-client?client_id=${memberClient.client_id}`,
          member.headers,
        )).status,
        200,
      );
      for (const headers of [admin.headers, other.headers]) {
        assertEquals(
          (await call(
            `get-client?client_id=${memberClient.client_id}`,
            headers,
          )).status,
          401,
        );
        for (
          const path of [
            "delete-client",
            "client/rotate-secret",
            "update-client",
          ]
        ) {
          assertEquals(
            (await call(path, headers, {
              client_id: memberClient.client_id,
              ...(path === "update-client"
                ? { update: { client_name: "Foreign edit" } }
                : {}),
            })).status,
            401,
          );
        }
      }
      assertEquals(
        (await call("update-client", member.headers, {
          client_id: memberClient.client_id,
          update: { client_name: "Member-owned client" },
        })).status,
        200,
      );
      const memberRotation = await call(
        "client/rotate-secret",
        member.headers,
        {
          client_id: memberClient.client_id,
        },
      );
      assertEquals(memberRotation.status, 200);
      assertNotEquals(
        (await memberRotation.json()).client_secret,
        memberClient.client_secret,
      );
      assertEquals(
        (await call("delete-client", member.headers, {
          client_id: memberClient.client_id,
        })).status,
        200,
      );
      assertEquals((await call("get-clients", new Headers())).status, 401);
      const created = await call("create-client", admin.headers, payload);
      assertEquals(created.status, 201);
      const client = await created.json();
      assert(typeof client.client_secret === "string");
      assert(typeof client.client_id === "string");
      const workspaceId = `oauth-workspace-${crypto.randomUUID()}`;
      await pool.query(
        "insert into auth.organization(id,name,slug,\"createdAt\") values($1,'OAuth fixture',$1,now())",
        [workspaceId],
      );
      await pool.query(
        'insert into auth.member(id,"organizationId","userId",role,"createdAt") values($1,$2,$3,\'owner\',now())',
        [crypto.randomUUID(), workspaceId, admin.id],
      );
      const resource = "http://localhost:8000/mcp";
      const verifier = "local-pkce-" + "x".repeat(50);
      const challengeBytes = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      );
      const challenge = btoa(String.fromCharCode(...challengeBytes)).replaceAll(
        "+",
        "-",
      ).replaceAll("/", "_").replaceAll("=", "");
      const query = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: payload.redirect_uris[0],
        response_type: "code",
        scope: payload.scope,
        resource,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "local-state",
      });
      await pool.query(
        'update auth.session set "activeOrganizationId"=null where "userId"=$1',
        [admin.id],
      );
      const redirect = async (response: Response): Promise<URL> => {
        const location = response.headers.get("location");
        const body = location ? null : await response.json();
        const target = location ?? body?.url ?? body?.redirect_uri;
        assert(
          typeof target === "string",
          `OAuth redirect missing at status ${response.status}`,
        );
        return new URL(target, "http://localhost:8000");
      };
      const workspaceRedirect = await redirect(
        await call(`authorize?${query}`, admin.headers),
      );
      assertEquals(workspaceRedirect.pathname, "/oauth/workspace");
      await pool.query(
        'update auth.session set "activeOrganizationId"=$1 where "userId"=$2',
        [workspaceId, admin.id],
      );
      const consentRedirect = await redirect(
        await call("continue", admin.headers, {
          postLogin: true,
          oauth_query: workspaceRedirect.search.slice(1),
        }),
      );
      assertEquals(consentRedirect.pathname, "/oauth/consent");
      const callback = await redirect(
        await call("consent", admin.headers, {
          accept: true,
          oauth_query: consentRedirect.search.slice(1),
        }),
      );
      assertEquals(callback.origin, new URL(payload.redirect_uris[0]).origin);
      assertEquals(callback.searchParams.get("state"), "local-state");
      const code = callback.searchParams.get("code");
      assert(code);
      const token = async (body: Record<string, string>) => {
        return await auth.handler(
          new Request("http://localhost:8000/api/auth/oauth2/token", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(body),
          }),
        );
      };
      const exchanged = await token({
        grant_type: "authorization_code",
        client_id: client.client_id,
        client_secret: client.client_secret,
        code,
        code_verifier: verifier,
        redirect_uri: payload.redirect_uris[0],
        resource,
      });
      assertEquals(exchanged.status, 200);
      const tokens = await exchanged.json();
      assert(typeof tokens.access_token === "string");
      assert(typeof tokens.refresh_token === "string");
      jwksServer = Deno.serve(
        { hostname: "127.0.0.1", port: 0, onListen: () => {} },
        (request) =>
          auth.handler(
            new Request(
              `http://localhost:8000${new URL(request.url).pathname}`,
              request,
            ),
          ),
      );
      const protectedMcp = requireMcpAuth(auth, async (_request, claims) => {
        const principal = await authorizeMcpAccessTokenClaims(
          pool,
          resource,
          claims,
        );
        return principal
          ? Response.json(principal)
          : new Response(null, { status: 403 });
      }, {
        resource,
        jwksUrl: `http://127.0.0.1:${
          (jwksServer.addr as Deno.NetAddr).port
        }/api/auth/jwks`,
      });
      const requestMcp = () =>
        protectedMcp(
          new Request(resource, {
            headers: { authorization: `Bearer ${tokens.access_token}` },
          }),
        );
      const protectedResult = await requestMcp();
      assertEquals(protectedResult.status, 200);
      assertEquals((await protectedResult.json()).workspaceId, workspaceId);
      const secret = await pool.query(
        'select "clientSecret" from auth."oauthClient" where "clientId"=$1',
        [client.client_id],
      );
      assertNotEquals(secret.rows[0].clientSecret, client.client_secret);
      const listed = await (await call("get-clients", admin.headers)).json();
      assertEquals(listed.length, 1);
      assertEquals(listed[0].client_id, client.client_id);
      assertEquals(
        JSON.stringify(listed).includes(client.client_secret),
        false,
      );
      assertEquals(
        JSON.stringify(listed).includes(secret.rows[0].clientSecret),
        false,
      );
      assertEquals(
        (await (await call("get-clients", other.headers)).json()).length,
        0,
      );
      const foreignDelete = await call("delete-client", other.headers, {
        client_id: client.client_id,
      });
      assert(
        [400, 401, 403, 404].includes(foreignDelete.status),
        `Foreign deletion returned ${foreignDelete.status}`,
      );
      const rotation = await call("client/rotate-secret", admin.headers, {
        client_id: client.client_id,
      });
      assertEquals(rotation.status, 200);
      const rotated = await rotation.json();
      assert(typeof rotated.client_secret === "string");
      assertNotEquals(rotated.client_secret, client.client_secret);
      const rejectedSecret = await token({
        grant_type: "refresh_token",
        client_id: client.client_id,
        client_secret: client.client_secret,
        refresh_token: tokens.refresh_token,
        resource,
      });
      assert([400, 401].includes(rejectedSecret.status));
      assertEquals((await rejectedSecret.json()).error, "invalid_client");
      const refreshed = await token({
        grant_type: "refresh_token",
        client_id: client.client_id,
        client_secret: rotated.client_secret,
        refresh_token: tokens.refresh_token,
        resource,
      });
      assertEquals(refreshed.status, 200);
      assertEquals(
        (await call("delete-client", admin.headers, {
          client_id: client.client_id,
        })).status,
        200,
      );
      assertEquals(
        (await pool.query(
          'select 1 from auth."oauthClient" where "clientId"=$1',
          [client.client_id],
        )).rows.length,
        0,
      );
      assertEquals((await requestMcp()).status, 403);
      const audit = await pool.query<{ action: string }>(
        "select action from relay.audit_events where target_type='oauth_client' and target_id=$1 order by id",
        [client.client_id],
      );
      assertEquals(audit.rows.map((row: { action: string }) => row.action), [
        "oauth_client.create",
        "oauth_client.rotate_secret",
        "oauth_client.delete",
      ]);
      await owner.query(
        "update relay.system_role_assignments set revoked_at=now(),revoked_by=user_id where user_id=$1 and revoked_at is null",
        [admin.id],
      );
      assertEquals((await call("get-clients", admin.headers)).status, 200);
      await assertRejects(() =>
        management(operatorSession, admin.id, "list", {})
      );
    } finally {
      await jwksServer?.shutdown();
      if (users.length) {
        await owner.query(
          "update relay.system_role_assignments set revoked_at=now(),revoked_by=user_id where user_id=any($1::text[]) and revoked_at is null",
          [users],
        );
        await owner.query(
          'delete from auth."session" where "userId"=any($1::text[])',
          [
            users,
          ],
        );
      }
      await owner.end();
      await pool.end();
    }
  },
});
