import { assertEquals, assertThrows } from "@std/assert";
import { parseImageSource } from "./image-source.ts";
Deno.test("identity images accept provider links and reject active content or oversized payloads", () => {
  assertEquals(
    parseImageSource("https://lh3.googleusercontent.com/profile"),
    "https://lh3.googleusercontent.com/profile",
  );
  assertEquals(parseImageSource(null), null);
  for (
    const value of [
      "javascript:alert(1)",
      "http://example.com/photo",
      "https://user:secret@example.com/photo",
      "data:image/svg+xml;base64,PHN2Zz4=",
      "data:image/png;base64,aGVsbG8=",
      "x".repeat(65537),
    ]
  ) assertThrows(() => parseImageSource(value));
  const jpeg = "data:image/jpeg;base64," +
    btoa("\xff\xd8\xff" + "0".repeat(20));
  assertEquals(parseImageSource(jpeg), jpeg);
});
