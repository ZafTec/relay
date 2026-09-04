import assert from "node:assert/strict";
import {
  AzureProviderError,
  type AzureProviderErrorClassification,
} from "./index.ts";
import type { FetchLike } from "./types.ts";

export const TEST_API_KEY = "test-api-key-secret-canary";

export function asFetch(
  handler: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Response | Promise<Response>,
): FetchLike {
  return handler as FetchLike;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function writeUint32Be(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = Math.floor(value / 0x1000000) & 0xff;
  bytes[offset + 1] = Math.floor(value / 0x10000) & 0xff;
  bytes[offset + 2] = Math.floor(value / 0x100) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function writeUint24Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = Math.floor(value / 0x100) & 0xff;
  bytes[offset + 2] = Math.floor(value / 0x10000) & 0xff;
}

function writeUint32Le(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = Math.floor(value / 0x100) & 0xff;
  bytes[offset + 2] = Math.floor(value / 0x10000) & 0xff;
  bytes[offset + 3] = Math.floor(value / 0x1000000) & 0xff;
}

function writeAscii(bytes: Uint8Array, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    bytes[offset + index] = value.charCodeAt(index);
  }
}

export function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  writeUint32Be(bytes, 8, 13);
  writeAscii(bytes, 12, "IHDR");
  writeUint32Be(bytes, 16, width);
  writeUint32Be(bytes, 20, height);
  return bytes;
}

export function jpegBytes(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    0xff,
    0xd9,
  ]);
}

export function webpBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  writeAscii(bytes, 0, "RIFF");
  writeUint32Le(bytes, 4, 22);
  writeAscii(bytes, 8, "WEBP");
  writeAscii(bytes, 12, "VP8X");
  writeUint32Le(bytes, 16, 10);
  writeUint24Le(bytes, 24, width - 1);
  writeUint24Le(bytes, 27, height - 1);
  return bytes;
}

export function imageDataUrl(
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  bytes: Uint8Array,
): string {
  return `data:${mediaType};base64,${base64(bytes)}`;
}

export function jsonResponse(
  value: unknown,
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return new Response(JSON.stringify(value), { ...init, headers });
}

export function requestBody(init: RequestInit | undefined): unknown {
  const body = init?.body;
  assert.equal(typeof body, "string");
  if (typeof body !== "string") throw new TypeError("Expected request body");
  return JSON.parse(body) as unknown;
}

export function assertJsonRequest(
  init: RequestInit | undefined,
  expectedApiKey = TEST_API_KEY,
): void {
  assert.equal(init?.method, "POST");
  assert.equal(init?.redirect, "error");
  assert.ok(init?.signal instanceof AbortSignal);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("authorization"), `Bearer ${expectedApiKey}`);
  assert.equal(headers.get("content-type"), "application/json");
}

export async function expectProviderError(
  operation: () => Promise<unknown>,
  classification: AzureProviderErrorClassification,
): Promise<AzureProviderError> {
  try {
    await operation();
    assert.fail(`Expected ${classification}`);
  } catch (error) {
    assert.ok(error instanceof AzureProviderError);
    assert.equal(error.classification, classification);
    return error;
  }
}
