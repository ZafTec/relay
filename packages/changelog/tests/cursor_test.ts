import assert from "node:assert/strict";
import {
  decodePublicChangelogCursor,
  encodePublicChangelogCursor,
} from "../src/cursor.ts";

Deno.test("public changelog cursors round-trip both deterministic order keys", () => {
  const cursor = {
    releasedAt: "2026-08-23T12:34:56.789Z",
    releaseId: "922337203685477580",
  };
  const encoded = encodePublicChangelogCursor(cursor);

  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodePublicChangelogCursor(encoded), cursor);
  assert.equal(encodePublicChangelogCursor(cursor), encoded);
});

Deno.test("public changelog cursors reject malformed or partial state", () => {
  for (
    const value of [
      "not+a+base64url+cursor",
      btoa(JSON.stringify({ v: 1, releasedAt: "not-a-date", releaseId: "1" })),
      btoa(JSON.stringify({ v: 1, releasedAt: new Date().toISOString() })),
      btoa(JSON.stringify({
        v: 1,
        releasedAt: new Date().toISOString(),
        releaseId: "0",
      })),
    ]
  ) {
    assert.throws(() => decodePublicChangelogCursor(value), TypeError);
  }
});
