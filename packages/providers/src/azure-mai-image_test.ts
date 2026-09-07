import { assertEquals, assertRejects } from "@std/assert";
import { createAzureMaiImageClient } from "./azure-mai-image.ts";
import { createAzureGptImage2Client } from "./azure-gpt-image-2.ts";
import { AzureProviderError } from "./errors.ts";
import {
  asFetch,
  base64,
  expectProviderError,
  jpegBytes,
  pngBytes,
  TEST_API_KEY,
  TEST_AZURE_BASE_URL,
  webpBytes,
} from "./test_helpers.ts";

for (const model of ["MAI-Image-2.5", "MAI-Image-2.5-Flash"] as const) {
  Deno.test(`${model} sends the documented generation request and parses PNG output`, async () => {
    const client = createAzureMaiImageClient({
      baseUrl: TEST_AZURE_BASE_URL,
      apiKey: TEST_API_KEY,
      fetch: asFetch((url, init) => {
        assertEquals(
          String(url),
          `${TEST_AZURE_BASE_URL}/mai/v1/images/generations`,
        );
        assertEquals(new Headers(init?.headers).get("api-key"), TEST_API_KEY);
        assertEquals(JSON.parse(String(init?.body)), {
          model,
          prompt: "A paper boat",
          width: 1024,
          height: 1024,
        });
        return Response.json({
          data: [{ b64_json: base64(pngBytes(1024, 1024)) }],
        });
      }),
    }, model);
    assertEquals(
      (await client.generate({ prompt: "A paper boat" })).images[0].mediaType,
      "image/png",
    );
  });

  Deno.test(`${model} edits with a multipart image and rejects invalid dimensions before calling Azure`, async () => {
    let calls = 0;
    const bytes = pngBytes(1024, 1024);
    const client = createAzureMaiImageClient({
      baseUrl: TEST_AZURE_BASE_URL,
      apiKey: TEST_API_KEY,
      fetch: asFetch(async (url, init) => {
        calls++;
        assertEquals(String(url), `${TEST_AZURE_BASE_URL}/mai/v1/images/edits`);
        const form = await new Request(url, init).formData();
        assertEquals(form.get("model"), model);
        assertEquals(form.get("prompt"), "Make it blue");
        const file = form.get("image") as File;
        assertEquals(file.type, "image/png");
        assertEquals(new Uint8Array(await file.arrayBuffer()), bytes);
        return Response.json({ data: [{ b64_json: base64(bytes) }] });
      }),
    }, model);
    await assertRejects(
      () => client.generate({ prompt: "boat", width: 1365, height: 1024 }),
      AzureProviderError,
    );
    await assertRejects(
      () =>
        client.edit({ prompt: "boat", image: "https://example.com/image.png" }),
      AzureProviderError,
    );
    assertEquals(calls, 0);
    await client.edit({
      prompt: "Make it blue",
      image: `data:image/png;base64,${base64(bytes)}`,
    });
    assertEquals(calls, 1);
  });

  Deno.test(`${model} accepts Azure's rounded 4:5 edit output while keeping generation request limits strict`, async () => {
    let calls = 0;
    const client = createAzureMaiImageClient({
      baseUrl: TEST_AZURE_BASE_URL,
      apiKey: TEST_API_KEY,
      fetch: asFetch(() => {
        calls++;
        return Response.json({
          data: [{ b64_json: base64(pngBytes(912, 1152)) }],
        });
      }),
    }, model);
    // This exact output geometry was reproduced with a synthetic 1200x1500
    // JPEG. The image is valid but 0.2% above the nominal generation budget.
    const result = await client.edit({
      prompt: "Change the blue square to green",
      image: `data:image/jpeg;base64,${base64(jpegBytes(1200, 1500))}`,
    });
    assertEquals(result.images[0].width, 912);
    assertEquals(result.images[0].height, 1152);
    assertEquals(result.images[0].mediaType, "image/png");
    await expectProviderError(
      () => client.generate({ prompt: "fixture", width: 912, height: 1152 }),
      "invalid_input",
    );
    assertEquals(calls, 1);
  });

  Deno.test(`${model} rejects response dimensions beyond the small rounding allowance`, async () => {
    const client = createAzureMaiImageClient({
      baseUrl: TEST_AZURE_BASE_URL,
      apiKey: TEST_API_KEY,
      fetch: asFetch(() =>
        Response.json({
          data: [{ b64_json: base64(pngBytes(1056, 1056)) }],
        })
      ),
    }, model);
    const error = await expectProviderError(
      () =>
        client.edit({
          prompt: "fixture",
          image: `data:image/jpeg;base64,${base64(jpegBytes(1200, 1500))}`,
        }),
      "invalid_response",
    );
    assertEquals(error.field, "response.data[0].b64_json");
  });
}

Deno.test("GPT Image edits preserve multiple source images, a mask, and generation controls", async () => {
  const bytes = pngBytes(1024, 1024);
  const image = `data:image/png;base64,${base64(bytes)}`;
  const client = createAzureGptImage2Client({
    baseUrl: TEST_AZURE_BASE_URL,
    apiKey: TEST_API_KEY,
    fetch: asFetch(async (url, init) => {
      assertEquals(
        String(url),
        `${TEST_AZURE_BASE_URL}/openai/v1/images/edits`,
      );
      assertEquals(new Headers(init?.headers).get("api-key"), TEST_API_KEY);
      const form = await new Request(url, init).formData();
      assertEquals(form.getAll("image[]").length, 2);
      assertEquals((form.get("mask") as File).type, "image/png");
      assertEquals(form.get("input_fidelity"), "high");
      assertEquals(form.get("n"), "2");
      return Response.json({
        data: [{ b64_json: base64(bytes) }, { b64_json: base64(bytes) }],
      });
    }),
  });
  assertEquals(
    (await client.edit({
      prompt: "Combine",
      images: [image, image],
      mask: image,
      input_fidelity: "high",
      n: 2,
    })).images.length,
    2,
  );
});

for (const model of ["MAI-Image-2.5", "MAI-Image-2.5-Flash"] as const) {
  Deno.test(`${model} rejects malformed inputs and unsupported controls before HTTP`, async () => {
    let calls = 0;
    const client = createAzureMaiImageClient({
      baseUrl: TEST_AZURE_BASE_URL,
      apiKey: TEST_API_KEY,
      fetch: asFetch(() => {
        calls++;
        throw new Error("Must not call Azure");
      }),
    }, model);
    const invalid = [
      null,
      [],
      {},
      { prompt: "" },
      { prompt: "x", width: null },
      { prompt: "x", width: 767 },
      { prompt: "x", height: 1366 },
      { prompt: "x", width: 1365, height: 769 },
      { prompt: "x", n: 2 },
      { prompt: "x", seed: 1 },
      { prompt: "x", auto_aspect_ratio: true },
      {
        prompt: "x",
        get width() {
          throw new Error("private getter");
        },
      },
    ];
    for (const input of invalid) {
      await expectProviderError(
        () => client.generate(input as never),
        "invalid_input",
      );
    }
    for (
      const image of [
        "https://example.test/private.png",
        "file:///tmp/a.png",
        "data:image/png;base64,???",
        `data:image/png;base64,${base64(jpegBytes(1024, 1024))}`,
        `data:image/webp;base64,${base64(webpBytes(1024, 1024))}`,
      ]
    ) {
      await expectProviderError(
        () => client.edit({ prompt: "x", image }),
        "invalid_input",
      );
    }
    await expectProviderError(
      () =>
        client.edit(
          {
            prompt: "x",
            image: `data:image/png;base64,${base64(pngBytes(1024, 1024))}`,
            width: 1024,
          } as never,
        ),
      "invalid_input",
    );
    assertEquals(calls, 0);
  });
  Deno.test(`${model} accepts portrait and landscape boundary sizes and JPEG edit input`, async () => {
    const requests: Record<string, unknown>[] = [];
    const client = createAzureMaiImageClient({
      baseUrl: TEST_AZURE_BASE_URL,
      apiKey: TEST_API_KEY,
      fetch: asFetch(async (url, init) => {
        assertEquals(init?.redirect, "error");
        assertEquals(new Headers(init?.headers).get("authorization"), null);
        if (String(url).endsWith("/edits")) {
          const form = await new Request(url, init).formData();
          assertEquals((form.get("image") as File).type, "image/jpeg");
        } else requests.push(JSON.parse(String(init?.body)));
        return Response.json({
          data: [{ b64_json: base64(pngBytes(1024, 1024)) }],
        });
      }),
    }, model);
    await client.generate({ prompt: "x", width: 1365, height: 768 });
    await client.generate({ prompt: "x", width: 768, height: 1365 });
    await client.edit({
      prompt: "x",
      image: `data:image/jpeg;base64,${base64(jpegBytes(1024, 1024))}`,
    });
    assertEquals(requests.map(({ width, height }) => [width, height]), [[
      1365,
      768,
    ], [768, 1365]]);
  });
}

Deno.test("GPT edit rejects mismatched masks, malformed images, counts and unknown controls before HTTP", async () => {
  let calls = 0;
  const image = `data:image/png;base64,${base64(pngBytes(1024, 1024))}`;
  const client = createAzureGptImage2Client({
    baseUrl: TEST_AZURE_BASE_URL,
    apiKey: TEST_API_KEY,
    fetch: asFetch(() => {
      calls++;
      throw new Error("Must not call Azure");
    }),
  });
  const invalid = [
    null,
    [],
    { prompt: "x", images: [] },
    { prompt: "x", images: Array(17).fill(image) },
    { prompt: "x", images: [image], n: 11 },
    { prompt: "x", images: [image], input_fidelity: "auto" },
    {
      prompt: "x",
      images: [image],
      mask: `data:image/png;base64,${base64(pngBytes(768, 1024))}`,
    },
    {
      prompt: "x",
      images: [image],
      mask: `data:image/jpeg;base64,${base64(jpegBytes(1024, 1024))}`,
    },
    { prompt: "x", images: ["https://example.test/image.png"] },
    {
      prompt: "x",
      get images() {
        throw new Error("private getter");
      },
    },
    { prompt: "x", images: [image], stream: true },
  ];
  for (const input of invalid) {
    await expectProviderError(
      () => client.edit(input as never),
      "invalid_input",
    );
  }
  assertEquals(calls, 0);
});

const operations = [
  "mai-generation",
  "mai-edit",
  "flash-generation",
  "flash-edit",
  "gpt-edit",
] as const;
for (const operation of operations) {
  const setup = (
    options: Partial<Parameters<typeof createAzureGptImage2Client>[0]>,
  ) => {
    const config = {
      baseUrl: TEST_AZURE_BASE_URL,
      apiKey: TEST_API_KEY,
      fetch: asFetch(() => {
        throw new Error("unexpected HTTP");
      }),
      ...options,
    };
    const image = `data:image/png;base64,${base64(pngBytes(1024, 1024))}`;
    const mai = createAzureMaiImageClient(
      config,
      operation.startsWith("flash") ? "MAI-Image-2.5-Flash" : "MAI-Image-2.5",
    );
    const gpt = createAzureGptImage2Client(config);
    return (signal?: AbortSignal) =>
      operation === "gpt-edit"
        ? gpt.edit({ prompt: "private prompt", images: [image] }, { signal })
        : operation.endsWith("edit")
        ? mai.edit({ prompt: "private prompt", image }, { signal })
        : mai.generate({ prompt: "private prompt" }, { signal });
  };
  Deno.test(`${operation} classifies provider failures and redacts request and response secrets`, async () => {
    for (
      const [status, classification] of [
        [401, "authentication"],
        [403, "authorization"],
        [422, "unprocessable_entity"],
        [429, "rate_limit"],
        [500, "server_error"],
      ] as const
    ) {
      const error = await expectProviderError(
        setup({
          fetch: asFetch(() =>
            new Response("private response " + TEST_API_KEY, {
              status,
              headers: { "retry-after": "3" },
            })
          ),
        }),
        classification,
      );
      assertEquals(error.status, status);
      if (status === 429) assertEquals(error.retryAfterMs, 3000);
      for (
        const secret of [TEST_API_KEY, "private prompt", "private response"]
      ) assertEquals(JSON.stringify(error).includes(secret), false);
    }
  });
  Deno.test(`${operation} enforces cancellation, timeouts, request and response size limits`, async () => {
    const controller = new AbortController();
    controller.abort();
    await expectProviderError(() => setup({})(controller.signal), "aborted");
    let observedAbort = false;
    await expectProviderError(
      setup({
        timeoutMs: 10,
        fetch: asFetch((_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener("abort", () => {
              observedAbort = true;
              reject(new Error("private failure"));
            }, { once: true })
          )
        ),
      }),
      "timeout",
    );
    assertEquals(observedAbort, true);
    await expectProviderError(setup({ maxRequestBytes: 1 }), "invalid_input");
    await expectProviderError(
      setup({
        maxResponseBytes: 5,
        fetch: asFetch(() => new Response("too much response")),
      }),
      "response_too_large",
    );
    await expectProviderError(
      setup({ fetch: asFetch(() => new Response("invalid JSON")) }),
      "invalid_response",
    );
    await expectProviderError(
      setup({
        fetch: asFetch(() =>
          Response.json({ data: [{ url: "https://example.test/image.png" }] })
        ),
      }),
      "invalid_response",
    );
    await expectProviderError(
      setup({
        fetch: asFetch(() =>
          Response.json({ data: [{ b64_json: base64(jpegBytes(1024, 1024)) }] })
        ),
      }),
      "invalid_response",
    );
  });
}

Deno.test("GPT edits apply a combined source and mask byte budget", async () => {
  const image = `data:image/png;base64,${base64(pngBytes(1024, 1024))}`;
  const client = createAzureGptImage2Client({
    baseUrl: TEST_AZURE_BASE_URL,
    apiKey: TEST_API_KEY,
    maxBase64Bytes: 48,
    fetch: asFetch(() => {
      throw new Error("Must not call Azure");
    }),
  });
  await expectProviderError(
    () => client.edit({ prompt: "x", images: [image, image], mask: image }),
    "invalid_input",
  );
  await expectProviderError(
    () => client.edit({ prompt: "x", images: [image, image, image] }),
    "invalid_input",
  );
});

for (const model of ["MAI-Image-2.5", "MAI-Image-2.5-Flash"] as const) {
  Deno.test(`${model} normalizes the usage counters returned by live Azure`, async () => {
    const client = createAzureMaiImageClient({
      baseUrl: TEST_AZURE_BASE_URL,
      apiKey: TEST_API_KEY,
      fetch: asFetch(() =>
        Response.json({
          data: [{ b64_json: base64(pngBytes(1024, 1024)) }],
          usage: {
            num_output_tokens: 1024,
            num_input_text_tokens: 39,
            num_input_image_tokens: 1024,
          },
        })
      ),
    }, model);
    const result = await client.generate({ prompt: "fixture" });
    assertEquals(result.usage, {
      inputTokens: 1063,
      outputTokens: 1024,
      totalTokens: 2087,
      inputTokenDetails: { textTokens: 39, imageTokens: 1024 },
    });
  });
  Deno.test(`${model} rejects malformed MAI usage rather than silently zeroing provider cost`, async () => {
    for (
      const usage of [null, {}, {
        num_output_tokens: -1,
        num_input_text_tokens: 1,
        num_input_image_tokens: 0,
      }, {
        num_output_tokens: 1,
        num_input_text_tokens: "1",
        num_input_image_tokens: 0,
      }]
    ) {
      const client = createAzureMaiImageClient({
        baseUrl: TEST_AZURE_BASE_URL,
        apiKey: TEST_API_KEY,
        fetch: asFetch(() =>
          Response.json({
            data: [{ b64_json: base64(pngBytes(1024, 1024)) }],
            usage,
          })
        ),
      }, model);
      await expectProviderError(
        () => client.generate({ prompt: "fixture" }),
        "invalid_response",
      );
    }
  });
}
