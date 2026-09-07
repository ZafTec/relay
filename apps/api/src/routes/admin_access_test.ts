import { assertEquals } from "@std/assert";
import type { Auth } from "@relay/auth";
import { createSuperadminAccessRoutes } from "./admin_access.ts";

const origin = "https://relay.test";
const root = "/api/v1/admin/superadmins";
function fixture(authenticated = true) {
  const calls: unknown[][] = [];
  const invoke = (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve({ ok: true });
  };
  const auth = {
    api: {
      getSession: () =>
        Promise.resolve(
          authenticated
            ? {
              session: { id: "trusted-session" },
              user: { id: "trusted-user" },
            }
            : null,
        ),
    },
  } as unknown as Auth;
  return {
    calls,
    app: createSuperadminAccessRoutes({
      auth,
      allowedOrigins: [origin],
      service: { list: invoke, invite: invoke, revoke: invoke, accept: invoke },
    }),
  };
}
Deno.test("superadmin invitation endpoints require cookies, trusted origin and explicit acceptance", async () => {
  const anonymous = fixture(false);
  assertEquals((await anonymous.app.request(root)).status, 401);
  assertEquals(anonymous.calls, []);
  const { app, calls } = fixture();
  const req = (body: unknown, extra: Record<string, string> = {}) => ({
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "idempotency-key": "invitation-request-001",
      ...extra,
    },
    body: JSON.stringify(body),
  });
  assertEquals(
    (await app.request(
      `${root}/invitations`,
      req({ email: "member@example.test" }, { origin: "https://evil.test" }),
    )).status,
    403,
  );
  assertEquals(
    (await app.request(
      `${root}/invitations`,
      req({ email: "member@example.test", operator: "spoofed" }),
    )).status,
    400,
  );
  assertEquals(calls, []);
  const response = await app.request(
    `${root}/invitations`,
    req({ email: "Member@Example.test" }),
  );
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(calls[0][0], "trusted-session");
  assertEquals(calls[0][2], "member@example.test");
  const path = "/api/v1/superadmin-invitations/sinv_" + "1".repeat(32);
  assertEquals((await app.request(path, req({ accept: false }))).status, 400);
  assertEquals((await app.request(path, req({ accept: true }))).status, 200);
  assertEquals(calls.at(-1), [
    "trusted-session",
    "sinv_" + "1".repeat(32),
    true,
  ]);
});
