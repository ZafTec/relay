import { describe, expect, it } from "vitest";
import {
  calculateFileHashes,
  md5Base64,
  sha256Hex,
} from "../../src/lib/api/file-hashes";

describe("browser file hash adapter", () => {
  it.each([
    {
      input: "",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      md5: "1B2M2Y8AsgTpgAmY7PhCfg==",
    },
    {
      input: "abc",
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      md5: "kAFQmDzST7DWlj99KOF/cg==",
    },
    {
      input: "hello",
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      md5: "XUFAKrxLKna5cZ2REBfFkg==",
    },
  ])("hashes the standard vector %# without a dependency", async ({ input, sha256, md5 }) => {
    await expect(sha256Hex(input)).resolves.toBe(sha256);
    await expect(md5Base64(input)).resolves.toBe(md5);
  });

  it("hashes Blob bytes once through the combined file helper", async () => {
    const file = new Blob([new TextEncoder().encode("hello")], {
      type: "application/octet-stream",
    });

    await expect(calculateFileHashes(file)).resolves.toEqual({
      sha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      contentMd5: "XUFAKrxLKna5cZ2REBfFkg==",
    });
  });

  it("respects ArrayBufferView offsets", async () => {
    const bytes = new TextEncoder().encode("_abc_");
    const view = bytes.subarray(1, 4);

    await expect(md5Base64(view)).resolves.toBe("kAFQmDzST7DWlj99KOF/cg==");
  });
});
