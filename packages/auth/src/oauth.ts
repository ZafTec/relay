interface ProviderUserInfo {
  readonly user: {
    readonly email?: string | null;
    readonly emailVerified?: boolean;
  };
}

/**
 * Wraps a provider's real user-info resolver and refuses the callback unless
 * that callback's current provider response contains a usable verified email.
 * This deliberately runs before Better Auth consults a persisted user, whose
 * historical `emailVerified` value must not satisfy a later OAuth callback.
 */
export function requireCurrentVerifiedEmail<
  Args extends readonly unknown[],
  Result extends ProviderUserInfo | null,
>(
  getUserInfo: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    const result = await getUserInfo(...args);
    if (
      result === null || result.user.emailVerified !== true ||
      typeof result.user.email !== "string" || result.user.email.trim() === ""
    ) {
      return null as Result;
    }
    return result;
  };
}
