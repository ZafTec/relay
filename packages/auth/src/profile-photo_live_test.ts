import { assert, assertEquals } from "@std/assert";
import { createDatabasePool } from "@relay/database";
import { createTestAuth, withTestAuthContext } from "./test-utils.ts";

const url = Deno.env.get("DATABASE_URL");
Deno.test({
  name:
    "native profile updates persist safe images, reject unsafe input and require the user's session",
  ignore: !url,
  fn: async () => {
    const pool = createDatabasePool({
      url: new URL(url!),
      poolMax: 3,
      connectTimeoutMs: 5000,
      statementTimeoutMs: 10000,
    }, "relay-api");
    const auth = createTestAuth(pool);
    const user = await withTestAuthContext(
      auth,
      (test) =>
        test.saveUser(
          test.createUser({
            email: `photo-${crypto.randomUUID()}@example.test`,
            emailVerified: true,
          }),
        ),
    );
    const login = await withTestAuthContext(
      auth,
      (test) => test.login({ userId: user.id }),
    );
    let request = 0;
    const update = (image: unknown, authenticated = true) => {
      const headers = new Headers(authenticated ? login.headers : undefined);
      headers.set("origin", "http://localhost:8000");
      headers.set("content-type", "application/json");
      headers.set("x-relay-client-ip", `192.0.2.${++request + 10}`);
      return auth.handler(
        new Request("http://localhost:8000/api/auth/update-user", {
          method: "POST",
          headers,
          body: JSON.stringify({ image }),
        }),
      );
    };
    try {
      const providerImage = "https://avatars.githubusercontent.com/u/12345?v=4";
      assertEquals((await update(providerImage)).status, 200);
      assertEquals(
        (await pool.query('select image from auth."user" where id=$1', [
          user.id,
        ])).rows[0].image,
        providerImage,
      );
      const png =
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/7sAAAAASUVORK5CYII=";
      assertEquals((await update(png)).status, 200);
      assertEquals(
        (await pool.query('select image from auth."user" where id=$1', [
          user.id,
        ])).rows[0].image,
        png,
      );
      for (
        const unsafe of [
          "javascript:alert(1)",
          "http://insecure.test/a.png",
          "data:image/svg+xml;base64,PHN2Zy8+",
          "https://user:password@example.test/a.png",
        ]
      ) {
        assertEquals((await update(unsafe)).status, 400);
      }
      assertEquals((await update(null, false)).status, 401);
      const accountHeaders = new Headers(login.headers);
      const accounts = await auth.handler(
        new Request("http://localhost:8000/api/auth/list-accounts", {
          headers: accountHeaders,
        }),
      );
      assertEquals(accounts.status, 200);
      assert(Array.isArray(await accounts.json()));
      assertEquals((await update(null)).status, 200);
      assertEquals(
        (await pool.query('select image from auth."user" where id=$1', [
          user.id,
        ])).rows[0].image,
        null,
      );
    } finally {
      await pool.query('delete from auth.session where "userId"=$1', [user.id]);
      await pool.end();
    }
  },
});
