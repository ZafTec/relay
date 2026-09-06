import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  createShareTokenCodec,
  hashShareToken,
  isShareToken,
  SHARE_TOKEN_LENGTH,
  ShareTokenCodec,
} from "./share-tokens.ts";

function key(version: number, byte: number) {
  return { version, secret: new Uint8Array(32).fill(byte) };
}

Deno.test("share tokens are deterministic, opaque, and hash-only for persistence", async () => {
  const codec = createShareTokenCodec({
    activeVersion: 7,
    keys: [key(7, 0xa7)],
  });
  const shareLinkId = "share_0123456789abcdef0123456789abcdef";

  const first = await codec.issue(shareLinkId);
  const second = await codec.issue(shareLinkId);

  assertEquals(first, second);
  assertEquals(first, {
    token: "Zhdzfhq42w3_YXK7dqlPTjFEhboHzNJRRJdreYhXkX8",
    tokenHash:
      "fa9feb906e3bb753933aeb16a5df641e803049bd3bb611aa1b34296b1fe5bec8",
    keyVersion: 7,
  });
  assertEquals(first.keyVersion, 7);
  assertEquals(first.token.length, SHARE_TOKEN_LENGTH);
  assertMatch(first.token, /^[A-Za-z0-9_-]+$/);
  assertMatch(first.tokenHash, /^[0-9a-f]{64}$/);
  assertEquals(first.tokenHash, await hashShareToken(first.token));
  assertEquals(first.token.includes(shareLinkId), false);
  assertEquals(isShareToken(first.token), true);

  const other = await codec.issue(
    "share_abcdef0123456789abcdef0123456789",
  );
  assertNotEquals(other.token, first.token);
  assertNotEquals(other.tokenHash, first.tokenHash);
});

Deno.test("share-token rotation verifies retained versions and issues only the active version", async () => {
  const oldCodec = new ShareTokenCodec({
    activeVersion: 1,
    keys: [key(1, 0x11)],
  });
  const shareLinkId = "share_11111111111111111111111111111111";
  const oldToken = await oldCodec.issue(shareLinkId);

  const rotated = new ShareTokenCodec({
    activeVersion: 2,
    keys: [key(2, 0x22), key(1, 0x11)],
  });
  assertEquals(rotated.activeVersion, 2);
  assertEquals(rotated.keyVersions, [1, 2]);
  assertEquals(rotated.hasVersion(1), true);
  assertEquals(rotated.hasVersion(2), true);
  assertEquals(rotated.hasVersion(99), false);
  assertEquals(await rotated.issueForVersion(shareLinkId, 1), oldToken);
  assertEquals(
    await rotated.validate({
      token: oldToken.token,
      shareLinkId,
      keyVersion: oldToken.keyVersion,
      tokenHash: oldToken.tokenHash,
    }),
    { kind: "valid", keyVersion: 1, tokenHash: oldToken.tokenHash },
  );

  const current = await rotated.issue(shareLinkId);
  assertEquals(current.keyVersion, 2);
  assertNotEquals(current.token, oldToken.token);
  assertEquals(
    await rotated.validate({
      token: current.token,
      shareLinkId,
      keyVersion: current.keyVersion,
      tokenHash: current.tokenHash,
    }),
    { kind: "valid", keyVersion: 2, tokenHash: current.tokenHash },
  );
});

Deno.test("share-token validation rejects tampering without exposing failure details", async () => {
  const codec = new ShareTokenCodec({
    activeVersion: 3,
    keys: [key(3, 0x33)],
  });
  const shareLinkId = "share_22222222222222222222222222222222";
  const issued = await codec.issue(shareLinkId);
  const replacement = issued.token.at(-1) === "A" ? "B" : "A";
  const tampered = `${issued.token.slice(0, -1)}${replacement}`;

  for (
    const input of [
      { ...issued, shareLinkId, token: tampered },
      { ...issued, shareLinkId: "share_33333333333333333333333333333333" },
      { ...issued, shareLinkId, tokenHash: "0".repeat(64) },
      { ...issued, shareLinkId, token: "not-a-token" },
      { ...issued, shareLinkId, tokenHash: "not-a-hash" },
      { ...issued, shareLinkId, keyVersion: 99 },
    ]
  ) {
    assertEquals(await codec.validate(input), { kind: "invalid" });
  }
});

Deno.test("share-token configuration rejects unsafe keys and versions", async () => {
  assertThrows(
    () => new ShareTokenCodec({ activeVersion: 1, keys: [] }),
    TypeError,
  );
  assertThrows(
    () =>
      new ShareTokenCodec({
        activeVersion: 1,
        keys: [{ version: 1, secret: new Uint8Array(31) }],
      }),
    TypeError,
  );
  assertThrows(
    () =>
      new ShareTokenCodec({
        activeVersion: 2,
        keys: [key(1, 1)],
      }),
    TypeError,
  );
  assertThrows(
    () =>
      new ShareTokenCodec({
        activeVersion: 1,
        keys: [key(1, 1), key(1, 2)],
      }),
    TypeError,
  );
  const codec = new ShareTokenCodec({ activeVersion: 1, keys: [key(1, 1)] });
  await assertRejects(() => codec.issue(" invalid "), TypeError);
  await assertRejects(
    () => codec.issueForVersion("share_11111111111111111111111111111111", 2),
    TypeError,
    "configured key",
  );
  await assertRejects(() => hashShareToken("invalid"), TypeError);
});
