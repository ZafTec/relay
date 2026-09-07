export interface SmtpConfig {
  hostname: string;
  port: number;
  security: "tls" | "starttls" | "plain";
  username?: string;
  password?: string;
  from: string;
  appOrigin: string;
}

function isPrivateRelayHost(hostname: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(hostname)) return true;
  if (hostname.toLowerCase().endsWith(".internal")) return true;
  const parts = hostname.split(".");
  if (
    parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part))
  ) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return false;
  return octets[0] === 127 || octets[0] === 10 ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
}

export function loadSmtpConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
): SmtpConfig | null {
  if (!env.SMTP_HOST) return null;
  const hostname = env.SMTP_HOST;
  const security = env.SMTP_SECURITY ?? "starttls";
  const port = Number(env.SMTP_PORT ?? (security === "tls" ? 465 : 587));
  const from = env.SMTP_FROM ?? "";
  const username = env.SMTP_USER || undefined;
  const password = env.SMTP_PASS || undefined;
  if (
    !/^[a-zA-Z0-9.-]{1,253}$/.test(hostname) ||
    !["tls", "starttls", "plain"].includes(security) ||
    !Number.isSafeInteger(port) || port < 1 || port > 65535 ||
    !from.includes("@") || /[\r\n]/.test(from) || from.length > 320 ||
    !!username !== !!password
  ) throw new TypeError("Invalid SMTP configuration");
  if (
    security === "plain" && !isPrivateRelayHost(hostname)
  ) throw new TypeError("Plain SMTP requires a private relay host");
  const origin = new URL(
    env.NOTIFICATIONS_APP_URL ?? env.BETTER_AUTH_URL ?? "http://localhost:8000",
  );
  if (
    !["https:", "http:"].includes(origin.protocol) || origin.username ||
    origin.password || origin.search || origin.hash || origin.pathname !== "/"
  ) throw new TypeError("Invalid notification application origin");
  return {
    hostname,
    port,
    security: security as SmtpConfig["security"],
    from,
    username,
    password,
    appOrigin: origin.origin,
  };
}
