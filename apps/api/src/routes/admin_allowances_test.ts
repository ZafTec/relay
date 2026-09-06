import { assertEquals } from "@std/assert";
import type { Auth } from "@relay/auth";
import {
  type AdminAllowanceService,
  createAdminAllowanceRoutes,
} from "./admin_allowances.ts";

const ROOT = "/api/v1/admin/allowances/workspaces";
const origin = "https://relay.test";
const input = {
  key: "images.generated",
  mode: "finite",
  amount: "20",
  effectiveAt: null,
  expiresAt: null,
  reason: "Pilot",
};
function fixture(
  options: { authenticated?: boolean; errorCode?: string } = {},
) {
  const calls: unknown[][] = [];
  const service: AdminAllowanceService = {
    workspaces: (...args) => {
      calls.push(args);
      return Promise.resolve({ items: [], nextCursor: null });
    },
    summary: () => Promise.resolve(null),
    grants: () => Promise.resolve({ items: [], nextCursor: null }),
    audit: () => Promise.resolve({ items: [], nextCursor: null }),
    mutate: (...args) => {
      calls.push(args);
      if (options.errorCode) {
        throw Object.assign(new Error("internal secret"), {
          code: options.errorCode,
        });
      }
      return Promise.resolve({
        operation: "grant",
        grantId: "grant-test",
        replayed: false,
      });
    },
  };
  const auth = {
    api: {
      getSession: () =>
        Promise.resolve(
          options.authenticated === false ? null : {
            session: {
              id: "trusted-session",
              userId: "ignored",
              activeOrganizationId: "ignored",
            },
          },
        ),
    },
  } as unknown as Auth;
  return {
    app: createAdminAllowanceRoutes({
      auth,
      service,
      allowedOrigins: [origin],
    }),
    calls,
  };
}
function request(body: unknown = input, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "idempotency-key": "allowance-test-key-001",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}
Deno.test("admin allowances use cookie session identity and explicit target workspace", async () => {
  const { app, calls } = fixture();
  const response = await app.request(`${ROOT}/target/grant`, request());
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(calls[0].slice(0, 5), [
    "trusted-session",
    "target",
    "grant",
    input,
    "allowance-test-key-001",
  ]);
});
Deno.test("admin allowance writes reject missing auth, untrusted origins, unbounded input and implicit allowances", async () => {
  const unauthenticated = fixture({ authenticated: false });
  assertEquals(
    (await unauthenticated.app.request(`${ROOT}/target/grant`, request()))
      .status,
    401,
  );
  assertEquals(unauthenticated.calls.length, 0);
  const { app, calls } = fixture();
  for (const value of ["", "https://attacker.invalid", `${origin}/`, "null"]) {
    assertEquals(
      (await app.request(
        `${ROOT}/target/grant`,
        request(input, { origin: value }),
      )).status,
      403,
    );
  }
  for (
    const value of [
      { ...input, amount: null },
      { ...input, actorUserId: "forged" },
      { ...input, amount: 20 },
      { ...input, mode: "unlimited" },
    ]
  ) {
    assertEquals(
      (await app.request(`${ROOT}/target/grant`, request(value))).status,
      400,
    );
  }
  assertEquals(
    (await app.request(
      `${ROOT}/target/grant`,
      request(input, { "idempotency-key": "short" }),
    )).status,
    400,
  );
  assertEquals(
    (await app.request(
      `${ROOT}/target/grant`,
      request({ ...input, reason: "a".repeat(9000) }),
    )).status,
    413,
  );
  assertEquals(
    (await app.request(`${ROOT}/target/grant?forged=true`, request())).status,
    400,
  );
  assertEquals((await app.request(`${ROOT}?search=a&search=b`)).status, 400);
  assertEquals(calls.length, 0);
});
Deno.test("admin allowances map authorization and conflict errors without exposing database messages", async () => {
  for (
    const [code, expected] of [
      ["42501", 403],
      ["28000", 401],
      ["55000", 401],
      ["RG001", 409],
      ["RA404", 404],
      ["RA409", 409],
      ["22023", 400],
      ["unknown", 500],
    ] as const
  ) {
    const { app } = fixture({ errorCode: code });
    const response = await app.request(`${ROOT}/target/grant`, request());
    assertEquals(response.status, expected);
    assertEquals((await response.text()).includes("internal secret"), false);
  }
});
