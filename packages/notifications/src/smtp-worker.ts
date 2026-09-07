import { SMTPClient } from "@denomailer";
import type { SmtpConfig } from "./config.ts";
import type { NotificationEmail } from "./smtp.ts";

const scope = self as unknown as {
  onmessage:
    | ((
      event: MessageEvent<{ config: SmtpConfig; email: NotificationEmail }>,
    ) => void)
    | null;
  postMessage(value: unknown): void;
};
scope.onmessage = async ({ data: { config, email } }) => {
  let client: SMTPClient | undefined;
  try {
    client = new SMTPClient({
      connection: {
        hostname: config.hostname,
        port: config.port,
        tls: config.security === "tls",
        ...(config.username
          ? { auth: { username: config.username, password: config.password! } }
          : {}),
      },
      pool: false,
      client: { warning: "error" },
      debug: {
        log: false,
        allowUnsecure: config.security === "plain",
        noStartTLS: config.security === "plain",
      },
    });
    await client.send({
      from: config.from,
      to: email.to,
      subject: email.subject,
      content: email.content,
      headers: { "Message-ID": email.messageId },
    });
    scope.postMessage({ ok: true });
  } catch (error) {
    const reply = error instanceof Error
      ? /^([45]\d\d):/.exec(error.message)?.[1]
      : undefined;
    scope.postMessage({
      ok: false,
      code: reply?.startsWith("5")
        ? "smtp_permanent"
        : reply?.startsWith("4")
        ? "smtp_transient"
        : "smtp_transport",
    });
  } finally {
    try {
      await client?.close();
    } catch { /* Parent terminates the worker and closes all sockets. */ }
  }
};
