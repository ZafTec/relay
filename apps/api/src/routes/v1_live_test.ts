import { assertEquals, assertStringIncludes } from "@std/assert";
import { decodeCursor } from "@relay/application";
import { HTTP_PATHS, type WorkspaceEventEnvelope } from "@relay/contracts";
import {
  createV1Routes,
  type WorkspaceEventSource,
  type WorkspaceEventWaitRequest,
} from "./v1.ts";
import {
  AUTHENTICATED_IDENTITY,
  COMPLETED_RUN,
  createStubServices,
  RUN_ID,
  USER_ID,
  workspaceEvent,
} from "./test_support.ts";

const SESSION_COOKIE = "relay.session=test";

class WakeSource implements WorkspaceEventSource {
  readonly #waiters = new Set<() => void>();

  wait(request: WorkspaceEventWaitRequest): Promise<void> {
    if (request.signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        request.signal.removeEventListener("abort", finish);
        this.#waiters.delete(finish);
        resolve();
      };
      this.#waiters.add(finish);
      request.signal.addEventListener("abort", finish, { once: true });
    });
  }

  wake(): void {
    for (const finish of [...this.#waiters]) finish();
  }
}

class DurableEventService {
  readonly events: WorkspaceEventEnvelope[] = [];
  readonly requestedAfterIds: Array<string | null> = [];

  list(
    _context: { readonly workspaceId: string; readonly actorUserId: string },
    request: { readonly cursor: string | null; readonly limit: number },
  ) {
    const afterId = request.cursor === null
      ? null
      : decodeCursor(request.cursor, "events", "", 1)[0];
    this.requestedAfterIds.push(afterId);
    const items = this.events
      .filter((event) => afterId === null || BigInt(event.id) > BigInt(afterId))
      .slice(0, request.limit);
    return Promise.resolve({ kind: "ok" as const, items, nextCursor: null });
  }
}

async function startLiveServer(app: ReturnType<typeof createV1Routes>) {
  let notify!: (address: Deno.NetAddr) => void;
  const listening = new Promise<Deno.NetAddr>((resolve) => {
    notify = resolve;
  });
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      onListen: notify,
    },
    app.fetch,
  );
  const address = await listening;
  return {
    baseUrl: `http://${address.hostname}:${address.port}`,
    async close() {
      await server.shutdown();
    },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  text: string,
  initial = "",
): Promise<string> {
  const decoder = new TextDecoder();
  let received = initial;
  while (!received.includes(text)) {
    const chunk = await reader.read();
    if (chunk.done) {
      throw new Error(`SSE stream closed before ${JSON.stringify(text)}`);
    }
    received += decoder.decode(chunk.value, { stream: true });
  }
  return received;
}

Deno.test("live SSE reconnect replays durable events after Last-Event-ID", async () => {
  const durable = new DurableEventService();
  durable.events.push(workspaceEvent("1"));
  const source = new WakeSource();
  const resolveIdentity = (request: Request) =>
    request.headers.get("cookie") === SESSION_COOKIE
      ? AUTHENTICATED_IDENTITY(request)
      : Promise.resolve({ kind: "unauthenticated" } as const);
  const app = createV1Routes({
    services: createStubServices({
      events: { list: durable.list.bind(durable) },
    }),
    resolveIdentity,
    eventStream: {
      source,
      pollIntervalMs: 1_000,
      heartbeatIntervalMs: 1_000,
      reconnectDelayMs: 100,
      pageSize: 10,
    },
  });
  const live = await startLiveServer(app);
  const firstAbort = new AbortController();

  try {
    const first = await fetch(`${live.baseUrl}${HTTP_PATHS.events}`, {
      headers: { cookie: SESSION_COOKIE },
      signal: firstAbort.signal,
    });
    assertEquals(first.status, 200);
    assertStringIncludes(
      first.headers.get("content-type") ?? "",
      "text/event-stream",
    );
    assertEquals(first.headers.get("x-accel-buffering"), "no");
    assertEquals(first.headers.get("cache-control"), "no-cache, no-transform");
    const firstReader = first.body!.getReader();
    let firstText = await readUntil(firstReader, "event: relay.resynchronized");
    assertStringIncludes(firstText, "id: 1\n");
    assertStringIncludes(firstText, "event: run.created\n");
    assertStringIncludes(firstText, 'data: {"lastEventId":"1"}');

    durable.events.push(workspaceEvent("2", "run.progress_changed"));
    source.wake();
    firstText = await readUntil(firstReader, "id: 2\n", firstText);
    assertStringIncludes(firstText, "event: run.progress_changed\n");
    await firstReader.cancel();
    firstAbort.abort();

    durable.events.push(workspaceEvent("3"));
    const reconnectAbort = new AbortController();
    try {
      const reconnect = await fetch(`${live.baseUrl}${HTTP_PATHS.events}`, {
        headers: {
          cookie: SESSION_COOKIE,
          "last-event-id": "2",
        },
        signal: reconnectAbort.signal,
      });
      assertEquals(reconnect.status, 200);
      const reconnectReader = reconnect.body!.getReader();
      const reconnectText = await readUntil(
        reconnectReader,
        "event: relay.resynchronized",
      );
      assertStringIncludes(reconnectText, "id: 3\n");
      assertEquals(reconnectText.includes("id: 1\n"), false);
      assertEquals(reconnectText.includes("id: 2\n"), false);
      await reconnectReader.cancel();
    } finally {
      reconnectAbort.abort();
    }

    assertEquals(durable.requestedAfterIds[0], null);
    assertEquals(durable.requestedAfterIds.includes("1"), true);
    assertEquals(durable.requestedAfterIds.includes("2"), true);
  } finally {
    firstAbort.abort();
    await live.close();
  }
});

Deno.test("live SSE heartbeats and closes after membership removal", async () => {
  let allowed = true;
  let resolutions = 0;
  const app = createV1Routes({
    services: createStubServices(),
    resolveIdentity: (request) => {
      resolutions += 1;
      if (request.headers.get("cookie") !== SESSION_COOKIE) {
        return Promise.resolve({ kind: "unauthenticated" });
      }
      return allowed ? AUTHENTICATED_IDENTITY(request) : Promise.resolve({
        kind: "workspace_unavailable" as const,
        actorUserId: USER_ID,
      });
    },
    eventStream: {
      pollIntervalMs: 10,
      heartbeatIntervalMs: 20,
      reconnectDelayMs: 100,
    },
  });
  const live = await startLiveServer(app);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 2_000);

  try {
    const response = await fetch(`${live.baseUrl}${HTTP_PATHS.events}`, {
      headers: { cookie: SESSION_COOKIE },
      signal: abort.signal,
    });
    const reader = response.body!.getReader();
    const text = await readUntil(reader, ": heartbeat\n\n");
    assertStringIncludes(text, "event: relay.resynchronized\n");
    allowed = false;

    let done = false;
    while (!done) {
      ({ done } = await reader.read());
    }
    assertEquals(resolutions >= 3, true);
  } finally {
    clearTimeout(timeout);
    abort.abort();
    await live.close();
  }
});

Deno.test("live cancellation preserves a completion-wins race", async () => {
  let release!: () => void;
  let entered!: () => void;
  const completion = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancellationEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const app = createV1Routes({
    services: createStubServices({
      runs: {
        async cancel() {
          entered();
          await completion;
          return { kind: "already_terminal", run: COMPLETED_RUN };
        },
      },
    }),
    resolveIdentity: AUTHENTICATED_IDENTITY,
  });
  const live = await startLiveServer(app);

  try {
    const pendingResponse = fetch(
      `${live.baseUrl}${HTTP_PATHS.runCancel.replace(":runId", RUN_ID)}`,
      { method: "POST", headers: { cookie: SESSION_COOKIE } },
    );
    await cancellationEntered;
    release();
    const response = await pendingResponse;
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.kind, "already_terminal");
    assertEquals(body.run.status, "succeeded");
  } finally {
    release();
    await live.close();
  }
});
