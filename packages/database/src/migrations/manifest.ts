import type { Migration } from "./types.ts";
import { migration as relayBaseline } from "./0001_relay_baseline.ts";
import { migration as allowanceManagement } from "./0002_allowance_management.ts";

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
];
