import assert from "node:assert/strict";
import {
  AzureGptImage2Client,
  AzureProviderError,
  type AzureProviderErrorClassification,
} from "./index.ts";
import {
  asFetch,
  base64,
  expectProviderError,
  jpegBytes,
  jsonResponse,
  pngBytes,
  TEST_API_KEY,
} from "./test_helpers.ts";

function validImageResponse(): Response {
  return jsonResponse({
    data: [{ b64_json: base64(pngBytes(1024, 1024)) }],
  });
}

Deno.test("HTTP status failures have stable sanitized classifications", async () => {
  const cases: readonly [number, AzureProviderErrorClassification][] = [
    [400, "client_error"],
    [404, "client_error"],
    [401, "authentication"],
    [403, "authorization"],
    [422, "unprocessable_entity"],
    [500, "server_error"],
    [503, "server_error"],
  ];
  for (const [status, classification] of cases) {
    const client = new AzureGptImage2Client({
      apiKey: TEST_API_KEY,
      fetch: asFetch(() =>
        new Response(`upstream leaked ${TEST_API_KEY}`, { status })
      ),
    });
    const error = await expectProviderError(
      () => client.generate({ prompt: "private prompt" }),
      classification,
    );
    assert.equal(error.status, status);
    assert.equal(error.retryable, status >= 500);
    assert.equal(JSON.stringify(error).includes(TEST_API_KEY), false);
    assert.equal(error.message.includes("private prompt"), false);
  }
});

Deno.test("HTTP 429 exposes only bounded Retry-After metadata", async () => {
  const client = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    fetch: asFetch(() =>
      new Response("private rate-limit detail", {
        status: 429,
        headers: { "Retry-After": "12" },
      })
    ),
  });
  const error = await expectProviderError(
    () => client.generate({ prompt: "private prompt" }),
    "rate_limit",
  );
  assert.equal(error.status, 429);
  assert.equal(error.retryable, true);
  assert.equal(error.retryAfterMs, 12_000);
});

Deno.test("network errors discard thrown messages and secrets", async () => {
  const client = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    fetch: asFetch(() => {
      throw new Error(`socket failed with ${TEST_API_KEY} and private prompt`);
    }),
  });
  const error = await expectProviderError(
    () => client.generate({ prompt: "private prompt" }),
    "network_error",
  );
  const exposed = `${error.message}\n${JSON.stringify(error)}\n${
    error.stack ?? ""
  }`;
  assert.equal(exposed.includes(TEST_API_KEY), false);
  assert.equal(exposed.includes("private prompt"), false);
  assert.equal(error.cause, undefined);
});

Deno.test("caller abort is classified separately and aborts injected fetch", async () => {
  let observedAbort = false;
  const client = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    fetch: asFetch((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new DOMException("private abort detail", "AbortError"));
        }, { once: true });
      })
    ),
  });
  const controller = new AbortController();
  const pending = client.generate(
    { prompt: "private prompt" },
    { signal: controller.signal },
  );
  controller.abort("secret abort reason");
  const error = await expectProviderError(() => pending, "aborted");
  assert.equal(observedAbort, true);
  assert.equal(error.retryable, false);
  assert.equal(JSON.stringify(error).includes("secret abort reason"), false);
});

Deno.test("pre-aborted requests never invoke fetch", async () => {
  let fetchCalls = 0;
  const client = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    fetch: asFetch(() => {
      fetchCalls += 1;
      return validImageResponse();
    }),
  });
  const controller = new AbortController();
  controller.abort();
  await expectProviderError(
    () => client.generate({ prompt: "x" }, { signal: controller.signal }),
    "aborted",
  );
  assert.equal(fetchCalls, 0);
});

Deno.test("timeout is bounded and aborts an in-flight fetch", async () => {
  let observedAbort = false;
  const client = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    timeoutMs: 5,
    fetch: asFetch((_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          observedAbort = true;
          reject(new DOMException("secret timeout detail", "AbortError"));
        }, { once: true });
      })
    ),
  });
  const error = await expectProviderError(
    () => client.generate({ prompt: "private prompt" }),
    "timeout",
  );
  assert.equal(observedAbort, true);
  assert.equal(error.retryable, true);
});

Deno.test("declared and streamed oversized responses are rejected", async () => {
  const declared = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    maxResponseBytes: 32,
    fetch: asFetch(() =>
      new Response("{}", {
        headers: { "Content-Length": "33" },
      })
    ),
  });
  await expectProviderError(
    () => declared.generate({ prompt: "x" }),
    "response_too_large",
  );

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"padding":"'));
      controller.enqueue(new TextEncoder().encode("x".repeat(64)));
      controller.enqueue(new TextEncoder().encode('"}'));
      controller.close();
    },
  });
  const streamed = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    maxResponseBytes: 32,
    fetch: asFetch(() => new Response(stream)),
  });
  await expectProviderError(
    () => streamed.generate({ prompt: "x" }),
    "response_too_large",
  );
});

Deno.test("decoded base64 has an independent hard response bound", async () => {
  const client = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    maxBase64Bytes: 8,
    fetch: asFetch(() => validImageResponse()),
  });
  await expectProviderError(
    () => client.generate({ prompt: "x" }),
    "response_too_large",
  );
});

Deno.test("malformed image responses are rejected without raw data", async () => {
  const malformedResponses: readonly (() => Response)[] = [
    () => new Response("not json"),
    () => jsonResponse({ data: [] }),
    () => jsonResponse({ data: [{ b64_json: "%%%%" }] }),
    () =>
      jsonResponse({
        data: [{ b64_json: base64(new Uint8Array([1, 2, 3, 4])) }],
      }),
    () => jsonResponse({ data: [{ b64_json: base64(pngBytes(0, 10)) }] }),
    () => jsonResponse({ data: [{ b64_json: base64(jpegBytes(1024, 1024)) }] }),
    () =>
      jsonResponse({
        data: [{ b64_json: base64(pngBytes(1024, 1024)) }, {
          b64_json: base64(pngBytes(1024, 1024)),
        }],
      }),
  ];

  for (const response of malformedResponses) {
    const client = new AzureGptImage2Client({
      apiKey: TEST_API_KEY,
      fetch: asFetch(response),
    });
    await expectProviderError(
      () => client.generate({ prompt: "private response canary" }),
      "invalid_response",
    );
  }
});

Deno.test("client limits and credentials are validated before fetch", () => {
  const fetch = asFetch(() => validImageResponse());
  for (
    const options of [
      { apiKey: "", fetch },
      { apiKey: "line\nbreak", fetch },
      { apiKey: TEST_API_KEY, fetch, timeoutMs: 300_001 },
      { apiKey: TEST_API_KEY, fetch, maxResponseBytes: 0 },
      { apiKey: TEST_API_KEY, fetch, maxBase64Bytes: 64 * 1024 * 1024 + 1 },
    ]
  ) {
    assert.throws(
      () => new AzureGptImage2Client(options),
      (error: unknown) =>
        error instanceof AzureProviderError &&
        error.classification === "invalid_input" &&
        !JSON.stringify(error).includes(TEST_API_KEY),
    );
  }
});
