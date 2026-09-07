import assert from "node:assert/strict";
import {
  AZURE_FLUX_2_PRO_PATH,
  AzureFlux2ProClient,
  type AzureFlux2ProRequest,
} from "./index.ts";
import {
  asFetch,
  assertJsonRequest,
  base64,
  expectProviderError,
  imageDataUrl,
  jsonResponse,
  pngBytes,
  requestBody,
  TEST_API_KEY,
  TEST_AZURE_BASE_URL,
  webpBytes,
} from "./test_helpers.ts";

Deno.test("FLUX.2 Pro sends fixed model/n and numbered input image fields", async () => {
  const first = imageDataUrl("image/png", pngBytes(64, 64));
  const second = imageDataUrl("image/webp", webpBytes(64, 64));
  const client = new AzureFlux2ProClient({
    baseUrl: TEST_AZURE_BASE_URL,
    apiKey: TEST_API_KEY,
    fetch: asFetch((input, init) => {
      assert.equal(input, TEST_AZURE_BASE_URL + AZURE_FLUX_2_PRO_PATH);
      assertJsonRequest(init);
      assert.deepEqual(requestBody(init), {
        model: "FLUX.2-pro",
        n: 1,
        prompt: "A precise product photograph",
        disable_pup: true,
        input_image: first,
        input_image_2: second,
        seed: 42,
        width: 1600,
        height: 1024,
        safety_tolerance: 3,
        output_format: "webp",
      });
      return jsonResponse({
        data: [{ b64_json: base64(webpBytes(1600, 1024)) }],
      });
    }),
  });

  const result = await client.generate({
    prompt: "A precise product photograph",
    disable_pup: true,
    input_images: [first, second],
    seed: 42,
    width: 1600,
    height: 1024,
    safety_tolerance: 3,
    output_format: "webp",
  });

  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].mediaType, "image/webp");
  assert.equal(result.images[0].width, 1600);
  assert.equal(result.images[0].height, 1024);
});

Deno.test("FLUX.2 Pro maps all eight trusted data URLs", async () => {
  const dataUrl = imageDataUrl("image/png", pngBytes(64, 64));
  const client = new AzureFlux2ProClient({
    baseUrl: TEST_AZURE_BASE_URL,
    apiKey: TEST_API_KEY,
    fetch: asFetch((_input, init) => {
      const body = requestBody(init) as Record<string, unknown>;
      assert.equal(body.input_image, dataUrl);
      for (let index = 2; index <= 8; index += 1) {
        assert.equal(body[`input_image_${index}`], dataUrl);
      }
      assert.equal("input_images" in body, false);
      return jsonResponse({
        data: [{ b64_json: base64(pngBytes(2048, 2048)) }],
      });
    }),
  });

  const result = await client.generate({
    prompt: "Combine references",
    input_images: Array(8).fill(dataUrl),
    width: 2048,
    height: 2048,
    output_format: "png",
  });
  assert.equal(result.images[0].width, 2048);
});

Deno.test("FLUX.2 Pro rejects unsafe URLs and capability violations", async () => {
  let fetchCalls = 0;
  const dataUrl = imageDataUrl("image/png", pngBytes(64, 64));
  const client = new AzureFlux2ProClient({
    baseUrl: TEST_AZURE_BASE_URL,
    apiKey: TEST_API_KEY,
    fetch: asFetch(() => {
      fetchCalls += 1;
      return jsonResponse({ data: [] });
    }),
  });
  const invalidRequests: unknown[] = [
    { prompt: "" },
    { prompt: "ok", input_images: [] },
    { prompt: "ok", input_images: Array(9).fill(dataUrl) },
    { prompt: "ok", input_images: ["https://example.test/private.png"] },
    { prompt: "ok", input_images: ["data:image/png;base64,not base64"] },
    { prompt: "ok", width: 63 },
    { prompt: "ok", height: 63 },
    { prompt: "ok", width: 2048, height: 2064 },
    { prompt: "ok", safety_tolerance: -1 },
    { prompt: "ok", safety_tolerance: 6 },
    { prompt: "ok", output_format: "gif" },
    { prompt: "ok", seed: 1.5 },
    { prompt: "ok", n: 2 },
  ];

  for (const request of invalidRequests) {
    await expectProviderError(
      () => client.generate(request as AzureFlux2ProRequest),
      "invalid_input",
    );
  }
  assert.equal(fetchCalls, 0);
});
