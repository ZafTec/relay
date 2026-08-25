import {
  bootstrapSuperadmin,
  type BootstrapSuperadminRequest,
  type BootstrapSuperadminResult,
  type Queryable,
} from "@relay/auth";
import type { DatabaseConfig } from "@relay/config";
import { createDatabasePool } from "@relay/database";

export const BOOTSTRAP_SUPERADMIN_USER_ID_ENV = "RELAY_BOOTSTRAP_USER_ID";
export const BOOTSTRAP_SUPERADMIN_IDEMPOTENCY_KEY_ENV =
  "RELAY_BOOTSTRAP_IDEMPOTENCY_KEY";
export const BOOTSTRAP_SUPERADMIN_USAGE =
  `Usage: relay admin bootstrap-superadmin (requires ${BOOTSTRAP_SUPERADMIN_USER_ID_ENV} and ${BOOTSTRAP_SUPERADMIN_IDEMPOTENCY_KEY_ENV})`;

export interface BootstrapSuperadminCommandOptions {
  readonly userId: string;
  readonly idempotencyKey: string;
}

export type BootstrapSuperadminCommandFailure =
  | "database_role"
  | "already_completed"
  | "target_not_found";

export class BootstrapSuperadminCommandError extends Error {
  override readonly name = "BootstrapSuperadminCommandError";

  constructor(readonly reason: BootstrapSuperadminCommandFailure) {
    super(`Superadmin bootstrap failed: ${reason}`);
  }
}

export function bootstrapSuperadminFailureMessage(
  reason: BootstrapSuperadminCommandFailure,
): string {
  switch (reason) {
    case "database_role":
      return "Superadmin bootstrap requires relay_migrator database credentials";
    case "target_not_found":
      return "Superadmin bootstrap target user does not exist";
    case "already_completed":
      return "Initial superadmin bootstrap has already been completed with different input";
  }
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;

interface BootstrapClient extends Queryable {
  release(error?: Error | boolean): void;
}

interface BootstrapPool {
  connect(): Promise<BootstrapClient>;
  end(): Promise<void>;
}

export interface BootstrapSuperadminCommandDependencies {
  readonly createPool?: (config: DatabaseConfig) => BootstrapPool;
  readonly bootstrap?: (
    queryable: Queryable,
    request: BootstrapSuperadminRequest,
  ) => Promise<BootstrapSuperadminResult>;
}

function validateOptions(
  options: BootstrapSuperadminCommandOptions,
): BootstrapSuperadminCommandOptions {
  if (options.userId.trim() === "" || options.userId.length > 256) {
    throw new TypeError(
      `${BOOTSTRAP_SUPERADMIN_USER_ID_ENV} must contain an immutable user ID of 1-256 characters`,
    );
  }
  if (!IDEMPOTENCY_KEY_PATTERN.test(options.idempotencyKey)) {
    throw new TypeError(
      `${BOOTSTRAP_SUPERADMIN_IDEMPOTENCY_KEY_ENV} must contain 16-128 URL-safe characters`,
    );
  }
  return options;
}

export function loadBootstrapSuperadminOptions(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): BootstrapSuperadminCommandOptions {
  const userId = env[BOOTSTRAP_SUPERADMIN_USER_ID_ENV];
  const idempotencyKey = env[BOOTSTRAP_SUPERADMIN_IDEMPOTENCY_KEY_ENV];
  if (userId === undefined || idempotencyKey === undefined) {
    throw new TypeError(BOOTSTRAP_SUPERADMIN_USAGE);
  }
  return validateOptions({ userId, idempotencyKey });
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function mapBootstrapFailure(error: unknown): never {
  const code = databaseErrorCode(error);
  if (code === "42501") {
    throw new BootstrapSuperadminCommandError("already_completed");
  }
  if (code === "23503") {
    throw new BootstrapSuperadminCommandError("target_not_found");
  }
  throw error;
}

export async function runBootstrapSuperadminCommand(
  databaseConfig: DatabaseConfig,
  options: BootstrapSuperadminCommandOptions,
  dependencies: BootstrapSuperadminCommandDependencies = {},
): Promise<BootstrapSuperadminResult> {
  const validatedOptions = validateOptions(options);
  if (databaseConfig.url.username !== "relay_migrator") {
    throw new BootstrapSuperadminCommandError("database_role");
  }

  const createPool = dependencies.createPool ??
    ((config: DatabaseConfig) =>
      createDatabasePool(config, "relay-admin") as BootstrapPool);
  const performBootstrap = dependencies.bootstrap ?? bootstrapSuperadmin;
  const pool = createPool(databaseConfig);

  try {
    const client = await pool.connect();
    try {
      const identity = await client.query<{ session_user: string }>(
        "select session_user::text as session_user",
      );
      if (identity.rows[0]?.session_user !== "relay_migrator") {
        throw new BootstrapSuperadminCommandError("database_role");
      }

      let transactionStarted = false;
      try {
        await client.query("begin");
        transactionStarted = true;
        try {
          await client.query("set local role relay_owner");
        } catch (error) {
          if (databaseErrorCode(error) === "42501") {
            throw new BootstrapSuperadminCommandError("database_role");
          }
          throw error;
        }
        let result: BootstrapSuperadminResult;
        try {
          result = await performBootstrap(client, {
            targetUserId: validatedOptions.userId,
            idempotencyKey: validatedOptions.idempotencyKey,
          });
        } catch (error) {
          mapBootstrapFailure(error);
        }
        await client.query("commit");
        transactionStarted = false;
        return result;
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query("rollback");
          } catch {
            // Preserve the original failure; closing the pool ends the session.
          }
        }
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
