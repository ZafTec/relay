export const RELEASE_PLATFORM = "linux/amd64" as const;
export const RELEASE_PRODUCT = "relay" as const;

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_PATTERN =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const EVIDENCE_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ATTESTATION_MANIFEST_TYPE = "attestation-manifest";

export interface ReleaseImageEvidence {
  readonly sbom: string;
  readonly provenance: string;
  readonly vulnerabilityScan: string;
}

export interface ReleaseImageRecord {
  readonly repository: string;
  readonly digest: string;
  readonly reference: string;
  readonly candidate: string;
  readonly tags: {
    readonly semver: string;
    readonly revision: string;
  };
  readonly plannedLatestTag: string | null;
  readonly evidence: ReleaseImageEvidence;
}

export interface ReleaseManifest {
  readonly schemaVersion: 1;
  readonly product: typeof RELEASE_PRODUCT;
  readonly version: string;
  readonly tag: string;
  readonly revision: string;
  readonly platform: typeof RELEASE_PLATFORM;
  readonly images: {
    readonly backend: ReleaseImageRecord;
    readonly web: ReleaseImageRecord;
  };
}

export interface CreateReleaseManifestInput {
  readonly version: string;
  readonly tag: string;
  readonly revision: string;
  readonly backendRepository: string;
  readonly backendDigest: string;
  readonly backendCandidate: string;
  readonly webRepository: string;
  readonly webDigest: string;
  readonly webCandidate: string;
  readonly promoteLatest: boolean;
}

export interface ReleaseImageInspectionIdentity {
  readonly digest: string;
  readonly version: string;
  readonly revision: string;
  readonly created: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function assertRecord(
  value: unknown,
  path: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${path} must contain exactly: ${wanted.join(", ")}`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") fail(`${path} must be a string`);
}

export function validateVersion(value: string): string {
  if (!SEMVER_PATTERN.test(value)) {
    fail(
      `version must be canonical MAJOR.MINOR.PATCH SemVer; received ${value}`,
    );
  }
  return value;
}

export function versionFromTag(tag: string): string {
  if (!tag.startsWith("v")) {
    fail(`tag must use the vMAJOR.MINOR.PATCH form; received ${tag}`);
  }
  return validateVersion(tag.slice(1));
}

function compareVersions(left: string, right: string): number {
  const leftParts = validateVersion(left).split(".").map(BigInt);
  const rightParts = validateVersion(right).split(".").map(BigInt);
  for (let index = 0; index < leftParts.length; index++) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

export function isLatestPromotionEligible(
  currentVersion: string,
  releasesValue: unknown,
): boolean {
  const current = validateVersion(currentVersion);
  if (!Array.isArray(releasesValue)) {
    fail("GitHub releases response must be an array");
  }

  for (const [index, releaseValue] of releasesValue.entries()) {
    const path = `GitHub releases[${index}]`;
    assertRecord(releaseValue, path);
    assertString(releaseValue.tag_name, `${path}.tag_name`);
    if (typeof releaseValue.draft !== "boolean") {
      fail(`${path}.draft must be a boolean`);
    }
    if (typeof releaseValue.prerelease !== "boolean") {
      fail(`${path}.prerelease must be a boolean`);
    }
    if (
      releaseValue.published_at !== null &&
      typeof releaseValue.published_at !== "string"
    ) {
      fail(`${path}.published_at must be a string or null`);
    }
    if (
      releaseValue.draft || releaseValue.prerelease ||
      releaseValue.published_at === null
    ) {
      continue;
    }
    if (releaseValue.published_at.length === 0) {
      fail(`${path}.published_at must not be empty`);
    }

    let publishedVersion: string;
    try {
      publishedVersion = versionFromTag(releaseValue.tag_name);
    } catch {
      continue;
    }
    if (compareVersions(current, publishedVersion) <= 0) return false;
  }

  return true;
}

export function validateFullSha(value: string): string {
  if (!FULL_SHA_PATTERN.test(value) || /^0+$/.test(value)) {
    fail(`revision must be a non-zero, lowercase, full 40-character Git SHA`);
  }
  return value;
}

export function validateDigest(value: string): string {
  if (!DIGEST_PATTERN.test(value) || /^sha256:0+$/.test(value)) {
    fail(`digest must be a non-zero lowercase sha256 OCI digest`);
  }
  return value;
}

export function validateRepository(value: string): string {
  if (!REPOSITORY_PATTERN.test(value)) {
    fail(
      `repository must be an unqualified lowercase Docker Hub namespace/name; received ${value}`,
    );
  }
  return value;
}

export function isMissingRegistryReferenceError(
  stderr: string,
  reference: string,
): boolean {
  const fatal =
    /\b(?:unauthorized|authentication required|denied|forbidden|insufficient_scope|too many requests|timeout|timed out|connection|tls|certificate|temporary failure|service unavailable)\b|\b(?:429|5\d\d)\b/i;
  if (fatal.test(stderr)) return false;

  const targets = [reference, `docker.io/${reference}`];
  return stderr.split(/\r?\n/).some((line) => {
    const message = line.trim();
    return targets.some((target) =>
      message === `ERROR: ${target}: not found` ||
      (message.includes(target) &&
        /:\s*manifest unknown(?:\s|:|$)/i.test(message))
    );
  });
}

export function validateImageInspection(
  manifestValue: unknown,
  imageValue: unknown,
  expected: ReleaseImageInspectionIdentity,
): void {
  const expectedDigest = validateDigest(expected.digest);
  const expectedVersion = validateVersion(expected.version);
  const expectedRevision = validateFullSha(expected.revision);
  if (expected.created.length === 0) fail("created label must not be empty");

  assertRecord(manifestValue, "image manifest");
  assertString(manifestValue.digest, "image manifest.digest");
  if (validateDigest(manifestValue.digest) !== expectedDigest) {
    fail("image manifest digest does not match the pinned candidate digest");
  }
  if (!Array.isArray(manifestValue.manifests)) {
    fail("image manifest.manifests must be an array");
  }

  const runnableDigests: string[] = [];
  const attestationSubjects: string[] = [];
  for (const [index, descriptorValue] of manifestValue.manifests.entries()) {
    const path = `image manifest.manifests[${index}]`;
    assertRecord(descriptorValue, path);
    assertString(descriptorValue.digest, `${path}.digest`);
    const descriptorDigest = validateDigest(descriptorValue.digest);
    assertRecord(descriptorValue.platform, `${path}.platform`);
    assertString(descriptorValue.platform.os, `${path}.platform.os`);
    assertString(
      descriptorValue.platform.architecture,
      `${path}.platform.architecture`,
    );

    let annotationType: string | undefined;
    let annotationSubject: string | undefined;
    if (descriptorValue.annotations !== undefined) {
      assertRecord(descriptorValue.annotations, `${path}.annotations`);
      const type = descriptorValue.annotations["vnd.docker.reference.type"];
      const subject =
        descriptorValue.annotations["vnd.docker.reference.digest"];
      if (type !== undefined) {
        assertString(type, `${path}.annotations.vnd.docker.reference.type`);
        annotationType = type;
      }
      if (subject !== undefined) {
        assertString(
          subject,
          `${path}.annotations.vnd.docker.reference.digest`,
        );
        annotationSubject = subject;
      }
    }

    if (annotationType === ATTESTATION_MANIFEST_TYPE) {
      if (
        descriptorValue.platform.os !== "unknown" ||
        descriptorValue.platform.architecture !== "unknown"
      ) {
        fail(`${path} attestation platform must be unknown/unknown`);
      }
      if (annotationSubject === undefined) {
        fail(`${path} attestation must identify its runnable subject digest`);
      }
      attestationSubjects.push(validateDigest(annotationSubject));
      continue;
    }

    if (
      descriptorValue.platform.os === "unknown" ||
      descriptorValue.platform.architecture === "unknown"
    ) {
      fail(`${path} unknown/unknown descriptor is not an attestation`);
    }
    runnableDigests.push(descriptorDigest);
    if (
      descriptorValue.platform.os !== "linux" ||
      descriptorValue.platform.architecture !== "amd64"
    ) {
      fail(`${path} runnable platform must be linux/amd64`);
    }
  }

  if (runnableDigests.length !== 1) {
    fail("image manifest must contain exactly one runnable descriptor");
  }
  if (attestationSubjects.length === 0) {
    fail("image manifest must contain an attestation descriptor");
  }
  if (attestationSubjects.some((digest) => digest !== runnableDigests[0])) {
    fail("attestation descriptor does not reference the runnable image");
  }

  // Buildx returns the selected runnable config directly for a single-platform
  // attested index; it is not keyed by "linux/amd64".
  assertRecord(imageValue, "image config");
  assertString(imageValue.os, "image config.os");
  assertString(imageValue.architecture, "image config.architecture");
  if (imageValue.os !== "linux" || imageValue.architecture !== "amd64") {
    fail("direct image config platform must be linux/amd64");
  }
  assertRecord(imageValue.config, "image config.config");
  assertRecord(imageValue.config.Labels, "image config.config.Labels");
  const labels = imageValue.config.Labels;
  const expectedLabels: Readonly<Record<string, string>> = {
    "org.opencontainers.image.version": expectedVersion,
    "org.opencontainers.image.revision": expectedRevision,
    "org.opencontainers.image.created": expected.created,
  };
  for (const [label, expectedValue] of Object.entries(expectedLabels)) {
    if (labels[label] !== expectedValue) {
      fail(`${label} does not match the release identity`);
    }
  }
}

function validateEvidenceFilename(value: unknown, path: string): string {
  assertString(value, path);
  if (!EVIDENCE_FILE_PATTERN.test(value) || value.includes("..")) {
    fail(`${path} must be a safe basename`);
  }
  return value;
}

function imageRecord(
  kind: "backend" | "web",
  version: string,
  revision: string,
  repository: string,
  digest: string,
  candidate: string,
  promoteLatest: boolean,
): ReleaseImageRecord {
  validateRepository(repository);
  validateDigest(digest);
  const candidatePattern = new RegExp(
    `^${
      repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }:candidate-[1-9]\\d*$`,
  );
  if (!candidatePattern.test(candidate)) {
    fail(
      `${kind} candidate must be ${repository}:candidate-<positive-run-id>`,
    );
  }

  const evidencePrefix = `relay-${kind}-${version}`;
  return {
    repository,
    digest,
    reference: `${repository}@${digest}`,
    candidate: `${candidate}@${digest}`,
    tags: {
      semver: `${repository}:${version}`,
      revision: `${repository}:git-${revision}`,
    },
    plannedLatestTag: promoteLatest ? `${repository}:latest` : null,
    evidence: {
      sbom: `${evidencePrefix}.spdx.json`,
      provenance: `${evidencePrefix}.provenance.json`,
      vulnerabilityScan: `${evidencePrefix}.trivy.json`,
    },
  };
}

export function createReleaseManifest(
  input: CreateReleaseManifestInput,
): ReleaseManifest {
  const version = validateVersion(input.version);
  if (versionFromTag(input.tag) !== version) {
    fail(`tag ${input.tag} does not match version ${version}`);
  }
  const revision = validateFullSha(input.revision);
  if (input.backendRepository === input.webRepository) {
    fail("backend and web repositories must be distinct");
  }

  return {
    schemaVersion: 1,
    product: RELEASE_PRODUCT,
    version,
    tag: input.tag,
    revision,
    platform: RELEASE_PLATFORM,
    images: {
      backend: imageRecord(
        "backend",
        version,
        revision,
        input.backendRepository,
        input.backendDigest,
        input.backendCandidate,
        input.promoteLatest,
      ),
      web: imageRecord(
        "web",
        version,
        revision,
        input.webRepository,
        input.webDigest,
        input.webCandidate,
        input.promoteLatest,
      ),
    },
  };
}

function validateImageRecord(
  value: unknown,
  kind: "backend" | "web",
  manifest: Pick<ReleaseManifest, "version" | "revision">,
): ReleaseImageRecord {
  const path = `images.${kind}`;
  assertRecord(value, path);
  assertExactKeys(
    value,
    [
      "repository",
      "digest",
      "reference",
      "candidate",
      "tags",
      "plannedLatestTag",
      "evidence",
    ],
    path,
  );

  assertString(value.repository, `${path}.repository`);
  assertString(value.digest, `${path}.digest`);
  assertString(value.reference, `${path}.reference`);
  assertString(value.candidate, `${path}.candidate`);
  validateRepository(value.repository);
  validateDigest(value.digest);

  if (value.reference !== `${value.repository}@${value.digest}`) {
    fail(`${path}.reference must pin the declared repository and digest`);
  }
  const candidatePattern = new RegExp(
    `^${
      value.repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }:candidate-[1-9]\\d*@${value.digest}$`,
  );
  if (!candidatePattern.test(value.candidate)) {
    fail(`${path}.candidate must pin a run-specific candidate to its digest`);
  }

  assertRecord(value.tags, `${path}.tags`);
  assertExactKeys(value.tags, ["semver", "revision"], `${path}.tags`);
  assertString(value.tags.semver, `${path}.tags.semver`);
  assertString(value.tags.revision, `${path}.tags.revision`);
  if (
    value.plannedLatestTag !== null &&
    typeof value.plannedLatestTag !== "string"
  ) {
    fail(`${path}.plannedLatestTag must be a string or null`);
  }
  if (value.tags.semver !== `${value.repository}:${manifest.version}`) {
    fail(`${path}.tags.semver does not match the release version`);
  }
  if (value.tags.revision !== `${value.repository}:git-${manifest.revision}`) {
    fail(`${path}.tags.revision does not match the full Git revision`);
  }
  if (
    value.plannedLatestTag !== null &&
    value.plannedLatestTag !== `${value.repository}:latest`
  ) {
    fail(`${path}.plannedLatestTag is invalid`);
  }

  assertRecord(value.evidence, `${path}.evidence`);
  assertExactKeys(
    value.evidence,
    ["sbom", "provenance", "vulnerabilityScan"],
    `${path}.evidence`,
  );
  const evidence = {
    sbom: validateEvidenceFilename(
      value.evidence.sbom,
      `${path}.evidence.sbom`,
    ),
    provenance: validateEvidenceFilename(
      value.evidence.provenance,
      `${path}.evidence.provenance`,
    ),
    vulnerabilityScan: validateEvidenceFilename(
      value.evidence.vulnerabilityScan,
      `${path}.evidence.vulnerabilityScan`,
    ),
  };
  const prefix = `relay-${kind}-${manifest.version}`;
  if (
    evidence.sbom !== `${prefix}.spdx.json` ||
    evidence.provenance !== `${prefix}.provenance.json` ||
    evidence.vulnerabilityScan !== `${prefix}.trivy.json`
  ) {
    fail(`${path}.evidence filenames do not match the release`);
  }

  return value as unknown as ReleaseImageRecord;
}

export function validateReleaseManifest(value: unknown): ReleaseManifest {
  assertRecord(value, "manifest");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "product",
      "version",
      "tag",
      "revision",
      "platform",
      "images",
    ],
    "manifest",
  );

  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (value.product !== RELEASE_PRODUCT) {
    fail(`product must be ${RELEASE_PRODUCT}`);
  }
  assertString(value.version, "version");
  assertString(value.tag, "tag");
  assertString(value.revision, "revision");
  const version = validateVersion(value.version);
  if (versionFromTag(value.tag) !== version) {
    fail(`tag ${value.tag} does not match version ${version}`);
  }
  const revision = validateFullSha(value.revision);
  if (value.platform !== RELEASE_PLATFORM) {
    fail(`platform must be ${RELEASE_PLATFORM}`);
  }

  assertRecord(value.images, "images");
  assertExactKeys(value.images, ["backend", "web"], "images");
  const releaseIdentity = { version, revision };
  const backend = validateImageRecord(
    value.images.backend,
    "backend",
    releaseIdentity,
  );
  const web = validateImageRecord(value.images.web, "web", releaseIdentity);
  if (backend.repository === web.repository) {
    fail("backend and web repositories must be distinct");
  }
  if (
    (backend.plannedLatestTag === null) !==
      (web.plannedLatestTag === null)
  ) {
    fail("backend and web must plan latest promotion as a pair");
  }

  return createReleaseManifest({
    version,
    tag: value.tag,
    revision,
    backendRepository: backend.repository,
    backendDigest: backend.digest,
    backendCandidate: backend.candidate.slice(
      0,
      -(`@${backend.digest}`.length),
    ),
    webRepository: web.repository,
    webDigest: web.digest,
    webCandidate: web.candidate.slice(0, -(`@${web.digest}`.length)),
    promoteLatest: backend.plannedLatestTag !== null,
  });
}

export function serializeReleaseManifest(manifest: ReleaseManifest): string {
  const canonical = validateReleaseManifest(manifest);
  return `${JSON.stringify(canonical, null, 2)}\n`;
}
