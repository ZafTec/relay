import assert from "node:assert/strict";
import {
  AZURE_MISTRAL_OCR_ENDPOINT,
  AzureMistralOcrClient,
  type AzureMistralOcrRequest,
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
} from "./test_helpers.ts";

const PDF_DATA_URL = "data:application/pdf;base64,JVBERi0xLjQ=";
const ANNOTATION_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "invoice",
    description: "Invoice fields",
    schema: {
      type: "object",
      properties: { invoice_number: { type: "string" } },
      additionalProperties: false,
    },
    strict: true,
  },
};

Deno.test("Mistral OCR sends the exact Azure request and preserves normalized output", async () => {
  const embeddedImage = imageDataUrl("image/png", pngBytes(32, 16));
  const client = new AzureMistralOcrClient({
    apiKey: TEST_API_KEY,
    fetch: asFetch((input, init) => {
      assert.equal(input, AZURE_MISTRAL_OCR_ENDPOINT);
      assertJsonRequest(init);
      assert.deepEqual(requestBody(init), {
        model: "mistral-ocr-4-0",
        document: {
          type: "document_url",
          document_url: PDF_DATA_URL,
        },
        pages: [0, 2],
        include_image_base64: true,
        image_limit: 8,
        image_min_size: 64,
        bbox_annotation_format: ANNOTATION_FORMAT,
        document_annotation_format: ANNOTATION_FORMAT,
        document_annotation_prompt: "Extract invoice metadata",
        table_format: "markdown",
        extract_header: true,
        extract_footer: true,
        confidence_scores_granularity: "word",
      });
      return jsonResponse({
        pages: [{
          index: 0,
          markdown: "# Invoice\n\n| Item | Total |",
          images: [{
            id: "img-0.png",
            top_left_x: 10,
            top_left_y: 20,
            bottom_right_x: 42,
            bottom_right_y: 36,
            image_base64: embeddedImage,
            image_annotation: '{"kind":"logo"}',
          }],
          tables: [{
            id: "table-0",
            content: "| Item | Total |",
            format: "markdown",
            word_confidence_scores: [{
              text: "Item",
              confidence: 0.98,
              start_index: 2,
            }],
          }],
          header: "Invoice 17",
          footer: "Page 1",
          dimensions: { dpi: 200, height: 800, width: 600 },
          confidence_scores: {
            average_page_confidence_score: 0.97,
            minimum_page_confidence_score: 0.81,
            word_confidence_scores: [{
              text: "Invoice",
              confidence: 0.99,
              start_index: 2,
            }],
          },
        }],
        model: "mistral-ocr-4-0",
        document_annotation: '{"invoice_number":"17"}',
        usage_info: { pages_processed: 1, doc_size_bytes: null },
      });
    }),
  });

  const result = await client.process({
    document: PDF_DATA_URL,
    pages: [0, 2],
    include_image_base64: true,
    image_limit: 8,
    image_min_size: 64,
    bbox_annotation_format: ANNOTATION_FORMAT,
    document_annotation_format: ANNOTATION_FORMAT,
    document_annotation_prompt: "Extract invoice metadata",
    table_format: "markdown",
    extract_header: true,
    extract_footer: true,
    confidence_scores_granularity: "word",
  });

  assert.equal(result.pages.length, 1);
  const page = result.pages[0];
  assert.equal(page.markdown, "# Invoice\n\n| Item | Total |");
  assert.deepEqual(page.dimensions, { dpi: 200, height: 800, width: 600 });
  assert.equal(page.header, "Invoice 17");
  assert.equal(page.footer, "Page 1");
  assert.deepEqual(page.tables[0], {
    id: "table-0",
    content: "| Item | Total |",
    format: "markdown",
    wordConfidenceScores: [{
      text: "Item",
      confidence: 0.98,
      startIndex: 2,
    }],
  });
  assert.deepEqual(
    {
      id: page.images[0].id,
      topLeftX: page.images[0].topLeftX,
      topLeftY: page.images[0].topLeftY,
      bottomRightX: page.images[0].bottomRightX,
      bottomRightY: page.images[0].bottomRightY,
      annotation: page.images[0].annotation,
      mediaType: page.images[0].image?.mediaType,
      width: page.images[0].image?.width,
      height: page.images[0].image?.height,
    },
    {
      id: "img-0.png",
      topLeftX: 10,
      topLeftY: 20,
      bottomRightX: 42,
      bottomRightY: 36,
      annotation: '{"kind":"logo"}',
      mediaType: "image/png",
      width: 32,
      height: 16,
    },
  );
  assert.deepEqual(page.confidenceScores, {
    averagePageConfidenceScore: 0.97,
    minimumPageConfidenceScore: 0.81,
    wordConfidenceScores: [{
      text: "Invoice",
      confidence: 0.99,
      startIndex: 2,
    }],
  });
  assert.equal(result.documentAnnotation, '{"invoice_number":"17"}');
  assert.deepEqual(result.usageInfo, {
    pagesProcessed: 1,
    documentSizeBytes: null,
  });
});

Deno.test("Mistral OCR maps image data URLs to image_url documents", async () => {
  const document = imageDataUrl("image/jpeg", new Uint8Array([1, 2, 3]));
  const client = new AzureMistralOcrClient({
    apiKey: TEST_API_KEY,
    fetch: asFetch((_input, init) => {
      assert.deepEqual(requestBody(init), {
        model: "mistral-ocr-4-0",
        document: { type: "image_url", image_url: document },
        pages: "0,2-4",
        confidence_scores_granularity: "page",
      });
      return jsonResponse({
        pages: [],
        model: "mistral-ocr-4-0",
        usage_info: { pages_processed: 0, doc_size_bytes: 3 },
      });
    }),
  });

  const result = await client.process({
    document,
    pages: "0,2-4",
    confidence_scores_granularity: "page",
  });
  assert.deepEqual(result, {
    pages: [],
    documentAnnotation: null,
    usageInfo: { pagesProcessed: 0, documentSizeBytes: 3 },
  });
});

Deno.test("Mistral OCR rejects invalid and unbounded request DTOs", async () => {
  let fetchCalls = 0;
  const client = new AzureMistralOcrClient({
    apiKey: TEST_API_KEY,
    fetch: asFetch(() => {
      fetchCalls += 1;
      return jsonResponse({});
    }),
  });
  const invalidRequests: unknown[] = [
    { document: "https://example.test/document.pdf" },
    { document: "data:text/plain;base64,SGVsbG8=" },
    { document: "data:application/pdf;base64,not base64" },
    { document: PDF_DATA_URL, pages: [] },
    { document: PDF_DATA_URL, pages: "0,2-1" },
    { document: PDF_DATA_URL, pages: "0-1000" },
    { document: PDF_DATA_URL, image_limit: -1 },
    { document: PDF_DATA_URL, image_min_size: -1 },
    {
      document: PDF_DATA_URL,
      document_annotation_prompt: "Extract metadata",
    },
    {
      document: PDF_DATA_URL,
      confidence_scores_granularity: "block",
    },
    {
      document: PDF_DATA_URL,
      bbox_annotation_format: { type: "text" },
    },
    { document: PDF_DATA_URL, include_blocks: true },
  ];

  for (const request of invalidRequests) {
    await expectProviderError(
      () => client.process(request as AzureMistralOcrRequest),
      "invalid_input",
    );
  }
  assert.equal(fetchCalls, 0);
});

Deno.test("Mistral OCR strictly rejects malformed response DTOs", async () => {
  const malformedResponses: unknown[] = [
    { model: "mistral-ocr-4-0", pages: {}, usage_info: {} },
    {
      model: "mistral-ocr-4-0",
      pages: [{ index: 0, markdown: "x", images: [], dimensions: {} }],
      usage_info: { pages_processed: 1 },
    },
    {
      model: "mistral-ocr-4-0",
      pages: [{
        index: 0,
        markdown: "x",
        images: [],
        tables: [{ id: "t", content: "x", format: "csv" }],
        dimensions: null,
      }],
      usage_info: { pages_processed: 1 },
    },
    {
      model: "mistral-ocr-4-0",
      pages: [{
        index: 0,
        markdown: "x",
        images: [{
          id: "i",
          top_left_x: 2,
          top_left_y: 0,
          bottom_right_x: 1,
          bottom_right_y: 1,
        }],
        dimensions: null,
      }],
      usage_info: { pages_processed: 1 },
    },
    {
      model: "mistral-ocr-4-0",
      pages: Array(1_001).fill({
        index: 0,
        markdown: "x",
        images: [],
        dimensions: null,
      }),
      usage_info: { pages_processed: 1 },
    },
    { model: "mistral-ocr-4-0", pages: [], usage_info: {} },
  ];

  for (const response of malformedResponses) {
    const client = new AzureMistralOcrClient({
      apiKey: TEST_API_KEY,
      fetch: asFetch(() => jsonResponse(response)),
    });
    await expectProviderError(
      () => client.process({ document: PDF_DATA_URL }),
      "invalid_response",
    );
  }
});

Deno.test("Mistral OCR bounds and validates embedded image base64", async () => {
  const invalidImage = base64(new Uint8Array([1, 2, 3, 4]));
  const client = new AzureMistralOcrClient({
    apiKey: TEST_API_KEY,
    fetch: asFetch(() =>
      jsonResponse({
        model: "mistral-ocr-4-0",
        pages: [{
          index: 0,
          markdown: "x",
          images: [{
            id: "image",
            top_left_x: null,
            top_left_y: null,
            bottom_right_x: null,
            bottom_right_y: null,
            image_base64: invalidImage,
          }],
          dimensions: null,
        }],
        usage_info: { pages_processed: 1 },
      })
    ),
  });

  await expectProviderError(
    () => client.process({ document: PDF_DATA_URL }),
    "invalid_response",
  );
});
