const FALLBACK_RETURN_PATH = "/dashboard";
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

export function safeReturnPath(
  candidate: string | null | undefined,
  fallback = FALLBACK_RETURN_PATH,
): string {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//")) {
    return fallback;
  }
  if (candidate.includes("\\") || CONTROL_CHARACTERS.test(candidate)) {
    return fallback;
  }

  try {
    const base = new URL("https://relay.invalid");
    const resolved = new URL(candidate, base);
    if (resolved.origin !== base.origin || resolved.username || resolved.password) {
      return fallback;
    }

    const path = `${resolved.pathname}${resolved.search}${resolved.hash}`;
    return resolved.pathname === "/sign-in" ? fallback : path;
  } catch {
    return fallback;
  }
}

export function signInPathFor(
  returnPath: string,
  reason: "auth-required" | "session-expired" = "auth-required",
): string {
  const query = new URLSearchParams({
    returnTo: safeReturnPath(returnPath),
    reason,
  });
  return `/sign-in?${query.toString()}`;
}
