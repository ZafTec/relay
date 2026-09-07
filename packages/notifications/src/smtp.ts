import type { SmtpConfig } from "./config.ts";

export interface NotificationEmail {
  to: string;
  subject: string;
  content: string;
  messageId: string;
}
export type DeliveryFailureCode =
  | "smtp_permanent"
  | "smtp_transient"
  | "smtp_transport"
  | "smtp_timeout"
  | "interrupted";
export class DeliveryError extends Error {
  constructor(readonly code: DeliveryFailureCode) {
    super(code);
  }
}

/** One short-lived JS worker makes DNS, TLS, and a stalled SMTP read cancellable. */
export function sendSmtpEmail(
  config: SmtpConfig,
  email: NotificationEmail,
  signal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
    throw new TypeError("Invalid SMTP timeout");
  }
  if (
    [email.to, email.subject, email.messageId].some((value) =>
      /[\r\n\0]/.test(value)
    )
  ) throw new TypeError("Invalid email header");
  if (signal?.aborted) return Promise.reject(new DeliveryError("interrupted"));
  return new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./smtp-worker.ts", import.meta.url).href,
      { type: "module" },
    );
    let complete = false;
    const finish = (code?: DeliveryFailureCode) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      worker.terminate();
      if (code) reject(new DeliveryError(code));
      else resolve();
    };
    const abort = () => finish("interrupted");
    const timer = setTimeout(() => finish("smtp_timeout"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event) =>
      finish(
        event.data?.ok === true
          ? undefined
          : event.data?.code === "smtp_permanent"
          ? "smtp_permanent"
          : event.data?.code === "smtp_transient"
          ? "smtp_transient"
          : "smtp_transport",
      );
    worker.onerror = (event) => {
      event.preventDefault();
      finish("smtp_transport");
    };
    worker.postMessage({ config, email });
  });
}
