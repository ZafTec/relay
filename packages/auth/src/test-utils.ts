import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
// Better Auth's test helpers call the ambient adapter context internally.
// Pin them to the instance under test when OpenTelemetry context propagation is
// present in the process.
import { runWithAdapter } from "@better-auth/core/context";
import type { AuthConfig } from "@relay/config";
import type { DatabasePool } from "@relay/database";
import { createAuthOptions } from "./auth.ts";

/**
 * Static test credentials/configuration. This module is intentionally absent
 * from `packages/auth/src/index.ts` and every production entrypoint.
 */
export const TEST_AUTH_CONFIG: AuthConfig = {
  baseUrl: new URL("http://localhost:8000"),
  secret: "test-only-secret-" + "x".repeat(24),
  trustedOrigins: ["http://localhost:8000"],
  google: {
    clientId: "test-google-client-id",
    clientSecret: "test-google-client-secret",
  },
  github: {
    clientId: "test-github-client-id",
    clientSecret: "test-github-client-secret",
  },
};

/** Privileged Better Auth helpers available only to `*_test.ts` imports. */
export function createTestAuth(pool: DatabasePool) {
  const productionOptions = createAuthOptions(pool, TEST_AUTH_CONFIG);
  return betterAuth({
    ...productionOptions,
    plugins: [...productionOptions.plugins, testUtils()],
  });
}

export async function withTestAuthContext<T>(
  auth: ReturnType<typeof createTestAuth>,
  operation: (
    test: Awaited<ReturnType<typeof createTestAuth>["$context"]>["test"],
  ) => T | Promise<T>,
): Promise<T> {
  const context = await auth.$context;
  return await runWithAdapter(context.adapter, () => operation(context.test));
}
