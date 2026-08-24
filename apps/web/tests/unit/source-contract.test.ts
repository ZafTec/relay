import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function read(relativePath: string): Promise<string> {
  return readFile(resolve(process.cwd(), relativePath), "utf8");
}

describe("v3 production source contract", () => {
  it("keeps the Ledger direction comment as the first emitted body child", async () => {
    const html = await read("index.html");
    expect(html).toContain("<body><!-- direction-contract: Relay v3 Ledger.");
  });

  it("uses precise transitions and never transition all", async () => {
    const css = await read("src/styles/globals.css");
    expect(css).not.toMatch(/transition\s*:\s*all/i);
  });

  it("emits a valid stage duration and reveals the hero in six discrete stages", async () => {
    const [tokens, css] = await Promise.all([
      read("src/styles/tokens.css"),
      read("src/styles/globals.css"),
    ]);
    expect(tokens).toContain("--relay-motion-stage: 220ms;");
    expect(tokens).not.toContain("220ms per stage");
    expect(css).toContain("calc(var(--relay-motion-stage) * 6)");
    expect(css).toContain("steps(6, end)");
    expect(css).toContain("clip-path: inset(0 100% 0 0)");
  });

  it("does not import canvas runtime, remote fonts, or CDN resources", async () => {
    const files = await Promise.all([
      read("index.html"),
      read("src/main.tsx"),
      read("src/styles/fonts.css"),
      read("src/features/landing/LandingPage.tsx"),
    ]);
    const source = files.join("\n");
    expect(source).not.toMatch(/support\.js|_ds_bundle|unpkg|fonts\.googleapis|design\/v3/i);
  });

  it("uses corrected copied asset paths", async () => {
    const landing = await read("src/features/landing/LandingPage.tsx");
    expect(landing).toContain("/relay/assets/hero-agent-to-artifact.svg");
    expect(landing).not.toContain("design/relay/assets");
  });
});
