import {
  isLatestPromotionEligible,
  isMissingRegistryReferenceError,
  serializeReleaseManifest,
  validateDigest,
  validateFullSha,
  validateImageInspection,
  validateReleaseManifest,
  validateVersion,
  versionFromTag,
} from "./validation.ts";

function usage(): never {
  console.error(
    "Usage:\n" +
      "  deno run --allow-read scripts/release/validate.ts tag --tag vX.Y.Z --version-file version.txt --sha <full-sha>\n" +
      "  deno run scripts/release/validate.ts digest --digest sha256:<64-hex>\n" +
      "  deno run --allow-read scripts/release/validate.ts latest --version X.Y.Z --releases-file releases.json\n" +
      "  deno run --allow-read scripts/release/validate.ts image --manifest-file manifest.json --image-file image.json --digest sha256:<64-hex> --version X.Y.Z --revision <full-sha> --created <timestamp>\n" +
      "  deno run --allow-read scripts/release/validate.ts registry-error --reference namespace/name:tag --error-file error.txt\n" +
      "  deno run --allow-read scripts/release/validate.ts manifest --file release-manifest.json",
  );
  Deno.exit(2);
}

function flags(args: readonly string[]): ReadonlyMap<string, string> {
  if (args.length % 2 !== 0) usage();
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key.startsWith("--") || value === undefined || parsed.has(key)) {
      usage();
    }
    parsed.set(key, value);
  }
  return parsed;
}

function required(
  parsed: ReadonlyMap<string, string>,
  name: string,
  allowed: readonly string[],
): string {
  for (const key of parsed.keys()) {
    if (!allowed.includes(key)) usage();
  }
  const value = parsed.get(name);
  if (value === undefined) usage();
  return value;
}

async function main(args: readonly string[]): Promise<void> {
  const [command, ...rest] = args;
  const parsed = flags(rest);

  switch (command) {
    case "tag": {
      const allowed = ["--tag", "--version-file", "--sha"];
      const tag = required(parsed, "--tag", allowed);
      const versionFile = required(parsed, "--version-file", allowed);
      const sha = required(parsed, "--sha", allowed);
      const versionText = await Deno.readTextFile(versionFile);
      if (!/^\d+\.\d+\.\d+\r?\n$/.test(versionText)) {
        throw new Error(`${versionFile} must contain one SemVer line`);
      }
      const version = validateVersion(versionText.trimEnd());
      if (versionFromTag(tag) !== version) {
        throw new Error(`${tag} does not match ${versionFile} (${version})`);
      }
      validateFullSha(sha);
      console.log(version);
      return;
    }
    case "digest": {
      const digest = required(parsed, "--digest", ["--digest"]);
      validateDigest(digest);
      console.log(digest);
      return;
    }
    case "latest": {
      const allowed = ["--version", "--releases-file"];
      const version = required(parsed, "--version", allowed);
      const releasesFile = required(parsed, "--releases-file", allowed);
      const releases = JSON.parse(await Deno.readTextFile(releasesFile));
      console.log(isLatestPromotionEligible(version, releases));
      return;
    }
    case "image": {
      const allowed = [
        "--manifest-file",
        "--image-file",
        "--digest",
        "--version",
        "--revision",
        "--created",
      ];
      const manifestFile = required(parsed, "--manifest-file", allowed);
      const imageFile = required(parsed, "--image-file", allowed);
      const digest = required(parsed, "--digest", allowed);
      const version = required(parsed, "--version", allowed);
      const revision = required(parsed, "--revision", allowed);
      const created = required(parsed, "--created", allowed);
      validateImageInspection(
        JSON.parse(await Deno.readTextFile(manifestFile)),
        JSON.parse(await Deno.readTextFile(imageFile)),
        { digest, version, revision, created },
      );
      console.log(`${digest} linux/amd64`);
      return;
    }
    case "registry-error": {
      const allowed = ["--reference", "--error-file"];
      const reference = required(parsed, "--reference", allowed);
      const errorFile = required(parsed, "--error-file", allowed);
      const stderr = await Deno.readTextFile(errorFile);
      console.log(
        isMissingRegistryReferenceError(stderr, reference)
          ? "missing"
          : "fatal",
      );
      return;
    }
    case "manifest": {
      const file = required(parsed, "--file", ["--file"]);
      const source = await Deno.readTextFile(file);
      const manifest = validateReleaseManifest(JSON.parse(source));
      if (source !== serializeReleaseManifest(manifest)) {
        throw new Error(`${file} is valid but is not canonically serialized`);
      }
      console.log(`${manifest.tag} ${manifest.revision}`);
      return;
    }
    default:
      usage();
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (error) {
    console.error(
      `release validation failed: ${
        error instanceof Error ? error.message : error
      }`,
    );
    Deno.exit(1);
  }
}
