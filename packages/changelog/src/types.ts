export interface Queryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: Row[] }>;
}

export const CHANGELOG_CATEGORIES = [
  "added",
  "improved",
  "fixed",
  "security",
  "breaking",
] as const;

export type ChangelogCategory = typeof CHANGELOG_CATEGORIES[number];

export interface ChangelogItemInput {
  readonly category: ChangelogCategory;
  readonly area?: string | null;
  readonly title: string;
  readonly description: string;
  readonly sortOrder: number;
}

export interface ChangelogDraftInput {
  readonly version: string;
  readonly slug: string;
  readonly title: string;
  readonly summary?: string | null;
  readonly gitTag?: string | null;
  readonly commitSha?: string | null;
  readonly releasedAt?: string | Date | null;
  readonly items: readonly ChangelogItemInput[];
}

export interface ChangelogRevision {
  readonly version: string;
  readonly slug: string;
  readonly title: string;
  readonly summary: string | null;
  readonly gitTag: string | null;
  readonly commitSha: string | null;
  readonly releasedAt: string | null;
  readonly items: readonly ChangelogItemInput[];
  readonly contentSha256: string;
}

export interface PublishedChangelogRelease extends ChangelogRevision {
  readonly revision: number;
  readonly publishedAt: string;
}

export interface PublishedChangelogPage {
  readonly entries: readonly PublishedChangelogRelease[];
  readonly nextCursor: string | null;
}

export interface AdminSession {
  /** Better Auth session ID; actor identity is always derived in PostgreSQL. */
  readonly sessionId: string;
}

export interface GovernanceMutationContext extends AdminSession {
  readonly idempotencyKey: string;
  readonly requestId?: string | null;
  readonly traceId?: string | null;
}

export type AuthorizationFailure =
  | { readonly kind: "denied"; readonly replayed: false }
  | { readonly kind: "reauthentication_required"; readonly replayed: false };

export type CreateChangelogDraftResult = AuthorizationFailure | {
  readonly kind: "created" | "conflict";
  readonly replayed: boolean;
  readonly releaseId?: string;
  readonly revision?: number;
  readonly reason?: "version" | "slug" | "version_and_slug";
};

export type ReviseChangelogDraftResult = AuthorizationFailure | {
  readonly kind:
    | "revised"
    | "unchanged"
    | "not_found"
    | "revision_conflict"
    | "identity_locked"
    | "conflict";
  readonly replayed: boolean;
  readonly releaseId?: string;
  readonly revision?: number;
  readonly actualRevision?: number;
  readonly reason?: "version" | "slug" | "version_and_slug";
};

export type PublishChangelogResult = AuthorizationFailure | {
  readonly kind:
    | "published"
    | "superseded"
    | "unchanged"
    | "not_found"
    | "revision_conflict"
    | "not_publishable";
  readonly replayed: boolean;
  readonly releaseId?: string;
  readonly revision?: number;
  readonly supersededRevision?: number | null;
  readonly actualRevision?: number;
  readonly reasons?: readonly string[];
};

export type UnpublishChangelogResult = AuthorizationFailure | {
  readonly kind:
    | "unpublished"
    | "unchanged"
    | "not_found"
    | "revision_conflict";
  readonly replayed: boolean;
  readonly releaseId?: string;
  readonly revision?: number | null;
  readonly actualRevision?: number;
};

export interface AdminChangelogSummary {
  readonly releaseId: string;
  readonly version: string;
  readonly slug: string;
  readonly status: "draft" | "published" | "archived";
  readonly latestRevision: number;
  readonly publishedRevision: number | null;
  readonly hasUnpublishedChanges: boolean;
  readonly updatedAt: string;
}

export interface AdminChangelogRelease {
  readonly releaseId: string;
  readonly status: "draft" | "published" | "archived";
  readonly latestRevision: number;
  readonly publishedRevision: number | null;
  readonly hasUnpublishedChanges: boolean;
  readonly firstPublishedAt: string | null;
  readonly lastPublishedAt: string | null;
  readonly latest: ChangelogRevision;
  readonly published: ChangelogRevision | null;
}

export interface AdminChangelogRevision extends ChangelogRevision {
  readonly revision: number;
  readonly changedBy: string | null;
  readonly changedAt: string;
}

export type AdminReadResult<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "denied" }
  | { readonly kind: "reauthentication_required" };

export const LEGAL_ACCEPTANCE_SCOPES = ["user", "workspace"] as const;
export type LegalAcceptanceScope = typeof LEGAL_ACCEPTANCE_SCOPES[number];

export interface LegalDocumentInput {
  readonly documentType: string;
  readonly version: string;
  readonly effectiveAt: string | Date;
  readonly canonicalUrl: string;
  /** SHA-256 of the exact operator-approved content presented to the user. */
  readonly contentSha256: string;
  readonly requiresAcceptance: boolean;
  readonly acceptanceScope?: LegalAcceptanceScope;
}

export interface LegalDocument extends Omit<LegalDocumentInput, "effectiveAt"> {
  readonly documentId: string;
  readonly revision: number;
  readonly effectiveAt: string;
  readonly acceptanceScope: LegalAcceptanceScope;
  readonly recordSha256: string;
  readonly publishedAt: string | null;
}

export type CreateLegalDocumentResult = AuthorizationFailure | {
  readonly kind: "created" | "conflict";
  readonly replayed: boolean;
  readonly documentId?: string;
  readonly revision?: number;
};

export type ReviseLegalDocumentResult = AuthorizationFailure | {
  readonly kind: "revised" | "unchanged" | "not_found" | "revision_conflict";
  readonly replayed: boolean;
  readonly documentId?: string;
  readonly revision?: number;
  readonly actualRevision?: number;
};

export type PublishLegalDocumentResult = AuthorizationFailure | {
  readonly kind:
    | "published"
    | "superseded"
    | "unchanged"
    | "not_found"
    | "revision_conflict";
  readonly replayed: boolean;
  readonly documentId?: string;
  readonly revision?: number;
  readonly supersededDocumentId?: string | null;
  readonly actualRevision?: number;
};

export type UnpublishLegalDocumentResult = AuthorizationFailure | {
  readonly kind: "unpublished" | "unchanged" | "revision_conflict";
  readonly replayed: boolean;
  readonly documentId?: string;
  readonly actualDocumentId?: string;
};

export interface LegalAcceptanceContext {
  /** A current Better Auth session; freshness is not required for acceptance. */
  readonly sessionId: string;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
  readonly traceId?: string | null;
}

interface LegalAcceptanceTarget {
  readonly documentType: string;
  readonly version: string;
  readonly revision: number;
  readonly contentSha256: string;
}

export type AcceptLegalDocumentInput =
  & LegalAcceptanceTarget
  & (
    | {
      /** Acceptance applies only to the current session user. */
      readonly acceptanceScope: "user";
      readonly workspaceId?: never;
    }
    | {
      /** Acceptance applies to the whole organization and requires owner/admin. */
      readonly acceptanceScope: "workspace";
      readonly workspaceId: string;
    }
  );

export type AcceptLegalDocumentResult =
  | {
    readonly kind: "accepted" | "not_required" | "not_current";
    readonly replayed: boolean;
    readonly acceptanceId?: string;
    readonly acceptedAt?: string;
  }
  | { readonly kind: "unauthenticated"; readonly replayed: false }
  | { readonly kind: "denied"; readonly replayed: false };
