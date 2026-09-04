import { assertEquals, assertThrows } from "@std/assert";
import {
  createReleaseManifest,
  isLatestPromotionEligible,
  isMissingRegistryReferenceError,
  serializeReleaseManifest,
  validateDigest,
  validateImageInspection,
  validateReleaseManifest,
  versionFromTag,
} from "./validation.ts";

const revision = "a".repeat(40);
const backendDigest = `sha256:${"b".repeat(64)}`;
const webDigest = `sha256:${"c".repeat(64)}`;
const runnableDigest = `sha256:${"d".repeat(64)}`;
const attestationDigest = `sha256:${"e".repeat(64)}`;
const created = "2026-08-26T12:34:56+00:00";

function imageInspectionFixture() {
  return {
    manifest: {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      digest: backendDigest,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: runnableDigest,
          size: 1234,
          platform: { architecture: "amd64", os: "linux" },
        },
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: attestationDigest,
          size: 567,
          annotations: {
            "vnd.docker.reference.digest": runnableDigest,
            "vnd.docker.reference.type": "attestation-manifest",
          },
          platform: { architecture: "unknown", os: "unknown" },
        },
      ],
    },
    image: {
      created,
      architecture: "amd64",
      os: "linux",
      config: {
        Labels: {
          "org.opencontainers.image.version": "0.1.0",
          "org.opencontainers.image.revision": revision,
          "org.opencontainers.image.created": created,
        },
      },
    },
  };
}

function fixture() {
  return createReleaseManifest({
    version: "0.1.0",
    tag: "v0.1.0",
    revision,
    backendRepository: "zaftec/relay-backend",
    backendDigest,
    backendCandidate: "zaftec/relay-backend:candidate-12345",
    webRepository: "zaftec/relay-web",
    webDigest,
    webCandidate: "zaftec/relay-web:candidate-12345",
    promoteLatest: true,
  });
}

Deno.test("release tags accept only canonical stable SemVer", () => {
  assertEquals(versionFromTag("v0.1.0"), "0.1.0");
  assertEquals(versionFromTag("v12.34.56"), "12.34.56");
  for (
    const invalid of [
      "0.1.0",
      "v01.1.0",
      "v1.2",
      "v1.2.3-rc.1",
      "v1.2.3+build",
      "version-1.2.3",
    ]
  ) {
    assertThrows(() => versionFromTag(invalid));
  }
});

Deno.test("latest eligibility uses only published stable releases", () => {
  const releases = [
    {
      tag_name: "v1.2.2",
      draft: false,
      prerelease: false,
      published_at: "2026-08-20T12:00:00Z",
    },
    {
      tag_name: "v99.0.0",
      draft: true,
      prerelease: false,
      published_at: null,
    },
    {
      tag_name: "v88.0.0-rc.1",
      draft: false,
      prerelease: true,
      published_at: "2026-08-21T12:00:00Z",
    },
    {
      tag_name: "nightly",
      draft: false,
      prerelease: false,
      published_at: "2026-08-22T12:00:00Z",
    },
  ];

  assertEquals(isLatestPromotionEligible("1.2.3", releases), true);
  assertEquals(isLatestPromotionEligible("1.2.1", releases), false);
  assertEquals(isLatestPromotionEligible("1.2.2", releases), false);
  assertEquals(isLatestPromotionEligible("0.1.0", []), true);
});

Deno.test("latest eligibility fails closed on malformed release state", () => {
  assertThrows(
    () =>
      isLatestPromotionEligible("1.2.3", [{
        tag_name: "v1.2.2",
        draft: "false",
        prerelease: false,
        published_at: "2026-08-20T12:00:00Z",
      }]),
    Error,
    ".draft must be a boolean",
  );
});

Deno.test("OCI digests must be full lowercase non-placeholder sha256 values", () => {
  assertEquals(validateDigest(backendDigest), backendDigest);
  for (
    const invalid of [
      `sha256:${"0".repeat(64)}`,
      `sha256:${"B".repeat(64)}`,
      `sha512:${"b".repeat(64)}`,
      `sha256:${"b".repeat(63)}`,
    ]
  ) {
    assertThrows(() => validateDigest(invalid));
  }
});

Deno.test("attested image validation accepts one linux/amd64 runnable descriptor", () => {
  const inspection = imageInspectionFixture();
  validateImageInspection(inspection.manifest, inspection.image, {
    digest: backendDigest,
    version: "0.1.0",
    revision,
    created,
  });
});

Deno.test("attested image validation rejects extra runnable platforms", () => {
  const inspection = imageInspectionFixture();
  inspection.manifest.manifests.push({
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    digest: webDigest,
    size: 999,
    platform: { architecture: "arm64", os: "linux" },
  });
  assertThrows(
    () =>
      validateImageInspection(inspection.manifest, inspection.image, {
        digest: backendDigest,
        version: "0.1.0",
        revision,
        created,
      }),
    Error,
    "runnable platform must be linux/amd64",
  );
});

Deno.test("attested image validation reads direct Image labels", () => {
  const inspection = imageInspectionFixture();
  assertThrows(
    () =>
      validateImageInspection(
        inspection.manifest,
        { "linux/amd64": inspection.image },
        {
          digest: backendDigest,
          version: "0.1.0",
          revision,
          created,
        },
      ),
    Error,
    "image config.os",
  );
});

Deno.test("registry misses are exact and authorization failures fail closed", () => {
  const reference = "zaftec/relay-backend:candidate-12345";
  assertEquals(
    isMissingRegistryReferenceError(
      `ERROR: docker.io/${reference}: not found\n`,
      reference,
    ),
    true,
  );
  assertEquals(
    isMissingRegistryReferenceError(
      `ERROR: docker.io/${reference}: manifest unknown: manifest unknown\n`,
      reference,
    ),
    true,
  );

  for (
    const fatal of [
      `ERROR: pull access denied for ${reference}, repository does not exist or may require authorization`,
      `ERROR: docker.io/${reference}: unauthorized: authentication required`,
      `ERROR: request for ${reference} failed: connection reset by peer`,
      `ERROR: registry transport returned 404 Not Found`,
    ]
  ) {
    assertEquals(isMissingRegistryReferenceError(fatal, reference), false);
  }
});

Deno.test("release manifest generation is deterministic and digest pinned", () => {
  const first = serializeReleaseManifest(fixture());
  const second = serializeReleaseManifest(fixture());
  assertEquals(first, second);
  assertEquals(first.endsWith("\n"), true);

  const manifest = JSON.parse(first);
  assertEquals(
    manifest.images.backend.reference,
    `zaftec/relay-backend@${backendDigest}`,
  );
  assertEquals(
    manifest.images.web.tags.revision,
    `zaftec/relay-web:git-${revision}`,
  );
  assertEquals(
    manifest.images.backend.plannedLatestTag,
    "zaftec/relay-backend:latest",
  );
  assertEquals("latest" in manifest.images.backend.tags, false);
  assertEquals(validateReleaseManifest(manifest), manifest);
});

Deno.test("validation restores canonical manifest key order", () => {
  const manifest = fixture();
  const reordered = {
    product: manifest.product,
    schemaVersion: manifest.schemaVersion,
    images: manifest.images,
    platform: manifest.platform,
    revision: manifest.revision,
    tag: manifest.tag,
    version: manifest.version,
  };
  const noncanonical = `${JSON.stringify(reordered, null, 2)}\n`;
  assertEquals(
    serializeReleaseManifest(validateReleaseManifest(reordered)) ===
      noncanonical,
    false,
  );
  assertEquals(
    serializeReleaseManifest(validateReleaseManifest(reordered)),
    serializeReleaseManifest(manifest),
  );
});

Deno.test("release manifest rejects mismatches and undeclared fields", () => {
  const wrongTag = structuredClone(fixture()) as unknown as Record<
    string,
    unknown
  >;
  wrongTag.tag = "v0.2.0";
  assertThrows(
    () => validateReleaseManifest(wrongTag),
    Error,
    "does not match",
  );

  const wrongDigest = structuredClone(fixture());
  (wrongDigest.images.backend as { digest: string }).digest = webDigest;
  assertThrows(
    () => validateReleaseManifest(wrongDigest),
    Error,
    "reference must pin",
  );

  const claimedLatest = structuredClone(fixture());
  (claimedLatest.images.backend.tags as Record<string, string>).latest =
    "zaftec/relay-backend:latest";
  assertThrows(
    () => validateReleaseManifest(claimedLatest),
    Error,
    "must contain exactly",
  );

  const unpairedLatest = structuredClone(fixture());
  (unpairedLatest.images.web as { plannedLatestTag: string | null })
    .plannedLatestTag = null;
  assertThrows(
    () => validateReleaseManifest(unpairedLatest),
    Error,
    "plan latest promotion as a pair",
  );

  const extra = structuredClone(fixture()) as unknown as Record<
    string,
    unknown
  >;
  extra.unreviewed = true;
  assertThrows(
    () => validateReleaseManifest(extra),
    Error,
    "must contain exactly",
  );
});

Deno.test("planned latest promotion is represented for both images or neither", () => {
  const manifest = createReleaseManifest({
    version: "1.2.3",
    tag: "v1.2.3",
    revision,
    backendRepository: "zaftec/relay-backend",
    backendDigest,
    backendCandidate: "zaftec/relay-backend:candidate-7",
    webRepository: "zaftec/relay-web",
    webDigest,
    webCandidate: "zaftec/relay-web:candidate-7",
    promoteLatest: false,
  });
  assertEquals(manifest.images.backend.plannedLatestTag, null);
  assertEquals(manifest.images.web.plannedLatestTag, null);
});
