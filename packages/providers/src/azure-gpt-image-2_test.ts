import assert from "node:assert/strict";
import {
  AZURE_GPT_IMAGE_2_ENDPOINT,
  AzureGptImage2Client,
  type AzureGptImage2Request,
} from "./index.ts";
import {
  asFetch,
  assertJsonRequest,
  base64,
  expectProviderError,
  jpegBytes,
  jsonResponse,
  requestBody,
  TEST_API_KEY,
} from "./test_helpers.ts";

Deno.test("GPT Image 2 sends the exact Azure request and normalizes images", async () => {
  const encoded = base64(jpegBytes(1024, 1024));
  const client = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    fetch: asFetch((input, init) => {
      assert.equal(input, AZURE_GPT_IMAGE_2_ENDPOINT);
      assertJsonRequest(init);
      assert.deepEqual(requestBody(init), {
        model: "gpt-image-2",
        prompt: "An editorial still life",
        n: 2,
        size: "1024x1024",
        quality: "high",
        output_format: "jpeg",
        output_compression: 82,
        background: "opaque",
        moderation: "low",
      });
      return jsonResponse({
        created: 1_800_000_000,
        data: [
          { b64_json: encoded, revised_prompt: "Editorial still life" },
          { b64_json: encoded },
        ],
        usage: {
          input_tokens: 11,
          output_tokens: 22,
          total_tokens: 33,
          input_tokens_details: { image_tokens: 0, text_tokens: 11 },
          output_tokens_details: { image_tokens: 22, text_tokens: 0 },
        },
      });
    }),
  });

  const result = await client.generate({
    prompt: "An editorial still life",
    n: 2,
    size: "1024x1024",
    quality: "high",
    output_format: "jpeg",
    output_compression: 82,
    background: "opaque",
    moderation: "low",
  });

  assert.equal(result.created, 1_800_000_000);
  assert.equal(result.images.length, 2);
  assert.deepEqual(
    {
      mediaType: result.images[0].mediaType,
      width: result.images[0].width,
      height: result.images[0].height,
      revisedPrompt: result.images[0].revisedPrompt,
    },
    {
      mediaType: "image/jpeg",
      width: 1024,
      height: 1024,
      revisedPrompt: "Editorial still life",
    },
  );
  assert.ok(result.images[0].bytes instanceof Uint8Array);
  assert.deepEqual(result.usage, {
    inputTokens: 11,
    outputTokens: 22,
    totalTokens: 33,
    inputTokenDetails: { imageTokens: 0, textTokens: 11 },
    outputTokenDetails: { imageTokens: 22, textTokens: 0 },
  });
});

Deno.test("GPT Image 2 accepts its documented generation boundaries", async () => {
  const client = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    fetch: asFetch((_input, init) => {
      assert.deepEqual(requestBody(init), {
        model: "gpt-image-2",
        prompt: "x".repeat(32_000),
        n: 10,
        size: "3840x2160",
        quality: "low",
        output_format: "jpeg",
        output_compression: 0,
        background: "auto",
        moderation: "auto",
      });
      return jsonResponse({
        data: [{ b64_json: base64(jpegBytes(3840, 2160)) }],
      });
    }),
  });

  const result = await client.generate({
    prompt: "x".repeat(32_000),
    n: 10,
    size: "3840x2160",
    quality: "low",
    output_format: "jpeg",
    output_compression: 0,
    background: "auto",
    moderation: "auto",
  });
  assert.equal(result.images[0].width, 3840);
  assert.equal(result.images[0].height, 2160);
});

Deno.test("GPT Image 2 rejects unsupported or out-of-range request fields", async () => {
  let fetchCalls = 0;
  const client = new AzureGptImage2Client({
    apiKey: TEST_API_KEY,
    fetch: asFetch(() => {
      fetchCalls += 1;
      return jsonResponse({ data: [] });
    }),
  });
  const invalidRequests: unknown[] = [
    { prompt: "" },
    { prompt: "x".repeat(32_001) },
    { prompt: "ok", n: 0 },
    { prompt: "ok", n: 11 },
    { prompt: "ok", size: "800x800" },
    { prompt: "ok", size: "1000x1024" },
    { prompt: "ok", size: "3840x1264" },
    { prompt: "ok", size: "3840x2176" },
    { prompt: "ok", quality: "auto" },
    { prompt: "ok", output_format: "webp" },
    { prompt: "ok", output_compression: -1, output_format: "jpeg" },
    { prompt: "ok", output_compression: 101, output_format: "jpeg" },
    { prompt: "ok", output_compression: 50, output_format: "png" },
    { prompt: "ok", background: "transparent", output_format: "jpeg" },
    { prompt: "ok", moderation: "high" },
    { prompt: "ok", stream: true },
  ];

  for (const request of invalidRequests) {
    await expectProviderError(
      () => client.generate(request as AzureGptImage2Request),
      "invalid_input",
    );
  }
  assert.equal(fetchCalls, 0);
});
