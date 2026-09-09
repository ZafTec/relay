import {
  isLatestPromotionEligible,
  type ReleaseManifest,
  validateReleaseManifest,
  versionFromTag,
} from "./validation.ts";

const NOTE_PATH = /^docs\/release-notes\/[a-z0-9][a-z0-9-]*\.md$/;
const GENERATED_SECTIONS =
  /<!-- relay:(highlights|deployment):start -->[\s\S]*?<!-- relay:\1:end -->\s*/g;

/** Only published, older stable releases can delimit this release's highlights. */
export function previousReleaseTags(
  version: string,
  releases: unknown,
): string[] {
  // Reuse the release gate's validation of the GitHub API response.
  isLatestPromotionEligible(version, releases);
  return (releases as Array<{
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    published_at: string | null;
  }>).filter((release) => {
    if (release.draft || release.prerelease || !release.published_at) {
      return false;
    }
    try {
      versionFromTag(release.tag_name);
      return isLatestPromotionEligible(version, [release]);
    } catch {
      return false;
    }
  }).map((release) => release.tag_name).sort((left, right) => {
    const a = versionFromTag(left).split(".").map(BigInt);
    const b = versionFromTag(right).split(".").map(BigInt);
    for (let index = 0; index < 3; index++) {
      if (a[index] !== b[index]) return a[index] > b[index] ? -1 : 1;
    }
    return 0;
  });
}

async function git(args: string[], allowedCodes = [0]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!allowedCodes.includes(result.code)) {
    throw new Error(`git ${args[0]} failed with exit code ${result.code}`);
  }
  // merge-base uses exit 1 for a valid but unrelated ancestor candidate.
  return result.code === 1
    ? "not-ancestor"
    : new TextDecoder().decode(result.stdout);
}

export async function collectHighlights(
  manifest: ReleaseManifest,
  releases: unknown,
): Promise<string[]> {
  let previous: string | undefined;
  for (const tag of previousReleaseTags(manifest.version, releases)) {
    if (
      await git(["merge-base", "--is-ancestor", tag, manifest.revision], [
        0,
        1,
      ]) === ""
    ) {
      previous = tag;
      break;
    }
  }
  const files = previous
    ? await git([
      "diff",
      "--name-only",
      "--diff-filter=A",
      previous,
      manifest.revision,
      "--",
      "docs/release-notes",
    ])
    : await git([
      "ls-tree",
      "-r",
      "--name-only",
      manifest.revision,
      "--",
      "docs/release-notes",
    ]);
  const notes: string[] = [];
  for (
    const path of files.trim().split(/\r?\n/).filter((path) =>
      NOTE_PATH.test(path)
    ).sort()
  ) {
    // Read the tagged tree, never newer working-tree content.
    const note = (await git(["show", `${manifest.revision}:${path}`])).trim();
    if (!note || !note.startsWith("### ") || note.includes("<!-- relay:")) {
      throw new Error(
        `Release note ${path} must start with a level-three heading and contain no generated markers`,
      );
    }
    notes.push(note);
  }
  return notes;
}

export function renderReleaseNotes(input: {
  manifest: unknown;
  repository: string;
  release: {
    tag_name: string;
    draft: boolean;
    prerelease: boolean;
    body: string | null;
  };
  highlights: readonly string[];
}): string {
  const manifest = validateReleaseManifest(input.manifest);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    throw new Error("A GitHub owner/repository is required");
  }
  if (
    input.release.tag_name !== manifest.tag || !input.release.draft ||
    input.release.prerelease
  ) {
    throw new Error(
      "Notes can only be prepared for the matching stable draft release",
    );
  }
  const original = (input.release.body ?? "").replace(GENERATED_SECTIONS, "")
    .trim();
  if (!original) {
    throw new Error("The Release Please changelog must not be empty");
  }
  const { backend, web } = manifest.images;
  const repo = `https://github.com/${input.repository}`;
  const asset = (name: string) =>
    `[${name}](${repo}/releases/download/${manifest.tag}/${name})`;
  const highlights = input.highlights.length
    ? `<!-- relay:highlights:start -->\n## Highlights\n\n${
      input.highlights.join("\n\n")
    }\n<!-- relay:highlights:end -->\n\n`
    : "";
  const deployment = [
    "<!-- relay:deployment:start -->",
    "## Release details",
    "",
    "The backend (API and worker) and web images are built from the same source revision and published after image validation, vulnerability scans, and provenance checks.",
    "",
    "| Version | Source | Platform |",
    "| --- | --- | --- |",
    `| ${manifest.tag} | [\`${
      manifest.revision.slice(0, 12)
    }\`](${repo}/commit/${manifest.revision}) | \`${manifest.platform}\` |`,
    "",
    "## Container images",
    "",
    "Use these immutable version tags to deploy this exact release:",
    "",
    "```bash",
    `docker pull ${backend.tags.semver}`,
    `docker pull ${web.tags.semver}`,
    "```",
    "",
    "| Services | Image |",
    "| --- | --- |",
    `| API and worker | \`${backend.tags.semver}\` |`,
    `| Web | \`${web.tags.semver}\` |`,
    "",
    backend.plannedLatestTag
      ? "The `latest` tags also point to this release at publication. Pin version tags or digests for repeatable deployments."
      : "This older release preserves the current `latest` tags. Use the version tags or digests above to select it explicitly.",
    "",
    "## Upgrading",
    "",
    "Set the API and worker to the backend image above and the frontend to the web image. Back up production data and follow your deployment's migration procedure. Update the paired images together from the directory containing your production Compose file:",
    "",
    "```bash",
    "docker compose pull",
    "docker compose up -d",
    "docker compose ps",
    "```",
    "",
    `Confirm that \`/version\` reports \`${manifest.version}\` with revision \`${manifest.revision}\`, and that \`/health/ready\` reports healthy dependencies. Image publication does not deploy or migrate a running server.`,
    "",
    "<details>",
    "<summary>Image digests and verification files</summary>",
    "",
    "These references select the exact verified images, independently of any tag:",
    "",
    "```text",
    backend.reference,
    web.reference,
    "```",
    "",
    `The ${
      asset("release-manifest.json")
    } records the paired digests, source revision, and evidence filenames. Verify downloaded release assets with ${
      asset("SHA256SUMS")
    }.`,
    "",
    "| Image | Software inventory | Provenance | Vulnerability scan |",
    "| --- | --- | --- | --- |",
    ...([backend, web] as const).map((image, index) =>
      `| ${index === 0 ? "Backend" : "Web"} | ${asset(image.evidence.sbom)} | ${
        asset(image.evidence.provenance)
      } | ${asset(image.evidence.vulnerabilityScan)} |`
    ),
    "",
    "</details>",
    "<!-- relay:deployment:end -->",
  ].join("\n");
  return `${highlights}${original}\n\n${deployment}\n`;
}

if (import.meta.main) {
  const [manifestPath, releasePath, releasesPath, repository, output] =
    Deno.args;
  if (Deno.args.length !== 5) {
    throw new Error(
      "Usage: notes.ts <manifest.json> <release.json> <releases.json> <owner/repo> <output.md>",
    );
  }
  const manifest = validateReleaseManifest(
    JSON.parse(await Deno.readTextFile(manifestPath)),
  );
  const release = JSON.parse(await Deno.readTextFile(releasePath));
  const releases = JSON.parse(await Deno.readTextFile(releasesPath));
  const highlights = await collectHighlights(manifest, releases);
  const body = renderReleaseNotes({
    manifest,
    repository,
    release,
    highlights,
  });
  await Deno.writeTextFile(output, body);
}
