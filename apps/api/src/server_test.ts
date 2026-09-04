import { assertEquals, assertStrictEquals } from "@std/assert";
import type { ApplicationServices } from "@relay/application";
import type { Auth } from "@relay/auth";
import type { RuntimeConfig } from "@relay/config";
import type { DatabasePool } from "@relay/database";
import type { AppDependencies, RelayMcpHttpHandler } from "./app.ts";
import { createPostgresAdminCapacityService, startApi } from "./server.ts";

const CONFIG: RuntimeConfig = {
  appName: "Relay API Test",
  deploymentEnvironment: "test",
  port: 8_000,
  build: { version: "test", revision: "test" },
  database: {
    url: new URL("postgres://relay:test@localhost:5432/relay"),
    poolMax: 2,
    connectTimeoutMs: 100,
    statementTimeoutMs: 100,
  },
  redis: {
    url: new URL("redis://localhost:6379"),
    connectTimeoutMs: 100,
  },
};

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

Deno.test("capacity service maps authoritative session failures", async () => {
  for (
    const [code, expected] of [
      ["42501", { kind: "denied" }],
      ["28000", { kind: "reauthentication_required" }],
      ["55000", { kind: "reauthentication_required" }],
    ] as const
  ) {
    const seen: unknown[][] = [];
    const client = {
      query(text: string, values?: unknown[]) {
        seen.push([text, ...(values ?? [])]);
        if (text === "begin" || text === "rollback") {
          return Promise.resolve({ rows: [] });
        }
        return Promise.reject(
          Object.assign(new Error("database rejected session"), { code }),
        );
      },
      release() {},
    };
    const pool = {
      connect: () => Promise.resolve(client),
    } as unknown as DatabasePool;
    const result = await createPostgresAdminCapacityService(pool).list(
      { sessionId: "session-admin-capacity-0001" },
      {},
    );

    assertEquals(result, expected);
    assertEquals(
      String(seen[1]?.[0]).includes("require_fresh_superadmin_session"),
      true,
    );
    assertEquals(seen[1]?.[1], "session-admin-capacity-0001");
    assertEquals(seen.at(-1)?.[0], "rollback");
  }
});

Deno.test("startApi composes with its pool and exposes completed cleanup", async () => {
  let resolveFinished = () => {};
  const rawFinished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const rawServer = {
    finished: rawFinished,
    addr: {
      transport: "tcp",
      hostname: "127.0.0.1",
      port: 8_000,
    },
    ref() {},
    unref() {},
    shutdown() {
      resolveFinished();
      return Promise.resolve();
    },
    [Symbol.asyncDispose]() {
      resolveFinished();
      return Promise.resolve();
    },
  } as Deno.HttpServer;
  let poolCloseCount = 0;
  const pool = {
    end() {
      poolCloseCount += 1;
      return Promise.resolve();
    },
  } as unknown as DatabasePool;
  const services = {} as ApplicationServices;
  const auth = {} as Auth;
  let appDependencies: AppDependencies | undefined;
  let factoryCount = 0;
  let mcpCloseCount = 0;
  let shutdownCallbackCount = 0;
  const mcp: RelayMcpHttpHandler = {
    fetch: () => Promise.resolve(new Response()),
    close() {
      mcpCloseCount += 1;
      return Promise.resolve();
    },
  };

  const server = await startApi(
    CONFIG,
    {
      installSignalHandlers: false,
      applicationServicesFactory(candidate) {
        factoryCount += 1;
        assertStrictEquals(candidate, pool);
        return services;
      },
      additionalReadinessChecks: [
        (candidate) => {
          assertStrictEquals(candidate, pool);
          return Promise.resolve({ name: "storage", status: "ok" });
        },
      ],
      shutdownCallbacks: [
        (candidate) => {
          assertStrictEquals(candidate, pool);
          shutdownCallbackCount += 1;
        },
      ],
    },
    {
      loadAuthConfig: () => ({
        baseUrl: new URL("https://api.relay.test"),
        secret: "a".repeat(32),
        trustedOrigins: ["https://console.relay.test"],
        google: { clientId: "google", clientSecret: "google-secret" },
        github: { clientId: "github", clientSecret: "github-secret" },
      }),
      createDatabasePool: () => pool,
      createAuth: (() => auth) as never,
      createMcpHttpHandler: (() => mcp) as never,
      createApp: ((_config: RuntimeConfig, dependencies: AppDependencies) => {
        appDependencies = dependencies;
        return {
          fetch: () => new Response(),
        };
      }) as never,
      checkDatabaseHealth: () =>
        Promise.resolve({ name: "database", status: "ok" }),
      checkMigrationLedgerHealth: () =>
        Promise.resolve({ name: "migrations", status: "ok" }),
      serve: (() => rawServer) as never,
    },
  );

  assertEquals(factoryCount, 1);
  assertStrictEquals(appDependencies?.v1?.services, services);
  assertStrictEquals(appDependencies?.mcp, mcp);
  assertStrictEquals(appDependencies?.adminCapacity?.auth, auth);
  assertStrictEquals(appDependencies?.adminChangelog?.auth, auth);
  assertEquals(await appDependencies?.checkReadiness?.(), [
    { name: "database", status: "ok" },
    { name: "migrations", status: "ok" },
    { name: "storage", status: "ok" },
  ]);

  resolveFinished();
  await server.finished;
  await server.finished;

  assertEquals(mcpCloseCount, 1);
  assertEquals(shutdownCallbackCount, 1);
  assertEquals(poolCloseCount, 1);
});

Deno.test("startApi awaits rollback after partial signal installation", async () => {
  const startupFailure = new Error("signal installation failed");
  const events: string[] = [];
  const shutdownStarted = deferred();
  const allowServerShutdown = deferred();
  const mcpCloseStarted = deferred();
  const allowMcpClose = deferred();
  const callbackCloseStarted = deferred();
  const allowCallbackClose = deferred();
  const poolCloseStarted = deferred();
  const allowPoolClose = deferred();
  let resolveFinished = () => {};
  const rawFinished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  let serverShutdownCount = 0;
  const rawServer = {
    finished: rawFinished,
    addr: {
      transport: "tcp",
      hostname: "127.0.0.1",
      port: 8_000,
    },
    ref() {},
    unref() {},
    shutdown() {
      serverShutdownCount += 1;
      events.push("server.shutdown");
      shutdownStarted.resolve();
      return allowServerShutdown.promise.then(() => {
        events.push("server.shutdown.done");
        resolveFinished();
      });
    },
    [Symbol.asyncDispose]() {
      resolveFinished();
      return Promise.resolve();
    },
  } as Deno.HttpServer;
  let poolCloseCount = 0;
  const pool = {
    end() {
      poolCloseCount += 1;
      events.push("pool.close");
      poolCloseStarted.resolve();
      return allowPoolClose.promise.then(() => {
        events.push("pool.close.done");
      });
    },
  } as unknown as DatabasePool;
  let mcpCloseCount = 0;
  const mcp: RelayMcpHttpHandler = {
    fetch: () => Promise.resolve(new Response()),
    close() {
      mcpCloseCount += 1;
      events.push("mcp.close");
      mcpCloseStarted.resolve();
      return allowMcpClose.promise.then(() => {
        events.push("mcp.close.done");
      });
    },
  };
  let shutdownCallbackCount = 0;
  let installedHandler: (() => void) | undefined;
  const removedSignals: Deno.Signal[] = [];
  const services = {} as ApplicationServices;
  const auth = {} as Auth;

  const startup = startApi(
    CONFIG,
    {
      applicationServices: services,
      shutdownCallbacks: [async (candidate) => {
        assertStrictEquals(candidate, pool);
        shutdownCallbackCount += 1;
        events.push("callback.close");
        callbackCloseStarted.resolve();
        await allowCallbackClose.promise;
        events.push("callback.close.done");
      }],
    },
    {
      loadAuthConfig: () => ({
        baseUrl: new URL("https://api.relay.test"),
        secret: "a".repeat(32),
        trustedOrigins: ["https://console.relay.test"],
        google: { clientId: "google", clientSecret: "google-secret" },
        github: { clientId: "github", clientSecret: "github-secret" },
      }),
      createDatabasePool: () => pool,
      createAuth: (() => auth) as never,
      createMcpHttpHandler: (() => mcp) as never,
      createApp: (() => ({ fetch: () => new Response() })) as never,
      checkDatabaseHealth: () =>
        Promise.resolve({ name: "database", status: "ok" }),
      checkMigrationLedgerHealth: () =>
        Promise.resolve({ name: "migrations", status: "ok" }),
      serve: (() => rawServer) as never,
      signals: ["SIGINT", "SIGTERM"],
      addSignalListener(signal, handler) {
        events.push(`signal.add.${signal}`);
        if (signal === "SIGTERM") throw startupFailure;
        installedHandler = handler;
      },
      removeSignalListener(signal, handler) {
        assertStrictEquals(handler, installedHandler);
        removedSignals.push(signal);
        events.push(`signal.remove.${signal}`);
      },
    },
  );
  let settled = false;
  void startup.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  await shutdownStarted.promise;
  assertEquals(settled, false);
  if (installedHandler === undefined) {
    throw new Error("SIGINT handler was not installed");
  }
  installedHandler();
  await Promise.resolve();
  assertEquals(serverShutdownCount, 1);

  allowServerShutdown.resolve();
  await mcpCloseStarted.promise;
  assertEquals(removedSignals, ["SIGINT"]);
  assertEquals(settled, false);

  allowMcpClose.resolve();
  await callbackCloseStarted.promise;
  assertEquals(settled, false);

  allowCallbackClose.resolve();
  await poolCloseStarted.promise;
  assertEquals(settled, false);

  allowPoolClose.resolve();
  const rejection = await startup.then(
    () => undefined,
    (error) => error,
  );

  assertStrictEquals(rejection, startupFailure);
  assertEquals(serverShutdownCount, 1);
  assertEquals(mcpCloseCount, 1);
  assertEquals(shutdownCallbackCount, 1);
  assertEquals(poolCloseCount, 1);
  assertEquals(events, [
    "signal.add.SIGINT",
    "signal.add.SIGTERM",
    "server.shutdown",
    "server.shutdown.done",
    "signal.remove.SIGINT",
    "mcp.close",
    "mcp.close.done",
    "callback.close",
    "callback.close.done",
    "pool.close",
    "pool.close.done",
  ]);
});
