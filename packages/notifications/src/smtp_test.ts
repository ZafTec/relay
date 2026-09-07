import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { loadSmtpConfig, type SmtpConfig } from "./config.ts";
import { DeliveryError, sendSmtpEmail } from "./smtp.ts";
import { deliveryRetry } from "./delivery.ts";

function smtpFixture(reply: "accept" | "450" | "550" | "hang") {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const connections = new Set<Deno.Conn>();
  const handlers: Promise<void>[] = [];
  const messages: string[] = [];
  const encoder = new TextEncoder();
  const task = (async () => {
    try {
      for await (const conn of listener) {
        connections.add(conn);
        handlers.push((async () => {
          const send = (line: string) =>
            conn.write(encoder.encode(line + "\r\n"));
          let buffer = "";
          let inData = false;
          let message = "";
          const decoder = new TextDecoder();
          try {
            if (reply !== "hang") await send("220 localhost ESMTP");
            const bytes = new Uint8Array(8192);
            let length: number | null;
            while ((length = await conn.read(bytes)) !== null) {
              buffer += decoder.decode(bytes.subarray(0, length), {
                stream: true,
              });
              while (buffer.includes("\r\n")) {
                const end = buffer.indexOf("\r\n");
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 2);
                if (inData) {
                  if (line === ".") {
                    messages.push(message);
                    await send("250 accepted");
                    inData = false;
                  } else message += line + "\r\n";
                } else if (/^EHLO|^HELO/.test(line)) {
                  await send("250-localhost\r\n250 PIPELINING");
                } else if (/^MAIL FROM/.test(line)) await send("250 OK");
                else if (/^RCPT TO/.test(line)) {
                  await send(
                    reply === "450" || reply === "550"
                      ? `${reply} private-fixture-error-do-not-log`
                      : "250 OK",
                  );
                } else if (line === "DATA") {
                  inData = true;
                  message = "";
                  await send("354 End with dot");
                } else if (line === "QUIT") {
                  await send("221 Bye");
                  return;
                } else await send("250 OK");
              }
            }
          } catch {
            /* The sender may cancel or time out. */
          } finally {
            connections.delete(conn);
            try {
              conn.close();
            } catch { /* Already closed. */ }
          }
        })());
      }
    } catch { /* Test teardown closes listener. */ }
  })();
  return {
    config: {
      hostname: "127.0.0.1",
      port: (listener.addr as Deno.NetAddr).port,
      security: "plain",
      from: "Relay <relay@example.test>",
      appOrigin: "http://localhost:8000",
    } satisfies SmtpConfig,
    messages,
    async close() {
      listener.close();
      for (const conn of connections) {
        try {
          conn.close();
        } catch { /* Already closed. */ }
      }
      await task;
      await Promise.all(handlers);
    },
  };
}
const email = {
  to: "recipient@example.test",
  subject: "Run complete",
  content: "A private run link.",
  messageId: "<relay-fixture@example.test>",
};

Deno.test("SMTPClient delivers text with a stable Message-ID", async () => {
  const fixture = await smtpFixture("accept");
  try {
    await sendSmtpEmail(fixture.config, email);
    assertEquals(fixture.messages.length, 1);
    assertEquals(
      fixture.messages[0].match(/^message-id:\s*(.*)$/im)?.[1].trim(),
      "<relay-fixture@example.test>",
    );
    assertEquals(fixture.messages[0].includes("A private run link."), true);
  } finally {
    await fixture.close();
  }
});
for (
  const [reply, code] of [["450", "smtp_transient"], [
    "550",
    "smtp_permanent",
  ]] as const
) {
  Deno.test(`SMTPClient classifies ${reply} without exposing the server reply`, async () => {
    const fixture = await smtpFixture(reply);
    try {
      const error = await assertRejects(
        () => sendSmtpEmail(fixture.config, email),
        DeliveryError,
      );
      assertEquals(error.code, code);
      assertEquals(error.message, code);
    } finally {
      await fixture.close();
    }
  });
}
Deno.test("SMTPClient closes stalled connections on timeout and cancellation", async () => {
  const fixture = await smtpFixture("hang");
  try {
    assertEquals(
      (await assertRejects(
        () => sendSmtpEmail(fixture.config, email, undefined, 500),
        DeliveryError,
      ))
        .code,
      "smtp_timeout",
    );
    const abort = new AbortController();
    const pending = sendSmtpEmail(fixture.config, email, abort.signal);
    abort.abort();
    assertEquals(
      (await assertRejects(() => pending, DeliveryError)).code,
      "interrupted",
    );
  } finally {
    await fixture.close();
  }
});
Deno.test("SMTP config is opt-in and retries are bounded", () => {
  assertEquals(loadSmtpConfig({}), null);
  assertEquals(
    [1, 2, 3, 4, 5].map((attempt) => deliveryRetry(attempt, "smtp_transient")),
    [60_000, 300_000, 900_000, 3_600_000, null],
  );
  assertEquals(deliveryRetry(1, "smtp_permanent"), null);
});

Deno.test("plain SMTP accepts private relay addresses and rejects lookalike public names", () => {
  const config = { SMTP_SECURITY: "plain", SMTP_FROM: "relay@example.test" };
  for (
    const host of [
      "smtp-relay",
      "localhost",
      "mail.internal",
      "127.0.0.1",
      "10.0.0.2",
      "172.16.0.2",
      "172.31.255.1",
      "192.168.1.2",
    ]
  ) {
    assertEquals(
      loadSmtpConfig({ ...config, SMTP_HOST: host })?.hostname,
      host,
    );
  }
  for (
    const host of [
      "127.example.com",
      "10.mail.example.com",
      "192.168.evil.com",
      "localhost.example.com",
      "172.15.0.1",
      "172.32.0.1",
      "10.300.1.1",
      "127.1",
      "2130706433",
      "01.2.3.4",
    ]
  ) {
    assertThrows(
      () => loadSmtpConfig({ ...config, SMTP_HOST: host }),
      TypeError,
      "private relay host",
    );
  }
});
