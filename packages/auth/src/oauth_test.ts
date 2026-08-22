import { assertEquals } from "@std/assert";
import { requireCurrentVerifiedEmail } from "./oauth.ts";

Deno.test("current provider response must contain a verified usable email", async () => {
  let response = {
    user: { email: "person@example.com", emailVerified: true },
    data: { provider: "fixture" },
  };
  const getUserInfo = requireCurrentVerifiedEmail(() =>
    Promise.resolve(response)
  );

  assertEquals(await getUserInfo(), response);

  response = {
    user: { email: "person@example.com", emailVerified: false },
    data: { provider: "fixture" },
  };
  assertEquals(await getUserInfo(), null);

  response = {
    user: { email: "   ", emailVerified: true },
    data: { provider: "fixture" },
  };
  assertEquals(await getUserInfo(), null);
});

Deno.test("provider verification is evaluated again on every callback", async () => {
  let verified = true;
  let calls = 0;
  const getUserInfo = requireCurrentVerifiedEmail(() => {
    calls += 1;
    return Promise.resolve({
      user: { email: "person@example.com", emailVerified: verified },
      data: {},
    });
  });

  assertEquals((await getUserInfo())?.user.emailVerified, true);
  verified = false;
  assertEquals(await getUserInfo(), null);
  assertEquals(calls, 2);
});
