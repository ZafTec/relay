import { assertEquals, assertThrows } from "@std/assert";
import { decodeCursor, encodeCursor, InvalidCursorError } from "./cursor.ts";

Deno.test("application cursors round-trip scope, filters, and positions", () => {
  const cursor = encodeCursor("runs", '{"statuses":null}', [
    "2026-08-24T10:00:00.000Z",
    "run_0123456789abcdef0123456789abcdef",
  ]);
  assertEquals(
    decodeCursor(cursor, "runs", '{"statuses":null}', 2),
    [
      "2026-08-24T10:00:00.000Z",
      "run_0123456789abcdef0123456789abcdef",
    ],
  );
});

Deno.test("application cursors cannot be reused across resources or filters", () => {
  const cursor = encodeCursor("runs", "filter-a", ["one", "two"]);
  assertThrows(
    () => decodeCursor(cursor, "artifacts", "filter-a", 2),
    InvalidCursorError,
  );
  assertThrows(
    () => decodeCursor(cursor, "runs", "filter-b", 2),
    InvalidCursorError,
  );
});
