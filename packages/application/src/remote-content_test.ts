import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  fetchRemoteContent,
  isPublicAddress,
  MAX_URL_IMPORT_BYTES,
  publicFileUrl,
  type RemoteContentDependencies,
  RemoteContentError,
} from "./remote-content.ts";

Deno.test("URL imports reject private, reserved, mapped and non-HTTP destinations", () => {
  for (
    const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.31.4.2",
      "169.254.169.254",
      "100.64.0.1",
      "192.168.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fe80::1",
      "fc00::1",
      "2002:7f00:1::",
      "2001:db8::1",
    ]
  ) assertEquals(isPublicAddress(address), false, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
    assertEquals(isPublicAddress(address), true, address);
  }
  for (
    const url of [
      "file:///etc/passwd",
      "http://2130706433/a",
      "http://0x7f000001/",
      "https://user:secret@example.com/a",
      "http://[::ffff:127.0.0.1]/",
      "https://example.com:8080/file",
    ]
  ) assertThrows(() => publicFileUrl(url), RemoteContentError);
});
function source(text = "saved content"): RemoteContentDependencies {
  return {
    resolve: () => Promise.resolve([{ address: "8.8.8.8", family: 4 }]),
    request: () =>
      Promise.resolve({
        status: 200,
        type: "text/plain",
        body: (async function* () {
          yield new TextEncoder().encode(text);
        })(),
        close() {},
      }),
  };
}
Deno.test("URL imports pin a validated DNS address and return actual bytes", async () => {
  const dependencies = source();
  let requested = false;
  const request = dependencies.request;
  dependencies.request = (url, address, signal) => {
    requested = true;
    assertEquals(url.hostname, "files.example.test");
    assertEquals(address.address, "8.8.8.8");
    return request(url, address, signal);
  };
  const result = await fetchRemoteContent(
    "https://files.example.test/report.txt",
    dependencies,
  );
  assertEquals(requested, true);
  assertEquals(result.name, "report.txt");
  assertEquals(new TextDecoder().decode(result.bytes), "saved content");
  assertEquals(result.mimeType, "text/plain");
});
Deno.test("URL imports reject private DNS answers and revalidate redirects before connecting", async () => {
  const dependencies = source();
  let calls = 0;
  dependencies.request = () => {
    calls++;
    return Promise.resolve({
      status: 302,
      location: "http://169.254.169.254/latest/meta-data",
      body: (async function* () {})(),
      close() {},
    });
  };
  await assertRejects(
    () => fetchRemoteContent("https://public.example.test/file", dependencies),
    RemoteContentError,
  );
  assertEquals(calls, 1);
  dependencies.resolve = () =>
    Promise.resolve([{ address: "8.8.8.8", family: 4 }, {
      address: "127.0.0.1",
      family: 4,
    }]);
  await assertRejects(
    () => fetchRemoteContent("https://mixed.example.test/file", dependencies),
    RemoteContentError,
  );
  assertEquals(calls, 1);
});
Deno.test("URL imports reject oversized streams, false MIME types and redirect loops", async () => {
  let closed = 0;
  const dependencies = source();
  dependencies.request = () =>
    Promise.resolve({
      status: 200,
      type: "image/png",
      body: (async function* () {
        yield new TextEncoder().encode("not a PNG");
      })(),
      close() {
        closed++;
      },
    });
  await assertRejects(
    () => fetchRemoteContent("https://files.example.test/file", dependencies),
    RemoteContentError,
  );
  dependencies.request = () =>
    Promise.resolve({
      status: 200,
      body: (async function* () {
        yield new Uint8Array(MAX_URL_IMPORT_BYTES);
        yield new Uint8Array(1);
      })(),
      close() {
        closed++;
      },
    });
  await assertRejects(
    () => fetchRemoteContent("https://files.example.test/file", dependencies),
    RemoteContentError,
  );
  dependencies.request = () =>
    Promise.resolve({
      status: 302,
      location: "/file",
      body: (async function* () {})(),
      close() {
        closed++;
      },
    });
  await assertRejects(
    () => fetchRemoteContent("https://files.example.test/file", dependencies),
    RemoteContentError,
  );
  assertEquals(closed, 6);
});
