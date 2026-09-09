import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { previousReleaseTags, renderReleaseNotes } from "./notes.ts";
import { createReleaseManifest } from "./validation.ts";

const manifest = createReleaseManifest({
  version: "0.5.0",
  tag: "v0.5.0",
  revision: "a".repeat(40),
  backendRepository: "example/relay-backend",
  backendDigest: `sha256:${"b".repeat(64)}`,
  backendCandidate: "example/relay-backend:candidate-123",
  webRepository: "example/relay-web",
  webDigest: `sha256:${"c".repeat(64)}`,
  webCandidate: "example/relay-web:candidate-123",
  promoteLatest: true,
});
const release = {
  tag_name: "v0.5.0",
  draft: true,
  prerelease: false,
  body:
    "## 0.5.0\n\n### Bug Fixes\n\n* Accept ordinary MCP arguments ([#62](https://github.com/example/relay/pull/62)).",
};
const input = {
  manifest,
  repository: "example/relay",
  release,
  highlights: [
    "### MCP clients\n\nRefresh the connection to discover the catalog tools.",
  ],
};

Deno.test("release notes preserve the changelog and identify the paired immutable images", () => {
  const notes = renderReleaseNotes(input);
  assertStringIncludes(notes, release.body);
  assertStringIncludes(notes, input.highlights[0]);
  assertStringIncludes(notes, "docker pull example/relay-backend:0.5.0");
  assertStringIncludes(notes, "docker pull example/relay-web:0.5.0");
  assertStringIncludes(notes, manifest.images.backend.reference);
  assertStringIncludes(notes, manifest.images.web.reference);
  assertStringIncludes(notes, `/commit/${manifest.revision}`);
  assertStringIncludes(
    notes,
    "/releases/download/v0.5.0/release-manifest.json",
  );
  assertStringIncludes(
    notes,
    "/releases/download/v0.5.0/relay-web-0.5.0.trivy.json",
  );
  assertStringIncludes(
    notes,
    "Image publication does not deploy or migrate a running server.",
  );
  assertEquals(notes.includes("candidate-123"), false);
});

Deno.test("regenerating draft notes replaces generated sections without duplicating prose", () => {
  const first = renderReleaseNotes(input);
  const second = renderReleaseNotes({
    ...input,
    release: { ...release, body: first },
  });
  assertEquals(second, first);
  const updated = renderReleaseNotes({
    ...input,
    release: {
      ...release,
      body: first + "\nOperator note: review the configured callback URLs.\n",
    },
    highlights: ["### MCP clients\n\nUpdated guidance."],
  });
  assertEquals(updated.includes(input.highlights[0]), false);
  assertStringIncludes(updated, "Updated guidance.");
  assertStringIncludes(
    updated,
    "Operator note: review the configured callback URLs.",
  );
  assertEquals(updated.match(/## Release details/g)?.length, 1);
});

Deno.test("older releases do not promise to move latest", () => {
  const older = {
    ...manifest,
    images: {
      backend: { ...manifest.images.backend, plannedLatestTag: null },
      web: { ...manifest.images.web, plannedLatestTag: null },
    },
  };
  const notes = renderReleaseNotes({
    ...input,
    manifest: older,
    highlights: [],
  });
  assertStringIncludes(notes, "preserves the current `latest` tags");
  assertEquals(notes.includes("## Highlights"), false);
  assertStringIncludes(notes, release.body);
});

Deno.test("release notes refuse published releases, mismatched tags, or absent changelogs", () => {
  for (
    const change of [{ draft: false }, { prerelease: true }, {
      tag_name: "v0.4.0",
    }, { body: "" }]
  ) {
    assertThrows(() =>
      renderReleaseNotes({ ...input, release: { ...release, ...change } })
    );
  }
  assertThrows(() =>
    renderReleaseNotes({
      ...input,
      manifest: { ...manifest, revision: "wrong" },
    })
  );
});

Deno.test("highlight baselines exclude failed drafts, prereleases, and newer releases", () => {
  const published = (tag_name: string) => ({
    tag_name,
    draft: false,
    prerelease: false,
    published_at: "2026-09-09T12:00:00Z",
  });
  assertEquals(
    previousReleaseTags("0.12.0", [
      published("v0.2.0"),
      { ...published("v0.11.0"), draft: true },
      { ...published("v0.11.1"), prerelease: true },
      { ...published("v0.11.2"), published_at: null },
      published("v0.10.0"),
      published("v0.12.0"),
      published("v0.13.0"),
      published("release/old-format"),
    ]),
    ["v0.10.0", "v0.2.0"],
  );
  assertEquals(previousReleaseTags("0.1.0", []), []);
  assertThrows(() => previousReleaseTags("0.1.0", {}));
});
