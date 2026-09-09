import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import { validateVersion } from "./validation.ts";

const repositoryRoot = new URL("../../", import.meta.url);

function readRepositoryFile(path: string): Promise<string> {
  return Deno.readTextFile(new URL(path, repositoryRoot));
}

Deno.test("release actions are commit pinned with verified version comments", async () => {
  const workflows = await Promise.all([
    readRepositoryFile(".github/workflows/release-images.yml"),
    readRepositoryFile(".github/workflows/release-please.yml"),
  ]);
  const source = workflows.join("\n");
  const usesLines = [...source.matchAll(/^\s*uses:\s*(\S+).*$/gm)];
  const pins = [...source.matchAll(
    /^\s*uses:\s*([^@\s]+)@([0-9a-f]{40})\s+#\s+(v\d+\.\d+\.\d+)\s*$/gm,
  )];
  assertEquals(pins.length, usesLines.length);

  const expected = new Map([
    ["actions/checkout@v7.0.1", "3d3c42e5aac5ba805825da76410c181273ba90b1"],
    ["denoland/setup-deno@v2.0.5", "22d081ff2d3a40755e97629de92e3bcbfa7cf2ed"],
    ["docker/login-action@v4.6.0", "dbcb813823bdd20940b903addbd779551569679f"],
    [
      "docker/setup-buildx-action@v4.3.0",
      "37fe631027851001ddb9b187196cc803df7f5f0e",
    ],
    [
      "docker/build-push-action@v7.3.0",
      "53b7df96c91f9c12dcc8a07bcb9ccacbed38856a",
    ],
    ["anchore/sbom-action@v0.24.0", "e22c389904149dbc22b58101806040fa8d37a610"],
    [
      "actions/attest-build-provenance@v4.2.2",
      "4d101475d8b20a2381f78447822ac1eab6504dd8",
    ],
    [
      "aquasecurity/trivy-action@v0.36.0",
      "ed142fd0673e97e23eac54620cfb913e5ce36c25",
    ],
    [
      "actions/upload-artifact@v7.0.1",
      "043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    ],
    [
      "actions/create-github-app-token@v3.2.0",
      "bcd2ba49218906704ab6c1aa796996da409d3eb1",
    ],
    [
      "googleapis/release-please-action@v5.0.0",
      "45996ed1f6d02564a971a2fa1b5860e934307cf7",
    ],
  ]);

  const seen = new Set<string>();
  for (const [, action, sha, version] of pins) {
    const key = `${action}@${version}`;
    assertEquals(expected.get(key), sha);
    seen.add(key);
  }
  assertEquals([...seen].sort(), [...expected.keys()].sort());
});

Deno.test("release workflows use trusted triggers and fixed serialization", async () => {
  const releaseImages = await readRepositoryFile(
    ".github/workflows/release-images.yml",
  );
  const releasePlease = await readRepositoryFile(
    ".github/workflows/release-please.yml",
  );

  assertEquals(releasePlease.includes("workflow_dispatch"), false);
  assertMatch(releasePlease, /push:\n\s+branches:\n\s+- main/);
  assertStringIncludes(releasePlease, "group: release-please-main");
  assertStringIncludes(releaseImages, "group: release-images");
  assertStringIncludes(releaseImages, "queue: max");
  assertStringIncludes(releaseImages, "cancel-in-progress: false");
  assertStringIncludes(releaseImages, "known false positive (#657)");
});

Deno.test("GitHub App token permissions and event requirement are documented", async () => {
  const workflow = await readRepositoryFile(
    ".github/workflows/release-please.yml",
  );
  assertStringIncludes(
    workflow,
    "installed GitHub App needs Contents, Issues, and Pull requests",
  );
  assertStringIncludes(
    workflow,
    "required instead of GITHUB_TOKEN so the",
  );
  assertStringIncludes(workflow, "permission-contents: write");
  assertStringIncludes(workflow, "permission-issues: write");
  assertStringIncludes(workflow, "permission-pull-requests: write");
});

Deno.test("release remains draft through evidence and publishes last", async () => {
  const workflow = await readRepositoryFile(
    ".github/workflows/release-images.yml",
  );
  const attestation = workflow.indexOf(
    "name: Generate web GitHub provenance",
  );
  const immutable = workflow.indexOf("name: Promote immutable image tags");
  const manifest = workflow.indexOf(
    "name: Create and validate release manifest",
  );
  const retained = workflow.indexOf(
    "name: Retain release evidence with the workflow run",
  );
  const evidence = workflow.indexOf(
    "name: Attach verified evidence to the draft release",
  );
  const draftCheck = workflow.indexOf("name: Confirm release is still a draft");
  const notes = workflow.indexOf("name: Prepare detailed release notes");
  const latest = workflow.indexOf("name: Promote latest image tags");
  const release = workflow.indexOf(
    "name: Publish the verified draft release last",
  );

  assert(
    [
      attestation,
      immutable,
      manifest,
      retained,
      evidence,
      notes,
      draftCheck,
      latest,
      release,
    ].every((position) => position >= 0),
  );
  assert(
    attestation < immutable && immutable < manifest && manifest < retained &&
      retained < evidence && evidence < notes && notes < draftCheck &&
      draftCheck < latest &&
      latest < release,
  );
  assertStringIncludes(
    workflow.slice(immutable, manifest),
    "--phase immutable",
  );
  assertStringIncludes(workflow.slice(latest, release), "--phase latest");
  assertStringIncludes(
    workflow.slice(latest, release),
    "if: success() && steps.identity.outputs.promote_latest == 'true'",
  );
  assertEquals(workflow.indexOf("\n      - name:", release + 1), -1);
  const publishJob = workflow.slice(workflow.indexOf("\n  publish:"));
  assertStringIncludes(publishJob, "needs: release");
  assertEquals(publishJob.includes("uses:"), false);
  assertEquals(workflow.trimEnd().endsWith(">/dev/null"), true);
});

Deno.test("latest eligibility uses published stable releases and main ancestry", async () => {
  const workflow = await readRepositoryFile(
    ".github/workflows/release-images.yml",
  );
  assertStringIncludes(
    workflow,
    'git merge-base --is-ancestor "$tag_sha" origin/main',
  );
  assertStringIncludes(workflow, "gh api --paginate");
  assertStringIncludes(workflow, "releases?per_page=100");
  assertStringIncludes(workflow, "validate.ts latest");
  assertStringIncludes(
    workflow,
    ".[] | {tag_name, draft, prerelease, published_at}",
  );
  assertEquals(workflow.includes("git tag --list"), false);
});

Deno.test("draft retries reuse candidates and replace retained evidence", async () => {
  const workflow = await readRepositoryFile(
    ".github/workflows/release-images.yml",
  );
  const script = await readRepositoryFile("scripts/release/promote-images.sh");

  assertStringIncludes(workflow, ".draft == true");
  assertStringIncludes(
    workflow,
    "release_id: ${{ steps.identity.outputs.release_id }}",
  );
  assertStringIncludes(
    workflow,
    "RELEASE_ID: ${{ needs.release.outputs.release_id }}",
  );
  assertStringIncludes(workflow, "candidate-$GITHUB_RUN_ID");
  assertEquals(workflow.includes("candidate-$GITHUB_RUN_ATTEMPT"), false);
  assertStringIncludes(
    workflow,
    'gh release upload "$TAG" evidence/* --clobber',
  );
  assertStringIncludes(workflow, "${{ github.run_attempt }}");
  assertStringIncludes(script, "Immutable tag already has the verified digest");
  assertStringIncludes(script, "Moving tag already has the verified digest");
});

Deno.test("registry token requirements match verification and publication", async () => {
  const workflow = await readRepositoryFile(
    ".github/workflows/release-images.yml",
  );
  assertStringIncludes(workflow, "DOCKERHUB_TOKEN to a read/write token");
  assertStringIncludes(workflow, "verification reads and publication writes");
});

Deno.test("candidate inspection separates runnable and attestation metadata", async () => {
  const workflow = await readRepositoryFile(
    ".github/workflows/release-images.yml",
  );
  assertStringIncludes(workflow, "--format '{{json .Manifest}}'");
  assertStringIncludes(workflow, "--format '{{json .Image}}'");
  assertStringIncludes(workflow, "validate.ts image");
  assertEquals(workflow.includes('keys == ["linux/amd64"]'), false);
});

Deno.test("release-please config supports bootstrap and recorded releases", async () => {
  const config = JSON.parse(
    await readRepositoryFile("release-please-config.json"),
  );
  const manifest = JSON.parse(
    await readRepositoryFile(".release-please-manifest.json"),
  );
  const version = validateVersion(
    (await readRepositoryFile("version.txt")).trim(),
  );

  assertEquals(
    config.$schema,
    "https://raw.githubusercontent.com/googleapis/release-please/v17.6.0/schemas/config.json",
  );
  assertEquals(config["initial-version"], "0.1.0");
  assertEquals(config["release-type"], "simple");
  assertEquals(config.packages["."]["version-file"], "version.txt");
  assertEquals(config.draft, true);
  assertEquals(config["force-tag-creation"], true);
  assertEquals(config["changelog-type"], "default");
  assert(
    manifest !== null && typeof manifest === "object" &&
      !Array.isArray(manifest),
    "release-please manifest must be an object",
  );
  if (Object.keys(manifest).length === 0) {
    assertEquals(
      version,
      config["initial-version"],
      "an empty manifest is only valid while bootstrapping the initial release",
    );
  } else {
    assertEquals(manifest, { ".": version });
  }
});

Deno.test("promotion keeps semver and full-SHA tags and classifies failures", async () => {
  const script = await readRepositoryFile("scripts/release/promote-images.sh");
  assertStringIncludes(script, 'BACKEND_SEMVER="$BACKEND_REPOSITORY:$VERSION"');
  assertStringIncludes(
    script,
    'BACKEND_REVISION="$BACKEND_REPOSITORY:git-$REVISION"',
  );
  assertStringIncludes(
    script,
    'promote_latest_tag "$BACKEND_REPOSITORY:latest"',
  );
  assertStringIncludes(
    script,
    'promote_latest_tag "$WEB_REPOSITORY:latest"',
  );
  assertStringIncludes(script, "validate.ts registry-error");
  assertEquals(/grep[^\n]*not found/i.test(script), false);
});
