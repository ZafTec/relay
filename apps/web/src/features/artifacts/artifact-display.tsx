import { ArtifactPreview } from "./ArtifactPreview";
import { StatusBadge } from "../../components/ui/StatusBadge";
import type {
  ArtifactSummary,
  ArtifactVerificationStatus,
  ArtifactVersionResource,
  ShareLinkResource,
} from "../../lib/api/artifacts";

const dateTimeFormatter = new Intl.DateTimeFormat("en", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const numberFormatter = new Intl.NumberFormat("en", {
  maximumFractionDigits: 1,
});

export function formatTimestamp(value: string): string {
  return dateTimeFormatter.format(new Date(value));
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let amount = value / 1_024;
  let unitIndex = 0;
  while (amount >= 1_024 && unitIndex < units.length - 1) {
    amount /= 1_024;
    unitIndex += 1;
  }
  return `${numberFormatter.format(amount)} ${units[unitIndex]}`;
}

export function formatDimensions(version: ArtifactVersionResource): string {
  if (version.width !== null && version.height !== null) {
    return `${version.width} × ${version.height}`;
  }
  if (version.durationMs !== null) {
    return `${numberFormatter.format(version.durationMs / 1_000)} seconds`;
  }
  return "Not provided";
}

export function formatVersionSource(
  source: ArtifactVersionResource["source"],
): string {
  switch (source) {
    case "generated":
      return "Generated";
    case "restore":
      return "Restored";
    case "upload":
      return "Uploaded";
  }
}

const verificationLabels: Record<ArtifactVerificationStatus, string> = {
  pending: "Verification pending",
  head_verified: "Object verified",
  cryptographically_verified: "Checksum verified",
  failed: "Verification failed",
};

export function VerificationBadge(
  { status }: { status: ArtifactVerificationStatus },
) {
  return (
    <StatusBadge
      tone={status === "pending"
        ? "pending"
        : status === "failed"
        ? "warning"
        : "ready"}
    >
      {verificationLabels[status]}
    </StatusBadge>
  );
}

export interface ShareDisplayStatus {
  readonly label:
    | "Active"
    | "Expiring soon"
    | "Expired"
    | "Exhausted"
    | "Revoked";
  readonly tone: "ready" | "pending" | "warning" | "muted";
  readonly inactive: boolean;
}

export function shareDisplayStatus(
  share: ShareLinkResource,
  now = Date.now(),
): ShareDisplayStatus {
  if (share.status === "expired") {
    return { label: "Expired", tone: "muted", inactive: true };
  }
  if (share.status === "exhausted") {
    return { label: "Exhausted", tone: "muted", inactive: true };
  }
  if (share.status === "revoked") {
    return { label: "Revoked", tone: "warning", inactive: true };
  }

  const expiresAt = share.expiresAt === null
    ? null
    : Date.parse(share.expiresAt);
  const expiresWithinOneDay = expiresAt !== null &&
    expiresAt > now &&
    expiresAt - now <= 24 * 60 * 60 * 1_000;
  return expiresWithinOneDay
    ? { label: "Expiring soon", tone: "warning", inactive: false }
    : { label: "Active", tone: "ready", inactive: false };
}

export function ShareStatusBadge({ share }: { share: ShareLinkResource }) {
  const display = shareDisplayStatus(share);
  return <StatusBadge tone={display.tone}>{display.label}</StatusBadge>;
}

interface ArtifactPlateProps {
  readonly artifact: Pick<
    ArtifactSummary,
    "id" | "name" | "mediaKind" | "currentVersion"
  >;
  readonly compact?: boolean;
}

export function ArtifactPlate(
  { artifact, compact = false }: ArtifactPlateProps,
) {
  return <ArtifactPreview artifact={artifact} detail={compact} />;
}
