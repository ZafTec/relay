import { assertEquals, assertRejects } from "@std/assert";
import { createMcpOAuthOptions } from "./oauth.ts";
import { APIError } from "better-auth/api";

Deno.test("OAuth client management requires a current superadmin and fresh session for mutations", async () => {
  let allowed = true;
  const queryable = {
    query: <T>() => Promise.resolve({ rows: allowed ? [{} as T] : [] }),
  };
  const options = createMcpOAuthOptions(
    queryable,
    new URL("https://relay.test"),
  );
  const privileges = options.clientPrivileges!;
  type Input = Parameters<typeof privileges>[0];
  const request = {
    user: { id: "operator" },
    session: { createdAt: new Date() },
    headers: new Headers(),
    action: "create",
  } as Input;
  assertEquals(await privileges(request), true);
  allowed = false;
  assertEquals(await privileges(request), false);
  allowed = true;
  const stale = {
    ...request,
    session: { ...request.session, createdAt: new Date(0) },
  } as Input;
  await assertRejects(() => Promise.resolve(privileges(stale)), APIError);
  assertEquals(await privileges({ ...stale, action: "list" }), true);
  assertEquals(
    await privileges({
      ...request,
      action: "configure-client-credentials-scopes",
    }),
    false,
  );
  assertEquals(await privileges({ ...request, user: undefined }), false);
  assertEquals(options.allowDynamicClientRegistration, false);
  assertEquals(options.storeClientSecret, "hashed");
});
