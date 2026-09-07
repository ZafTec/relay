import type { DatabasePool } from "@relay/database";
import type { SmtpConfig } from "./config.ts";
import {
  DeliveryError,
  type DeliveryFailureCode,
  type NotificationEmail,
  sendSmtpEmail,
} from "./smtp.ts";

export const NOTIFICATION_RETRY_DELAYS_MS = [
  60_000,
  300_000,
  900_000,
  3_600_000,
] as const;
export function deliveryRetry(
  attempt: number,
  code: DeliveryFailureCode,
): number | null {
  return code === "smtp_permanent" || attempt >= 5
    ? null
    : NOTIFICATION_RETRY_DELAYS_MS[Math.max(0, attempt - 1)] ?? null;
}
interface Delivery {
  id: string;
  email: string;
  run_id: string;
  event: "succeeded" | "failed";
  attempts: number;
  message_id: string;
}
export interface NotificationDeliveryOptions {
  send?: (
    config: SmtpConfig,
    email: NotificationEmail,
    signal?: AbortSignal,
  ) => Promise<void>;
  report?: (
    record: { outcome: "success" | "failure"; code?: DeliveryFailureCode },
  ) => void;
}

export interface NotificationDeliveryLoop {
  deliverOnce(): Promise<boolean>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createNotificationDeliveryLoop(
  pool: DatabasePool,
  config: SmtpConfig,
  options: NotificationDeliveryOptions = {},
): NotificationDeliveryLoop {
  const controller = new AbortController();
  let task: Promise<void> | undefined;
  let wake: () => void = () => {};
  async function deliverOnce(): Promise<boolean> {
    if (controller.signal.aborted) return false;
    // Recheck preferences, current membership and email verification at delivery.
    // Opting out or leaving a workspace cancels queued mail.
    await pool.query(
      `update relay.notification_deliveries d set status='cancelled',lease_until=null where (d.status in ('pending','retrying') or (d.status='sending' and d.lease_until<now())) and not exists(select 1 from relay.notification_preferences p join auth.member m on m."organizationId"=p.workspace_id and m."userId"=p.user_id join auth."user" u on u.id=p.user_id and u."emailVerified"=true where p.workspace_id=d.workspace_id and p.user_id=d.user_id and ((d.event='succeeded' and p.completed) or (d.event='failed' and p.failed)))`,
    );
    await pool.query(
      "update relay.notification_deliveries set status='failed',failure_code='retry_exhausted',lease_until=null where status='sending' and lease_until<now() and attempts>=5",
    );
    const claimed = await pool.query<Delivery>(
      `with candidate as (select d.id,u.email from relay.notification_deliveries d join auth."user" u on u.id=d.user_id and u."emailVerified"=true join auth.member m on m."userId"=d.user_id and m."organizationId"=d.workspace_id join relay.notification_preferences p on p.workspace_id=d.workspace_id and p.user_id=d.user_id where ((d.status in ('pending','retrying') and d.available_at<=now()) or (d.status='sending' and d.lease_until<now())) and d.attempts<5 and ((d.event='succeeded' and p.completed) or (d.event='failed' and p.failed)) order by d.id for update of d skip locked limit 1) update relay.notification_deliveries d set status='sending',attempts=attempts+1,lease_until=now()+interval '90 seconds' from candidate c where d.id=c.id returning d.id::text,c.email,d.run_id,d.event,d.attempts,d.message_id::text`,
    );
    const delivery = claimed.rows[0];
    if (!delivery) return false;
    const email: NotificationEmail = {
      to: delivery.email,
      subject: delivery.event === "succeeded"
        ? "Your Relay run completed"
        : "Your Relay run failed",
      content: `Your Relay run ${
        delivery.event === "succeeded" ? "completed" : "failed"
      }.\n\nView the run and its files: ${config.appOrigin}/dashboard/runs/${
        encodeURIComponent(delivery.run_id)
      }\n\nManage email notifications: ${config.appOrigin}/dashboard/settings\n`,
      messageId: `<relay-${delivery.message_id}@${
        new URL(config.appOrigin).hostname
      }>`,
    };
    try {
      await (options.send ?? sendSmtpEmail)(config, email, controller.signal);
      await pool.query(
        "update relay.notification_deliveries set status='sent',sent_at=now(),lease_until=null,failure_code=null where id=$1 and status='sending' and attempts=$2",
        [delivery.id, delivery.attempts],
      );
      report({ outcome: "success" });
    } catch (error) {
      const code = error instanceof DeliveryError
        ? error.code
        : "smtp_transport";
      const delay = deliveryRetry(delivery.attempts, code);
      await pool.query(
        "update relay.notification_deliveries set status=$3,failure_code=$4,available_at=now()+($5::integer * interval '1 millisecond'),lease_until=null where id=$1 and status='sending' and attempts=$2",
        [
          delivery.id,
          delivery.attempts,
          delay === null ? "failed" : "retrying",
          code,
          delay ?? 0,
        ],
      );
      report({ outcome: "failure", code });
    }
    return true;
  }
  function report(
    record: Parameters<NonNullable<NotificationDeliveryOptions["report"]>>[0],
  ) {
    try {
      options.report?.(record);
    } catch { /* Observers cannot change delivery state. */ }
  }
  async function run() {
    while (!controller.signal.aborted) {
      try {
        if (await deliverOnce()) continue;
      } catch {
        report({ outcome: "failure", code: "smtp_transport" });
      }
      if (controller.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 10000);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  }
  return {
    deliverOnce,
    start() {
      return task ??= run();
    },
    async stop() {
      controller.abort();
      wake();
      await task;
    },
  };
}
