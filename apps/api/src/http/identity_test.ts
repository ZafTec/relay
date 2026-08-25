import { assertEquals } from "@std/assert";
import type { Auth, Queryable, WorkspaceRole } from "@relay/auth";
import { createAuthSessionIdentityResolver } from "./identity.ts";

type CurrentSession = Awaited<ReturnType<Auth["api"]["getSession"]>>;

function authWith(current: CurrentSession): Pick<Auth, "api"> {
  return {
    api: {
      getSession: () => Promise.resolve(current),
    },
  };
}

function queryableWith(role: WorkspaceRole | null): {
  readonly queryable: Queryable;
  readonly calls: unknown[][];
} {
  const calls: unknown[][] = [];
  return {
    calls,
    queryable: {
      query<T>(_text: string, params?: unknown[]) {
        calls.push(params ?? []);
        const rows = role === null ? [] : [{ role }];
        return Promise.resolve({ rows: rows as T[] });
      },
    },
  };
}

function currentSession(
  activeOrganizationId: string | null = "workspace_1",
): Exclude<CurrentSession, null> {
  const now = new Date();
  return {
    session: {
      id: "session_1",
      userId: "user_1",
      createdAt: now,
      activeOrganizationId,
    },
    user: {
      id: "user_1",
      email: "person@example.test",
      name: "Test Person",
    },
  };
}

Deno.test("auth session resolver returns unauthenticated without querying membership", async () => {
  const membership = queryableWith("member");
  const resolver = createAuthSessionIdentityResolver(
    authWith(null),
    membership.queryable,
  );

  assertEquals(
    await resolver(new Request("http://localhost/api/v1/tools")),
    { kind: "unauthenticated" },
  );
  assertEquals(membership.calls, []);
});

Deno.test("auth session resolver rejects absent or stale workspace context", async () => {
  const absentMembership = queryableWith("member");
  const absentResolver = createAuthSessionIdentityResolver(
    authWith(currentSession(null)),
    absentMembership.queryable,
  );
  assertEquals(
    await absentResolver(new Request("http://localhost/api/v1/tools")),
    { kind: "workspace_unavailable", actorUserId: "user_1" },
  );
  assertEquals(absentMembership.calls, []);

  const staleMembership = queryableWith(null);
  const staleResolver = createAuthSessionIdentityResolver(
    authWith(currentSession()),
    staleMembership.queryable,
  );
  assertEquals(
    await staleResolver(new Request("http://localhost/api/v1/tools")),
    { kind: "workspace_unavailable", actorUserId: "user_1" },
  );
  assertEquals(staleMembership.calls, [["workspace_1", "user_1"]]);
});

Deno.test("auth session resolver returns only current workspace membership", async () => {
  const membership = queryableWith("admin");
  const resolver = createAuthSessionIdentityResolver(
    authWith(currentSession()),
    membership.queryable,
  );

  assertEquals(
    await resolver(new Request("http://localhost/api/v1/tools")),
    {
      kind: "authenticated",
      identity: {
        workspaceId: "workspace_1",
        actorUserId: "user_1",
        membershipRole: "admin",
      },
    },
  );
  assertEquals(membership.calls, [["workspace_1", "user_1"]]);
});
