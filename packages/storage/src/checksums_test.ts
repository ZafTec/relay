import { assertEquals } from "@std/assert";
import { checksumStream, md5Base64, sha256Hex } from "./checksums.ts";

const HELLO = new TextEncoder().encode("hello");

Deno.test("checksum helpers produce portable known digests", async () => {
  assertEquals(
    await sha256Hex(HELLO),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  );
  assertEquals(md5Base64(HELLO), "XUFAKrxLKna5cZ2REBfFkg==");
});

Deno.test("stream checksums count and digest every chunk", async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("he"));
      controller.enqueue(new TextEncoder().encode("llo"));
      controller.close();
    },
  });

  assertEquals(await checksumStream(stream), {
    sha256Hex:
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    contentMd5: "XUFAKrxLKna5cZ2REBfFkg==",
    sizeBytes: 5,
  });
});
