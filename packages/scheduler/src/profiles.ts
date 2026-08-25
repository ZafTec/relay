export const SCHEDULING_CLASS_KEYS = [
  "standard",
  "paid",
  "enterprise",
  "internal",
] as const;

export type SchedulingClassKey = typeof SCHEDULING_CLASS_KEYS[number];

export interface SchedulingClassProfile {
  readonly classKey: SchedulingClassKey;
  readonly weight: number;
  readonly maxShare: number | null;
  readonly enabled: boolean;
  readonly policyVersion: number;
}

export interface WorkspaceSchedulingProfile {
  readonly workspaceId: string;
  readonly classKey: SchedulingClassKey;
  readonly policyVersion: number;
}

export interface SchedulerProfileQueryable {
  query<Row extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ readonly rows: Row[] }>;
}

export function isSchedulingClassKey(
  value: string,
): value is SchedulingClassKey {
  return (SCHEDULING_CLASS_KEYS as readonly string[]).includes(value);
}

/**
 * Validate the complete server-owned policy set before it is copied to Redis.
 * Customer classes deliberately have no hard share; only `internal` is capped
 * while customer work is backlogged.
 */
export function validateSchedulingClassProfiles(
  profiles: readonly SchedulingClassProfile[],
): void {
  const byClass = new Map(
    profiles.map((profile) => [profile.classKey, profile]),
  );
  if (
    profiles.length !== SCHEDULING_CLASS_KEYS.length ||
    byClass.size !== SCHEDULING_CLASS_KEYS.length
  ) {
    throw new Error(
      "exactly one profile for every scheduling class is required",
    );
  }

  for (const classKey of SCHEDULING_CLASS_KEYS) {
    const profile = byClass.get(classKey);
    if (profile === undefined) {
      throw new Error(`missing scheduling profile ${classKey}`);
    }
    if (
      !Number.isFinite(profile.weight) ||
      profile.weight <= 0 ||
      profile.weight > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        `${classKey}.weight must be positive and within Redis numeric precision`,
      );
    }
    if (
      !Number.isSafeInteger(profile.policyVersion) ||
      profile.policyVersion <= 0
    ) {
      throw new Error(`${classKey}.policyVersion must be a positive integer`);
    }
    if (typeof profile.enabled !== "boolean") {
      throw new Error(`${classKey}.enabled must be a boolean`);
    }
    if (classKey === "internal") {
      if (
        profile.maxShare === null ||
        !Number.isFinite(profile.maxShare) ||
        profile.maxShare <= 0 ||
        profile.maxShare >= 1
      ) {
        throw new Error(
          "internal.maxShare must be greater than 0 and less than 1",
        );
      }
    } else if (profile.maxShare !== null) {
      throw new Error(`${classKey}.maxShare must be null`);
    }
  }
}

interface SchedulingClassRow extends Record<string, unknown> {
  class_key: string;
  weight: string | number;
  max_share: string | number | null;
  enabled: boolean;
  policy_version: number;
}

function fromRow(row: SchedulingClassRow): SchedulingClassProfile {
  if (!isSchedulingClassKey(row.class_key)) {
    throw new Error(`unknown scheduling class ${row.class_key}`);
  }
  return {
    classKey: row.class_key,
    weight: Number(row.weight),
    maxShare: row.max_share === null ? null : Number(row.max_share),
    enabled: row.enabled,
    policyVersion: row.policy_version,
  };
}

/** Load all four policies from the database-owned configuration table. */
export async function loadSchedulingClassProfiles(
  db: SchedulerProfileQueryable,
): Promise<readonly SchedulingClassProfile[]> {
  const { rows } = await db.query<SchedulingClassRow>(
    `select class_key, weight, max_share, enabled, policy_version
       from relay.scheduler_classes
      order by case class_key
        when 'standard' then 1
        when 'paid' then 2
        when 'enterprise' then 3
        when 'internal' then 4
      end`,
  );
  const profiles = rows.map(fromRow);
  validateSchedulingClassProfiles(profiles);
  return profiles;
}

/**
 * Resolve a workspace's active class without accepting any caller-requested
 * class. Missing, expired, or disabled grants fall back to the enabled
 * `standard` profile. Migration 0025 applies the same rule in a database
 * trigger when an execution job is inserted, making the trust boundary hard.
 */
export async function resolveWorkspaceSchedulingProfile(
  db: SchedulerProfileQueryable,
  workspaceId: string,
): Promise<WorkspaceSchedulingProfile> {
  if (workspaceId.length === 0) {
    throw new Error("workspaceId must not be empty");
  }
  const { rows } = await db.query<
    SchedulingClassRow & { workspace_id: string }
  >(
    `with active_grant as (
       select p.class_key
         from relay.workspace_scheduling_profiles p
         join relay.scheduler_classes granted
           on granted.class_key = p.class_key
          and granted.policy_version = p.policy_version
          and granted.enabled = true
        where p.workspace_id = $1
          and (p.expires_at is null or p.expires_at > now())
     )
     select $1::text as workspace_id,
            selected.class_key,
            selected.weight,
            selected.max_share,
            selected.enabled,
            selected.policy_version
       from relay.scheduler_classes selected
      where selected.class_key = coalesce(
        (select class_key from active_grant),
        'standard'
      )
        and selected.enabled = true`,
    [workspaceId],
  );
  if (rows.length !== 1) {
    throw new Error("enabled standard scheduling profile is not configured");
  }
  const profile = fromRow(rows[0]);
  return {
    workspaceId,
    classKey: profile.classKey,
    policyVersion: profile.policyVersion,
  };
}
