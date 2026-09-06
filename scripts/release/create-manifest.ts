import {
  createReleaseManifest,
  serializeReleaseManifest,
} from "./validation.ts";

const REQUIRED_FLAGS = [
  "--version",
  "--tag",
  "--revision",
  "--backend-repository",
  "--backend-digest",
  "--backend-candidate",
  "--web-repository",
  "--web-digest",
  "--web-candidate",
  "--promote-latest",
  "--output",
] as const;

function usage(): never {
  console.error(
    "Usage: deno run --allow-write scripts/release/create-manifest.ts " +
      REQUIRED_FLAGS.map((flag) => `${flag} <value>`).join(" "),
  );
  Deno.exit(2);
}

function parseFlags(args: readonly string[]): ReadonlyMap<string, string> {
  if (args.length !== REQUIRED_FLAGS.length * 2) usage();
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !REQUIRED_FLAGS.includes(key as typeof REQUIRED_FLAGS[number]) ||
      value === undefined || parsed.has(key)
    ) {
      usage();
    }
    parsed.set(key, value);
  }
  return parsed;
}

function required(parsed: ReadonlyMap<string, string>, name: string): string {
  const value = parsed.get(name);
  if (value === undefined) usage();
  return value;
}

async function main(args: readonly string[]): Promise<void> {
  const parsed = parseFlags(args);
  const promoteLatest = required(parsed, "--promote-latest");
  if (promoteLatest !== "true" && promoteLatest !== "false") {
    throw new Error("--promote-latest must be true or false");
  }

  const manifest = createReleaseManifest({
    version: required(parsed, "--version"),
    tag: required(parsed, "--tag"),
    revision: required(parsed, "--revision"),
    backendRepository: required(parsed, "--backend-repository"),
    backendDigest: required(parsed, "--backend-digest"),
    backendCandidate: required(parsed, "--backend-candidate"),
    webRepository: required(parsed, "--web-repository"),
    webDigest: required(parsed, "--web-digest"),
    webCandidate: required(parsed, "--web-candidate"),
    promoteLatest: promoteLatest === "true",
  });
  const output = required(parsed, "--output");
  await Deno.writeTextFile(output, serializeReleaseManifest(manifest));
  console.log(output);
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(
      `release manifest creation failed: ${
        error instanceof Error ? error.message : error
      }`,
    );
    Deno.exit(1);
  }
}
