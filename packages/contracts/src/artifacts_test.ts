import { assertEquals, assertThrows } from "@std/assert";
import {
  completeArtifactUploadResultSchema,
  createArtifactUploadResultSchema,
  createShareLinkResultSchema,
  revokeShareLinkResultSchema,
} from "./index.ts";

const ARTIFACT_ID = "art_0123456789abcdef0123456789abcdef";
const ARTIFACT_VERSION_ID = "aver_0123456789abcdef0123456789abcdef";
const UPLOAD_ID = "upl_0123456789abcdef0123456789abcdef";
const SHARE_LINK_ID = "share_0123456789abcdef0123456789abcdef";
const SHARE_TOKEN = "a".repeat(43);

Deno.test("artifact mutation contracts expose replay metadata", () => {
  const upload = {
    kind: "created",
    upload: {
      id: UPLOAD_ID,
      artifactId: ARTIFACT_ID,
      artifactVersionId: ARTIFACT_VERSION_ID,
      sequence: 1,
      status: "pending",
      authorization: {
        method: "PUT",
        url: "https://objects.example.test/upload",
        expiresAt: "2026-08-26T10:05:00.000Z",
        requiredHeaders: {},
      },
    },
    replayed: true,
  } as const;
  assertEquals(createArtifactUploadResultSchema.parse(upload), upload);

  const completion = {
    kind: "completed",
    artifactId: ARTIFACT_ID,
    artifactVersionId: ARTIFACT_VERSION_ID,
    becameCurrent: true,
    replayed: false,
  } as const;
  assertEquals(
    completeArtifactUploadResultSchema.parse(completion),
    completion,
  );
  assertEquals(
    completeArtifactUploadResultSchema.parse({
      kind: "pending",
      replayed: false,
    }),
    { kind: "pending", replayed: false },
  );

  const share = {
    kind: "created",
    shareLinkId: SHARE_LINK_ID,
    token: SHARE_TOKEN,
    publicPath: `/s/${SHARE_TOKEN}`,
    replayed: true,
  } as const;
  assertEquals(createShareLinkResultSchema.parse(share), share);
  assertEquals(
    revokeShareLinkResultSchema.parse({ kind: "revoked", replayed: true }),
    { kind: "revoked", replayed: true },
  );
});

Deno.test("artifact mutation contracts share a stable conflict variant", () => {
  const conflict = { kind: "idempotency_conflict" } as const;
  for (
    const schema of [
      createArtifactUploadResultSchema,
      completeArtifactUploadResultSchema,
      createShareLinkResultSchema,
      revokeShareLinkResultSchema,
    ]
  ) {
    assertEquals(schema.parse(conflict), conflict);
  }
});

Deno.test("artifact mutation contracts require valid replay metadata", () => {
  assertThrows(() =>
    createArtifactUploadResultSchema.parse({
      kind: "created",
      upload: {
        id: UPLOAD_ID,
        artifactId: ARTIFACT_ID,
        artifactVersionId: ARTIFACT_VERSION_ID,
        sequence: 1,
        status: "pending",
        authorization: null,
      },
    })
  );
  assertThrows(() =>
    completeArtifactUploadResultSchema.parse({
      kind: "pending",
      replayed: true,
    })
  );
  assertThrows(() =>
    createShareLinkResultSchema.parse({
      kind: "created",
      shareLinkId: SHARE_LINK_ID,
      token: SHARE_TOKEN,
      publicPath: `/s/${SHARE_TOKEN}`,
    })
  );
  assertThrows(() => revokeShareLinkResultSchema.parse({ kind: "revoked" }));
});
