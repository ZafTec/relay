import {
  type ArtifactDetail,
  type ArtifactSummary,
  artifactSummarySchema,
  type ArtifactVersionResource,
  type GetArtifactResult,
  getArtifactResultSchema,
  type ListArtifactsRequest,
  listArtifactsRequestSchema,
  type ListArtifactsResult,
  listArtifactsResultSchema,
  PUBLIC_ID_PATTERNS,
  type ShareLinkResource,
} from "@relay/contracts";
import type { DatabasePool } from "@relay/database";
import type { WorkspaceActorContext } from "../context.ts";
import { validateWorkspaceActorContext } from "../context.ts";
import { decodeCursor, encodeCursor, InvalidCursorError } from "../cursor.ts";
import type { ArtifactReadApplicationService } from "../services.ts";
import { filterSignature } from "./filter.ts";
import {
  assertSafeDatabaseNumber,
  hasCurrentMembership,
  iso,
} from "./shared.ts";

interface ArtifactRow {
  readonly id: string;
  readonly name: string;
  readonly media_kind: string;
  readonly current_version_id: string | null;
  readonly source_run_id: string | null;
  readonly created_at: Date | string;
  readonly shared: boolean;
  readonly version_id: string | null;
  readonly version_sequence: number | null;
  readonly version_sha256: string | null;
  readonly version_content_md5: string | null;
  readonly version_size_bytes: string | number | null;
  readonly version_mime_type: string | null;
  readonly version_width: number | null;
  readonly version_height: number | null;
  readonly version_duration_ms: string | number | null;
  readonly version_source: ArtifactVersionResource["source"] | null;
  readonly version_source_run_id: string | null;
  readonly version_parent_id: string | null;
  readonly version_metadata: unknown;
  readonly version_verification_status:
    | ArtifactVersionResource["verificationStatus"]
    | null;
  readonly version_created_at: Date | string | null;
}

interface ArtifactVersionRow {
  readonly id: string;
  readonly sequence: number;
  readonly sha256: string;
  readonly content_md5: string;
  readonly size_bytes: string | number;
  readonly mime_type: string;
  readonly width: number | null;
  readonly height: number | null;
  readonly duration_ms: string | number | null;
  readonly source: ArtifactVersionResource["source"];
  readonly source_run_id: string | null;
  readonly parent_version_id: string | null;
  readonly metadata: unknown;
  readonly verification_status: ArtifactVersionResource["verificationStatus"];
  readonly created_at: Date | string;
}

interface ShareLinkRow {
  readonly id: string;
  readonly artifact_id: string;
  readonly artifact_version_id: string | null;
  readonly follow_current: boolean;
  readonly expires_at: Date | string | null;
  readonly max_resolutions: number | null;
  readonly resolution_count: number;
  readonly require_auth: boolean;
  readonly content_disposition: "attachment" | "inline";
  readonly status: ShareLinkResource["status"];
  readonly created_at: Date | string;
}

function validateArtifactId(artifactId: string): string {
  if (!PUBLIC_ID_PATTERNS.artifact.test(artifactId)) {
    throw new TypeError("artifactId has an invalid format");
  }
  return artifactId;
}

function versionFromRow(row: ArtifactVersionRow): ArtifactVersionResource {
  return {
    id: row.id,
    sequence: row.sequence,
    sha256: row.sha256,
    contentMd5: row.content_md5,
    sizeBytes: assertSafeDatabaseNumber(row.size_bytes, "artifact byte size"),
    mimeType: row.mime_type,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms === null
      ? null
      : assertSafeDatabaseNumber(row.duration_ms, "artifact duration"),
    source: row.source,
    sourceRunId: row.source_run_id,
    parentVersionId: row.parent_version_id,
    metadata: row.metadata as ArtifactVersionResource["metadata"],
    verificationStatus: row.verification_status,
    createdAt: iso(row.created_at),
  };
}

function currentVersionFromRow(
  row: ArtifactRow,
): ArtifactVersionResource | null {
  if (row.current_version_id === null) return null;
  if (
    row.version_id === null || row.version_sequence === null ||
    row.version_sha256 === null || row.version_content_md5 === null ||
    row.version_size_bytes === null || row.version_mime_type === null ||
    row.version_source === null || row.version_verification_status === null ||
    row.version_created_at === null
  ) {
    throw new TypeError(
      "database returned an incomplete current artifact version",
    );
  }
  return versionFromRow({
    id: row.version_id,
    sequence: row.version_sequence,
    sha256: row.version_sha256,
    content_md5: row.version_content_md5,
    size_bytes: row.version_size_bytes,
    mime_type: row.version_mime_type,
    width: row.version_width,
    height: row.version_height,
    duration_ms: row.version_duration_ms,
    source: row.version_source,
    source_run_id: row.version_source_run_id,
    parent_version_id: row.version_parent_id,
    metadata: row.version_metadata,
    verification_status: row.version_verification_status,
    created_at: row.version_created_at,
  });
}

function summaryFromRow(row: ArtifactRow): ArtifactSummary {
  return artifactSummarySchema.parse({
    id: row.id,
    name: row.name,
    mediaKind: row.media_kind,
    sourceRunId: row.source_run_id,
    currentVersion: currentVersionFromRow(row),
    shared: row.shared,
    createdAt: iso(row.created_at),
  });
}

function shareFromRow(row: ShareLinkRow): ShareLinkResource {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    artifactVersionId: row.artifact_version_id,
    followCurrent: row.follow_current,
    expiresAt: row.expires_at === null ? null : iso(row.expires_at),
    maxResolutions: row.max_resolutions,
    resolutionCount: row.resolution_count,
    requireAuth: row.require_auth,
    contentDisposition: row.content_disposition,
    status: row.status,
    createdAt: iso(row.created_at),
  };
}

const ARTIFACT_SELECT = `
  select artifact.id, artifact.name, artifact.media_kind,
         artifact.current_version_id, artifact.source_run_id,
         artifact.created_at,
         exists (
           select 1 from relay.share_links share
            where share.workspace_id = artifact.workspace_id
              and share.artifact_id = artifact.id
              and share.revoked_at is null
              and (share.expires_at is null or share.expires_at > now())
              and (share.max_resolutions is null or
                   share.resolution_count < share.max_resolutions)
         ) as shared,
         version.id as version_id,
         version.sequence as version_sequence,
         version.sha256 as version_sha256,
         version.content_md5 as version_content_md5,
         version.size_bytes as version_size_bytes,
         version.mime_type as version_mime_type,
         version.width as version_width,
         version.height as version_height,
         version.duration_ms as version_duration_ms,
         version.source as version_source,
         version.source_run_id as version_source_run_id,
         version.parent_version_id as version_parent_id,
         version.metadata as version_metadata,
         version.verification_status as version_verification_status,
         version.created_at as version_created_at
    from relay.artifacts artifact
    left join relay.artifact_versions version
      on version.workspace_id = artifact.workspace_id
     and version.id = artifact.current_version_id`;

export class PostgresArtifactReadService
  implements ArtifactReadApplicationService {
  readonly #pool: DatabasePool;

  constructor(pool: DatabasePool) {
    this.#pool = pool;
  }

  async list(
    rawContext: WorkspaceActorContext,
    rawRequest: ListArtifactsRequest,
  ): Promise<ListArtifactsResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const request = listArtifactsRequestSchema.parse(rawRequest);
    if (!await hasCurrentMembership(this.#pool, context)) {
      return { kind: "not_found" };
    }

    const filter = filterSignature([
      ["mediaKind", request.mediaKind ?? null],
      ["sourceRunId", request.sourceRunId ?? null],
      ["shared", request.shared ?? null],
      ["search", request.search ?? null],
    ]);
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (request.cursor !== null) {
      const position = decodeCursor(request.cursor, "artifacts", filter, 2);
      const timestamp = new Date(position[0]);
      if (
        !Number.isFinite(timestamp.getTime()) ||
        timestamp.toISOString() !== position[0] ||
        !PUBLIC_ID_PATTERNS.artifact.test(position[1])
      ) {
        throw new InvalidCursorError("artifact cursor position is invalid");
      }
      [cursorCreatedAt, cursorId] = position;
    }

    const { rows } = await this.#pool.query<ArtifactRow>(
      `${ARTIFACT_SELECT}
       where artifact.workspace_id = $1
         and artifact.deleted_at is null and artifact.purged_at is null
         and exists (
           select 1 from auth.member member
            where member."organizationId" = artifact.workspace_id
              and member."userId" = $2
         )
         and ($3::text is null or artifact.media_kind = $3)
         and ($4::text is null or artifact.source_run_id = $4)
         and ($5::boolean is null or (exists (
           select 1 from relay.share_links filtered_share
            where filtered_share.workspace_id = artifact.workspace_id
              and filtered_share.artifact_id = artifact.id
              and filtered_share.revoked_at is null
              and (filtered_share.expires_at is null or filtered_share.expires_at > now())
              and (filtered_share.max_resolutions is null or
                   filtered_share.resolution_count < filtered_share.max_resolutions)
         )) = $5)
         and ($6::text is null or position(lower($6) in lower(artifact.name)) > 0)
         and ($7::timestamptz is null or
           (artifact.created_at, artifact.id) < ($7, $8))
       order by artifact.created_at desc, artifact.id desc
       limit $9`,
      [
        context.workspaceId,
        context.actorUserId,
        request.mediaKind ?? null,
        request.sourceRunId ?? null,
        request.shared ?? null,
        request.search ?? null,
        cursorCreatedAt,
        cursorId,
        request.limit + 1,
      ],
    );
    const hasMore = rows.length > request.limit;
    const selected = rows.slice(0, request.limit);
    const items = selected.map(summaryFromRow);
    const last = selected.at(-1);
    return listArtifactsResultSchema.parse({
      kind: "ok",
      items,
      nextCursor: hasMore && last !== undefined
        ? encodeCursor("artifacts", filter, [iso(last.created_at), last.id])
        : null,
    });
  }

  async get(
    rawContext: WorkspaceActorContext,
    rawArtifactId: string,
  ): Promise<GetArtifactResult> {
    const context = validateWorkspaceActorContext(rawContext);
    const artifactId = validateArtifactId(rawArtifactId);
    const client = await this.#pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      if (!await hasCurrentMembership(client, context)) {
        await client.query("rollback");
        return { kind: "not_found" };
      }
      const artifactRows = await client.query<ArtifactRow>(
        `${ARTIFACT_SELECT}
         where artifact.workspace_id = $1 and artifact.id = $2
           and artifact.deleted_at is null and artifact.purged_at is null
           and exists (
             select 1 from auth.member member
              where member."organizationId" = artifact.workspace_id
                and member."userId" = $3
           )`,
        [context.workspaceId, artifactId, context.actorUserId],
      );
      const artifact = artifactRows.rows[0];
      if (artifact === undefined) {
        await client.query("rollback");
        return { kind: "not_found" };
      }

      const versions = await client.query<ArtifactVersionRow>(
        `select id, sequence, sha256, content_md5, size_bytes, mime_type,
                width, height, duration_ms, source, source_run_id,
                parent_version_id, metadata, verification_status, created_at
           from relay.artifact_versions
          where workspace_id = $1 and artifact_id = $2 and purged_at is null
          order by sequence desc`,
        [context.workspaceId, artifactId],
      );
      const shares = await client.query<ShareLinkRow>(
        `select id, artifact_id, artifact_version_id, follow_current, expires_at,
                max_resolutions, resolution_count, require_auth,
                content_disposition, created_at,
                case
                  when revoked_at is not null then 'revoked'
                  when expires_at is not null and expires_at <= now() then 'expired'
                  when max_resolutions is not null and
                       resolution_count >= max_resolutions then 'exhausted'
                  else 'active'
                end as status
           from relay.share_links
          where workspace_id = $1 and artifact_id = $2
          order by created_at desc, id desc`,
        [context.workspaceId, artifactId],
      );
      const detail: ArtifactDetail = {
        ...summaryFromRow(artifact),
        versions: versions.rows.map(versionFromRow),
        shares: shares.rows.map(shareFromRow),
      };
      const result = getArtifactResultSchema.parse({
        kind: "found",
        artifact: detail,
      });
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
