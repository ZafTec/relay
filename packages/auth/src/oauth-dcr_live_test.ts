import { assert, assertEquals } from "@std/assert";
import {
  discoverAuthorizationServerMetadata,
  registerClient,
} from "@modelcontextprotocol/client";
import { createDatabasePool } from "@relay/database";
import pg from "pg";
import { createTestAuth, withTestAuthContext } from "./test-utils.ts";
import {
  authorizeMcpAccessTokenClaims,
  RELAY_ADMIN_SESSION_CLAIM,
  RELAY_CONSENT_CLAIM,
  RELAY_WORKSPACE_ID_CLAIM,
} from "./oauth.ts";
import { createPostgresSuperadminAccessService } from "../../../apps/api/src/routes/admin_access.ts";
import { listMcpConnections, revokeMcpConnection } from "./connections.ts";

const databaseUrl = Deno.env.get("DATABASE_URL");
const ownerUrl = Deno.env.get("AUTH_SECURITY_TEST_DATABASE_URL");

Deno.test({
  name:
    "automatic MCP registration selects workspace and permissions and binds admin access to the consenting session",
  ignore: !databaseUrl || !ownerUrl,
  fn: async () => {
    const pool = createDatabasePool({
      url: new URL(databaseUrl!),
      poolMax: 4,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 30000,
    }, "relay-api");
    const owner = new pg.Client({ connectionString: ownerUrl });
    await owner.connect();
    const auth = createTestAuth(pool);
    const clients: string[] = [];
    const users: string[] = [];
    let requestCount = 0;
    const fetchFn: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      // Independent local fixture addresses prevent unrelated rate buckets colliding.
      headers.set("x-relay-client-ip", `192.0.2.${++requestCount % 250 + 1}`);
      return auth.handler(new Request(request, { headers }));
    };
    const call = (path: string, headers = new Headers(), body?: unknown) => {
      const requestHeaders = new Headers(headers);
      requestHeaders.set("origin", "http://localhost:8000");
      if (body !== undefined) {
        requestHeaders.set("content-type", "application/json");
      }
      return fetchFn(`http://localhost:8000/api/auth/oauth2/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: requestHeaders,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    const redirect = async (response: Response) => {
      const location = response.headers.get("location");
      const body = location ? null : await response.json();
      const target = location ?? body?.url ?? body?.redirect_uri;
      assert(
        typeof target === "string",
        `Expected OAuth redirect, received ${response.status}`,
      );
      return new URL(target, "http://localhost:8000");
    };
    try {
      await owner.query("set role relay_owner");
      const createUser = async (admin: boolean) => {
        const user = await withTestAuthContext(
          auth,
          (test) =>
            test.saveUser(
              test.createUser({
                email: `dcr-${crypto.randomUUID()}@example.test`,
                name: "MCP connector fixture",
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
        const current = await auth.api.getSession({ headers: login.headers });
        assert(current);
        return {
          id: user.id,
          headers: login.headers,
          sessionId: current.session.id,
          workspaceId: (current.session as typeof current.session & {
            activeOrganizationId: string;
          }).activeOrganizationId,
        };
      };
      const admin = await createUser(true);
      const member = await createUser(false);
      const issuer = "http://localhost:8000/api/auth";
      const metadata = await discoverAuthorizationServerMetadata(issuer, {
        fetchFn,
      });
      assert(metadata);
      assertEquals(metadata.registration_endpoint, `${issuer}/oauth2/register`);
      const client = await registerClient(issuer, {
        metadata,
        fetchFn,
        clientMetadata: {
          client_name: "Automatic local agent",
          redirect_uris: ["http://localhost:4321/callback"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
      });
      clients.push(client.client_id);
      assertEquals(client.token_endpoint_auth_method, "none");
      assertEquals(client.client_secret, undefined);
      const confidential = await registerClient(issuer, {
        metadata,
        fetchFn,
        clientMetadata: {
          client_name: "Confidential local agent",
          redirect_uris: ["https://agent.example.test/callback"],
          token_endpoint_auth_method: "client_secret_post",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        },
      });
      clients.push(confidential.client_id);
      assert(typeof confidential.client_secret === "string");
      const stored = await pool.query<
        {
          userId: string | null;
          requirePKCE: boolean;
          skipConsent: boolean | null;
        }
      >(
        'select "userId", "requirePKCE", "skipConsent" from auth."oauthClient" where "clientId"=$1',
        [client.client_id],
      );
      assertEquals(stored.rows[0].userId, null);
      // Better Auth treats an unset stored flag as require-PKCE.
      assertEquals(stored.rows[0].requirePKCE === false, false);
      assertEquals(stored.rows[0].skipConsent === true, false);
      for (
        const invalid of [
          { redirect_uris: ["https://*.example.test/callback"] },
          { redirect_uris: ["http://192.168.1.5/callback"] },
          {
            redirect_uris: ["https://agent.example.test/callback"],
            skip_consent: true,
          },
          {
            redirect_uris: ["https://agent.example.test/callback"],
            jwks_uri: "http://127.0.0.1/secret",
          },
        ]
      ) {
        assertEquals(
          (await call("register", new Headers(), invalid)).status,
          400,
        );
      }

      const verifier = "test-dcr-verifier-" + "x".repeat(50);
      const challenge = btoa(
        String.fromCharCode(
          ...new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(verifier),
            ),
          ),
        ),
      ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
      const resource = "http://localhost:8000/mcp";
      const baseQuery = {
        client_id: client.client_id,
        redirect_uri: client.redirect_uris[0],
        response_type: "code",
        resource,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "connector-test-state",
        prompt: "consent",
      };
      assertEquals(
        (await call(
          `authorize?${new URLSearchParams({
            ...baseQuery,
            code_challenge_method: "plain",
          })}`,
        )).status,
        400,
      );
      const login = await redirect(
        await call(
          `authorize?${new URLSearchParams({
            ...baseQuery,
            scope: "openid tools:read",
          })}`,
        ),
      );
      assertEquals(login.pathname, "/sign-in");

      const flow = async (
        user: typeof admin,
        requested: string | undefined,
        accepted: string | false,
      ) => {
        const query = new URLSearchParams({
          ...baseQuery,
          ...(requested === undefined ? {} : { scope: requested }),
        });
        const choice = await redirect(
          await call(`authorize?${query}`, user.headers),
        );
        // A pre-existing personal workspace must not skip the choice screen.
        assertEquals(
          choice.pathname,
          "/oauth/workspace",
          `${choice.searchParams.get("error")} ${
            choice.searchParams.get("error_description")
          }`,
        );
        if (requested === undefined) {
          assertEquals(
            choice.searchParams.get("scope")?.includes("admin:"),
            false,
          );
        }
        const consent = await redirect(
          await call("continue", user.headers, {
            postLogin: true,
            oauth_query: choice.search.slice(1),
          }),
        );
        assertEquals(consent.pathname, "/oauth/consent");
        const response = await call("consent", user.headers, {
          accept: accepted !== false,
          ...(accepted === false ? {} : { scope: accepted }),
          oauth_query: consent.search.slice(1),
        });
        const callback = await redirect(response);
        if (accepted === false) {
          assertEquals(callback.searchParams.get("error"), "access_denied");
          assertEquals(callback.searchParams.get("code"), null);
          return null;
        }
        assertEquals(
          callback.searchParams.get("state"),
          "connector-test-state",
        );
        const code = callback.searchParams.get("code");
        assert(code);
        return await fetchFn(`${issuer}/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: client.client_id,
            code,
            code_verifier: verifier,
            redirect_uri: client.redirect_uris[0],
            resource,
          }),
        });
      };
      const reduced = await flow(
        member,
        "openid tools:read tools:execute artifacts:share",
        "openid tools:read",
      );
      assertEquals(reduced?.status, 200);
      const reducedTokens = await reduced!.json();
      const decodeClaims = (token: string) =>
        JSON.parse(
          atob(token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/")),
        );
      const oldClaims = decodeClaims(reducedTokens.access_token);
      const connected = await listMcpConnections(pool, member.sessionId);
      assertEquals(connected.length, 1);
      assertEquals(connected[0].clientId, client.client_id);
      assertEquals(connected[0].name, "Automatic local agent");
      assertEquals(oldClaims[RELAY_CONSENT_CLAIM], connected[0].id);
      assert(await authorizeMcpAccessTokenClaims(pool, resource, oldClaims));
      await revokeMcpConnection(pool, admin.sessionId, connected[0].id);
      assert(await authorizeMcpAccessTokenClaims(pool, resource, oldClaims));
      await revokeMcpConnection(pool, member.sessionId, connected[0].id);
      await revokeMcpConnection(pool, member.sessionId, connected[0].id);
      assertEquals(await listMcpConnections(pool, member.sessionId), []);
      assertEquals(
        await authorizeMcpAccessTokenClaims(pool, resource, oldClaims),
        null,
      );
      assertEquals(
        new Set(reducedTokens.scope.split(" ")),
        new Set(["tools:read"]),
      );
      await flow(member, "openid tools:read", false);
      const defaultScopes = await flow(member, undefined, "openid tools:read");
      assertEquals(defaultScopes?.status, 200);
      const reconnected = decodeClaims(
        (await defaultScopes!.json()).access_token,
      );
      assert(await authorizeMcpAccessTokenClaims(pool, resource, reconnected));
      assertEquals(
        await authorizeMcpAccessTokenClaims(pool, resource, oldClaims),
        null,
      );
      const legacyClaims = { ...oldClaims };
      delete legacyClaims[RELAY_CONSENT_CLAIM];
      assertEquals(
        await authorizeMcpAccessTokenClaims(pool, resource, legacyClaims),
        null,
      );
      const unauthorizedAdmin = await flow(
        member,
        "openid admin:allowances:read",
        "openid admin:allowances:read",
      );
      assertEquals(unauthorizedAdmin?.status, 403);

      const adminResult = await flow(
        admin,
        "openid offline_access tools:read admin:allowances:read",
        "openid offline_access tools:read admin:allowances:read",
      );
      assertEquals(adminResult?.status, 200);
      const adminTokens = await adminResult!.json();
      const claims = JSON.parse(
        atob(
          adminTokens.access_token.split(".")[1].replaceAll("-", "+")
            .replaceAll("_", "/"),
        ),
      );
      assertEquals(claims[RELAY_ADMIN_SESSION_CLAIM], admin.sessionId);
      assertEquals(claims[RELAY_WORKSPACE_ID_CLAIM], admin.workspaceId);
      assertEquals(
        (await authorizeMcpAccessTokenClaims(pool, resource, claims))
          ?.adminSessionId,
        admin.sessionId,
      );

      // A stale but valid session may read the admin gate and owned client list.
      const access = createPostgresSuperadminAccessService(pool);
      await owner.query(
        "update auth.session set \"createdAt\"=now()-interval '20 minutes' where id=$1",
        [admin.sessionId],
      );
      assertEquals(await access.access(admin.sessionId), true);
      assertEquals((await call("get-clients", admin.headers)).status, 200);
      assertEquals(
        (await call("create-client", admin.headers, {
          client_name: "Stale manual client",
          redirect_uris: ["https://agent.example.test/callback"],
        })).status,
        403,
      );
      await owner.query(
        "update relay.system_role_assignments set revoked_at=now(),revoked_by=user_id where user_id=$1 and revoked_at is null",
        [admin.id],
      );
      assertEquals(await access.access(admin.sessionId), false);
      assertEquals(
        await authorizeMcpAccessTokenClaims(pool, resource, claims),
        null,
      );
      // Losing the platform role revokes admin tokens, but personal OAuth
      // clients remain manageable through the ordinary session boundary.
      assertEquals((await call("get-clients", admin.headers)).status, 200);
      const revokedRefresh = await fetchFn(`${issuer}/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: client.client_id,
          refresh_token: adminTokens.refresh_token,
          resource,
        }),
      });
      assertEquals(revokedRefresh.status, 403);
    } finally {
      if (clients.length) {
        await owner.query(
          'delete from auth."oauthClient" where "clientId"=any($1::text[])',
          [clients],
        );
      }
      if (users.length) {
        await owner.query(
          "update relay.system_role_assignments set revoked_at=now(),revoked_by=user_id where user_id=any($1::text[]) and revoked_at is null",
          [users],
        );
        await owner.query(
          'delete from auth.session where "userId"=any($1::text[])',
          [users],
        );
      }
      await owner.end();
      await pool.end();
    }
  },
});
