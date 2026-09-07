import { assertEquals } from "@std/assert";
import { HTTP_PATHS } from "@relay/contracts";
import { createV1Routes } from "./v1.ts";
import {
  AUTHENTICATED_IDENTITY,
  createStubServices,
  NOW,
  USER_ID,
  WORKSPACE_ID,
} from "./test_support.ts";

const storage = {
  generatedAt: NOW,
  storedBytes: "9007199254740993",
  reservedBytes: "7",
  cleanupPendingBytes: "2",
  limitBytes: "9007199254741010",
  availableBytes: "10",
};

Deno.test("storage usage uses the active workspace identity and returns exact byte strings without caching", async () => {
  let identity: unknown;
  const app = createV1Routes({
    services: createStubServices({
      usage: {
        getStorageSummary: (context) => {
          identity = context;
          return Promise.resolve({ kind: "ok", storage });
        },
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
  });
  const response = await app.request(HTTP_PATHS.storageUsage);
  assertEquals(response.status, 200);
  assertEquals(response.headers.get("cache-control"), "no-store");
  assertEquals(await response.json(), { kind: "ok", storage });
  assertEquals((identity as { workspaceId: string }).workspaceId, WORKSPACE_ID);
  assertEquals((identity as { actorUserId: string }).actorUserId, USER_ID);
  const foreignWorkspace = await app.request(
    `${HTTP_PATHS.storageUsage}?workspaceId=another-workspace`,
  );
  assertEquals(foreignWorkspace.status, 400);
});

Deno.test("storage usage rejects anonymous and stale-workspace requests before invoking the service", async () => {
  let invoked = false;
  for (
    const [resolution, status] of [
      [{ kind: "unauthenticated" } as const, 401],
      [{ kind: "workspace_unavailable", actorUserId: USER_ID } as const, 404],
    ] as const
  ) {
    const app = createV1Routes({
      services: createStubServices({
        usage: {
          getStorageSummary: () => {
            invoked = true;
            return Promise.resolve({ kind: "ok", storage });
          },
        },
      }),
      resolveIdentity: () => Promise.resolve(resolution),
    });
    const response = await app.request(HTTP_PATHS.storageUsage);
    assertEquals(response.status, status);
    await response.body?.cancel();
  }
  assertEquals(invoked, false);
});

Deno.test("storage service unavailability and missing membership never become zero-byte success", async () => {
  for (
    const [result, status] of [
      [{ kind: "unavailable" } as const, 503],
      [{ kind: "not_found" } as const, 404],
    ] as const
  ) {
    const app = createV1Routes({
      services: createStubServices({
        usage: { getStorageSummary: () => Promise.resolve(result) },
      }),
      resolveIdentity: AUTHENTICATED_IDENTITY,
    });
    const response = await app.request(HTTP_PATHS.storageUsage);
    assertEquals(response.status, status);
    const body = await response.json();
    assertEquals("storage" in body, false);
  }
});
