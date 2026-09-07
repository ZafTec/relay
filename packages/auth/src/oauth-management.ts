import type {
  Auth as BetterAuth,
  BetterAuthOptions,
  Session,
  User,
} from "better-auth";
import { APIError, dispatchAuthEndpoint } from "better-auth/api";
import { runWithAdapter } from "@better-auth/core/context";
import type { DatabasePool } from "@relay/database";

export type McpOAuthClientOperation =
  | "list"
  | "get"
  | "create"
  | "update"
  | "rotate"
  | "delete";
export type ManageMcpOAuthClient = (
  sessionId: string,
  actorUserId: string,
  operation: McpOAuthClientOperation,
  input: Record<string, unknown>,
) => Promise<unknown>;

const PATHS: Record<McpOAuthClientOperation, string> = {
  list: "/oauth2/get-clients",
  get: "/oauth2/get-client",
  create: "/oauth2/create-client",
  update: "/oauth2/update-client",
  rotate: "/oauth2/client/rotate-secret",
  delete: "/oauth2/delete-client",
};
const PUBLIC_FIELDS = new Set([
  "client_id",
  "client_name",
  "client_uri",
  "redirect_uris",
  "scope",
  "token_endpoint_auth_method",
  "grant_types",
  "response_types",
  "client_id_issued_at",
  "client_secret_expires_at",
  "disabled",
]);

// Native client writes use their own adapter transaction. Reserve at most one
// separate authorization-lock connection per pool, avoiding circular pool waits.
const writeTails = new WeakMap<DatabasePool, Promise<void>>();
async function acquireWrite(pool: DatabasePool): Promise<() => void> {
  if ((pool.options.max ?? 10) < 2) {
    throw new APIError("SERVICE_UNAVAILABLE", {
      message:
        "OAuth client administration requires a database pool with at least two connections.",
    });
  }
  const previous = writeTails.get(pool) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  writeTails.set(pool, tail);
  await previous;
  return () => {
    release();
    if (writeTails.get(pool) === tail) writeTails.delete(pool);
  };
}

function publicResult(value: unknown, secretAllowed: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((client) => publicResult(client, false));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).filter(([field]) =>
      PUBLIC_FIELDS.has(field) || (secretAllowed && field === "client_secret")
    ),
  );
}

/**
 * The signed MCP session claim is the only session selector. A locked current
 * database session is passed to Better Auth's supported dispatch pipeline;
 * no cookie is minted, forwarded or accepted from tool arguments.
 */
export function createMcpOAuthClientManager<Options extends BetterAuthOptions>(
  pool: DatabasePool,
  auth: BetterAuth<Options>,
): ManageMcpOAuthClient {
  return async (sessionId, actorUserId, operation, input) => {
    const path = PATHS[operation];
    if (!path || !sessionId || !actorUserId) throw new APIError("BAD_REQUEST");
    if (operation === "update" && "token_endpoint_auth_method" in input) {
      throw new APIError("BAD_REQUEST", {
        message: "Create a new client to change its authentication method.",
      });
    }
    const { client_id, ...update } = input;
    const body = operation === "update" ? { client_id, update } : input;
    const write = operation !== "list" && operation !== "get";
    const releaseWrite = write ? await acquireWrite(pool) : undefined;
    let lock: Awaited<ReturnType<typeof pool.connect>> | undefined;
    try {
      if (write) {
        lock = await pool.connect();
        await lock.query("begin");
      }
      const current = await (lock ?? pool).query<{ createdAt: Date }>(
        `select s."createdAt" from auth.session s
         join auth."user" u on u.id=s."userId" and u."emailVerified" is true
         join relay.system_role_assignments r on r.user_id=u.id and r.revoked_at is null
         where s.id=$1 and s."userId"=$2 and s."expiresAt">now()
         ${write ? "for share of s,u" : ""}`,
        [sessionId, actorUserId],
      );
      if (!current.rows[0]) {
        throw new APIError("FORBIDDEN", {
          code: "AUTHORIZATION_DENIED",
          message: "Current superadmin access is required.",
        });
      }
      const age = Date.now() - current.rows[0].createdAt.getTime();
      if (write && (!Number.isFinite(age) || age < 0 || age > 15 * 60_000)) {
        throw new APIError("FORBIDDEN", {
          code: "SESSION_TOO_OLD",
          message: "Sign in again before changing an OAuth client.",
        });
      }
      if (lock) {
        // The existing SECURITY DEFINER boundary locks the current role;
        // relay_app deliberately has no UPDATE privilege on the role table.
        await lock.query("select relay.require_fresh_superadmin_session($1)", [
          sessionId,
        ]);
      }
      const context = await auth.$context;
      const session = await context.adapter.findOne<Session>({
        model: "session",
        where: [{ field: "id", value: sessionId }],
      });
      const user = await context.adapter.findOne<User>({
        model: "user",
        where: [{ field: "id", value: actorUserId }],
      });
      if (!session || !user || session.userId !== user.id) {
        throw new APIError("FORBIDDEN");
      }
      const endpoint = context.options.plugins?.flatMap((plugin) =>
        Object.values(plugin.endpoints ?? {})
      ).find((endpoint) => endpoint.path === path);
      if (!endpoint) {
        throw new Error("Native OAuth management endpoint is unavailable");
      }
      const result = await runWithAdapter(
        context.adapter,
        () =>
          dispatchAuthEndpoint(endpoint, {
            // Dispatch accepts the base option type; the actual context retains
            // this instance's invariant generic adapter and plugin extensions.
            context: {
              ...context,
              session: { session, user },
            } as unknown as Parameters<
              typeof dispatchAuthEndpoint
            >[1]["context"],
            headers: new Headers({ origin: new URL(context.baseURL).origin }),
            ...(write ? { body } : { query: input }),
            asResponse: false,
          }),
      );
      if (lock) await lock.query("commit");
      if (operation === "delete") return { client_id, deleted: true };
      return publicResult(
        result,
        operation === "create" || operation === "rotate",
      );
    } catch (error) {
      if (lock) await lock.query("rollback");
      throw error;
    } finally {
      lock?.release();
      releaseWrite?.();
    }
  };
}
