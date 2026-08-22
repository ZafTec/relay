import { assertEquals, assertThrows } from "@std/assert";
import {
  parseTrustedProxyCidrs,
  prepareAuthRequest,
  RELAY_CLIENT_IP_HEADER,
  resolveClientIp,
} from "./proxy.ts";

Deno.test("an untrusted peer cannot spoof a forwarded client IP", () => {
  assertEquals(
    resolveClientIp("203.0.113.7", "198.51.100.9", ["10.0.0.0/8"]),
    "203.0.113.7",
  );
});

Deno.test("trusted proxy chains resolve to the first untrusted hop", () => {
  assertEquals(
    resolveClientIp(
      "10.0.0.4",
      "198.51.100.9, 10.0.0.3",
      ["10.0.0.0/8"],
    ),
    "198.51.100.9",
  );
  assertEquals(
    resolveClientIp("2001:db8:1::4", "2001:db8:2::9", ["2001:db8:1::/48"]),
    "2001:db8:2::9",
  );
});

Deno.test("IPv4-mapped IPv6 peers match IPv4 trusted-proxy CIDRs", () => {
  assertEquals(
    resolveClientIp(
      "::ffff:10.0.0.4",
      "198.51.100.9, ::ffff:10.0.0.3",
      ["10.0.0.0/8"],
    ),
    "198.51.100.9",
  );
  assertEquals(resolveClientIp("::ffff:203.0.113.7", null, []), "203.0.113.7");
});

Deno.test("malformed forwarding data fails closed to the immediate peer", () => {
  assertEquals(
    resolveClientIp("10.0.0.4", "198.51.100.9, not-an-ip", ["10.0.0.0/8"]),
    "10.0.0.4",
  );
});

Deno.test("prepareAuthRequest strips forwarded host/protocol and overwrites IP headers", () => {
  const request = prepareAuthRequest(
    new Request("https://relay.example/api/auth/ok", {
      headers: {
        "cf-connecting-ip": "192.0.2.10",
        "x-forwarded-for": "198.51.100.9",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
        [RELAY_CLIENT_IP_HEADER]: "192.0.2.11",
      },
    }),
    { remoteAddress: "203.0.113.7", trustedProxyCidrs: ["10.0.0.0/8"] },
  );

  assertEquals(request.headers.get(RELAY_CLIENT_IP_HEADER), "203.0.113.7");
  assertEquals(request.headers.has("x-forwarded-for"), false);
  assertEquals(request.headers.has("x-forwarded-host"), false);
  assertEquals(request.headers.has("x-forwarded-proto"), false);
  assertEquals(request.headers.has("cf-connecting-ip"), false);
});

Deno.test("trusted proxy configuration rejects malformed entries", () => {
  assertEquals(
    parseTrustedProxyCidrs("10.0.0.0/8, 2001:db8::/32"),
    ["10.0.0.0/8", "2001:db8::/32"],
  );
  assertThrows(
    () => parseTrustedProxyCidrs("10.0.0.0/99"),
    Error,
    "invalid IP/CIDR",
  );
});
