import { migration as superadminInvitations } from "./0005_superadmin_invitations.ts";
import { migration as notifications } from "./0006_notifications.ts";
import type { Migration } from "./types.ts";
import { migration as relayBaseline } from "./0001_relay_baseline.ts";
import { migration as allowanceManagement } from "./0002_allowance_management.ts";
import { migration as oauthClientAudit } from "./0003_oauth_client_audit.ts";
import { migration as imageTools } from "./0004_image_generation_and_editing.ts";

/**
 * Fresh-install migration history for the undeployed Relay MVP.
 *
 * This baseline intentionally replaces the implementation-phase migration
 * chain. After the first production deployment, every schema change must be a
 * new append-only migration and this file becomes immutable history.
 */
export const MIGRATIONS: readonly Migration[] = [
  relayBaseline,
  allowanceManagement,
  oauthClientAudit,
  imageTools,
  superadminInvitations,
  notifications,
];
