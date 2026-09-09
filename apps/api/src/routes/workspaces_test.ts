import { assertEquals } from "@std/assert";
import { type Auth, WorkspaceManagementError } from "@relay/auth";
import {
  createWorkspaceRoutes,
  type WorkspaceManagementService,
} from "./workspaces.ts";

const origin = "https://relay.test";
const root = "/api/v1/workspaces";
const id = "98f7bcb0-f141-4d4a-a4ad-93ab015f127f";
const workspace = {
  id,
  name: "Amber Grove",
  slug: "amber-grove-2487",
  role: "owner",
  personal: false,
};

function fixture(
  authenticated = true,
  overrides: Partial<WorkspaceManagementService> = {},
) {
  const calls: unknown[][] = [];
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
    app: createWorkspaceRoutes({
      auth,
      allowedOrigins: [origin],
      service: {
        remove: () => Promise.resolve(),
        connections: () => Promise.resolve([]),
        revokeConnection: () => Promise.resolve(),
        list: (session) => {
          calls.push(["list", session]);
          return Promise.resolve([workspace]);
        },
        propose: (session) => {
          calls.push(["propose", session]);
          return Promise.resolve({
            name: workspace.name,
            slug: workspace.slug,
          });
        },
        create: (session, input, key) => {
          calls.push(["create", session, input, key]);
          return Promise.resolve({ workspace, replayed: false });
        },
        update: (session, id, input) => {
          calls.push(["update", session, id, input]);
          return Promise.resolve(workspace);
        },
        ...overrides,
      },
    }),
  };
}
function mutation(
  body: unknown,
  method = "POST",
  extra: Record<string, string> = {},
) {
  return {
    method,
    headers: {
      origin,
      "content-type": "application/json",
      "idempotency-key": "workspace-create-12345",
      ...extra,
    },
    body: JSON.stringify(body),
  };
}
Deno.test("workspace routes require a session and trusted origin before service access", async () => {
  const anonymous = fixture(false);
  assertEquals((await anonymous.app.request(root)).status, 401);
  assertEquals(
    (await anonymous.app.request(root, mutation(workspace))).status,
    401,
  );
  assertEquals(anonymous.calls, []);
  const { app, calls } = fixture();
  const details = { name: "Studio", slug: "studio" };
  assertEquals(
    (await app.request(
      root,
      mutation(details, "POST", { origin: "https://evil.test" }),
    )).status,
    403,
  );
  assertEquals(
    (await app.request(root, mutation({ ...details, userId: "spoofed" })))
      .status,
    400,
  );
  assertEquals(
    (await app.request(
      root,
      mutation(details, "POST", { "idempotency-key": "bad" }),
    )).status,
    400,
  );
  assertEquals((await app.request(`${root}?user=spoofed`)).status, 400);
  assertEquals(
    (await app.request(`${root}/not-an-id`, mutation(details, "PATCH"))).status,
    404,
  );
  assertEquals(calls, []);
});
Deno.test("workspace routes normalize editable labels and preserve server-derived session identity", async () => {
  const { app, calls } = fixture();
  const listed = await app.request(root);
  assertEquals(listed.status, 200);
  assertEquals(listed.headers.get("cache-control"), "no-store");
  assertEquals((await listed.json()).items, [workspace]);
  assertEquals((await app.request(`${root}/suggestion`)).status, 200);
  assertEquals(
    (await app.request(
      root,
      mutation({ name: "  Studio  ", slug: "MY-STUDIO" }),
    )).status,
    201,
  );
  assertEquals(calls.at(-1), ["create", "trusted-session", {
    name: "Studio",
    slug: "my-studio",
  }, "workspace-create-12345"]);
  assertEquals(
    (await app.request(
      `${root}/${id}`,
      mutation({ name: "Other", slug: "another-studio" }, "PATCH"),
    )).status,
    200,
  );
  assertEquals(calls.at(-1), ["update", "trusted-session", id, {
    name: "Other",
    slug: "another-studio",
  }]);
});
Deno.test("workspace route failures distinguish unavailable handles, missing membership and replay", async () => {
  for (
    const [reason, status] of [
      ["slug_taken", 409],
      ["workspace_limit", 409],
      ["owner_required", 403],
      ["not_found", 404],
      ["unauthenticated", 401],
      ["idempotency_conflict", 409],
    ] as const
  ) {
    const { app } = fixture(true, {
      create: () => Promise.reject(new WorkspaceManagementError(reason)),
    });
    assertEquals(
      (await app.request(root, mutation({ name: "Studio", slug: "studio" })))
        .status,
      status,
    );
  }
  const { app } = fixture(true, {
    create: () => Promise.resolve({ workspace, replayed: true }),
  });
  assertEquals(
    (await app.request(root, mutation({ name: "Studio", slug: "studio" })))
      .status,
    200,
  );
});
