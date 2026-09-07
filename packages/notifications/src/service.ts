import type { DatabasePool } from "@relay/database";
import { z } from "zod/v4";

export const notificationSettingsSchema: z.ZodObject<
  { completed: z.ZodBoolean; failed: z.ZodBoolean },
  z.core.$strict
> = z.object({
  completed: z.boolean(),
  failed: z.boolean(),
}).strict();

export interface NotificationContext {
  workspaceId: string;
  actorUserId: string;
}
export interface NotificationSettings {
  completed: boolean;
  failed: boolean;
}
export interface NotificationState extends NotificationSettings {
  configured: boolean;
  deliveries: {
    id: string;
    runId: string;
    event: string;
    status: string;
    attempts: number;
    nextAttemptAt: string | null;
    sentAt: string | null;
    failureCode: string | null;
  }[];
}
export type NotificationResult =
  | { kind: "ok"; notifications: NotificationState }
  | { kind: "not_found" }
  | { kind: "not_configured" };
export interface NotificationService {
  get(context: NotificationContext): Promise<NotificationResult>;
  update(
    context: NotificationContext,
    settings: NotificationSettings,
  ): Promise<NotificationResult>;
}
export function createNotificationService(
  pool: DatabasePool,
  configured: boolean,
): NotificationService {
  async function get(
    context: NotificationContext,
  ): Promise<NotificationResult> {
    const result = await pool.query<{ completed: boolean; failed: boolean }>(
      `select coalesce(p.completed,false) as completed,coalesce(p.failed,false) as failed from auth.member m join auth."user" u on u.id=m."userId" and u."emailVerified"=true left join relay.notification_preferences p on p.workspace_id=m."organizationId" and p.user_id=m."userId" where m."organizationId"=$1 and m."userId"=$2`,
      [context.workspaceId, context.actorUserId],
    );
    if (!result.rows[0]) return { kind: "not_found" };
    const deliveries = await pool.query<
      NotificationState["deliveries"][number]
    >(
      `select id::text,run_id as "runId",event,status,attempts,case when status in ('pending','retrying') then available_at else null end as "nextAttemptAt",sent_at as "sentAt",failure_code as "failureCode" from relay.notification_deliveries where workspace_id=$1 and user_id=$2 order by id desc limit 20`,
      [context.workspaceId, context.actorUserId],
    );
    return {
      kind: "ok",
      notifications: {
        ...result.rows[0],
        configured,
        deliveries: deliveries.rows.map((
          row: NotificationState["deliveries"][number],
        ) => ({
          ...row,
          nextAttemptAt: row.nextAttemptAt === null
            ? null
            : new Date(row.nextAttemptAt).toISOString(),
          sentAt: row.sentAt === null
            ? null
            : new Date(row.sentAt).toISOString(),
        })),
      },
    };
  }
  return {
    get,
    async update(context, settings) {
      notificationSettingsSchema.parse(settings);
      if (!configured && (settings.completed || settings.failed)) {
        return {
          kind: "not_configured",
        };
      }
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await client.query(
          `insert into relay.notification_preferences(workspace_id,user_id,completed,failed) select m."organizationId",m."userId",$3,$4 from auth.member m join auth."user" u on u.id=m."userId" and u."emailVerified"=true where m."organizationId"=$1 and m."userId"=$2 on conflict(workspace_id,user_id) do update set completed=excluded.completed,failed=excluded.failed,updated_at=now() returning workspace_id`,
          [
            context.workspaceId,
            context.actorUserId,
            settings.completed,
            settings.failed,
          ],
        );
        if (!result.rows.length) {
          await client.query("rollback");
          return { kind: "not_found" };
        }
        await client.query(
          `update relay.notification_deliveries set status='cancelled',lease_until=null
           where workspace_id=$1 and user_id=$2
           and (status in ('pending','retrying') or (status='sending' and lease_until<now()))
           and ((event='succeeded' and not $3) or (event='failed' and not $4))`,
          [
            context.workspaceId,
            context.actorUserId,
            settings.completed,
            settings.failed,
          ],
        );
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      return await get(context);
    },
  };
}
