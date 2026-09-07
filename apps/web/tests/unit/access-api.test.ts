import { afterEach, expect, it, vi } from "vitest";
import { notificationsApi } from "../../src/lib/api/notifications";
import { oauthClients } from "../../src/lib/api/oauth-clients";

afterEach(() => vi.unstubAllGlobals());
const respond = (body: unknown) => vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })));
const input = { name: "Local agent", redirectUris: ["http://localhost:3000/callback"], scopes: ["tools:read"], authMethod: "client_secret_post" as const };
const client = { client_id: "fixture-client", redirect_uris: input.redirectUris };
const preferences = { configured: true, completed: false, failed: false, deliveries: [] };

it("reads the notification envelope and refuses incomplete responses on reads and saves", async () => {
  respond({ notifications: preferences });
  expect(await notificationsApi.get()).toEqual(preferences);
  for (const body of [null, {}, preferences, { notifications: { ...preferences, deliveries: [null] } }]) {
    respond(body);
    await expect(notificationsApi.get()).rejects.toThrow("Invalid notification response");
    await expect(notificationsApi.update({ completed: true, failed: false })).rejects.toThrow("Invalid notification response");
  }
});

it("does not display a successful confidential creation or rotation without a usable secret", async () => {
  respond(client);
  await expect(oauthClients.create(input)).rejects.toThrow("Invalid OAuth credentials response");
  await expect(oauthClients.rotate(client)).rejects.toThrow("Invalid OAuth credentials response");
  respond({ ...client, client_secret: "fixture-secret" });
  expect(await oauthClients.create(input)).toMatchObject({ client_secret: "fixture-secret" });
  respond(client);
  expect(await oauthClients.create({ ...input, authMethod: "none" })).toEqual(client);
});

it("rejects malformed OAuth lists before they can reach the UI", async () => {
  for (const body of [null, {}, [null], [{ client_id: "missing-redirects" }]]) {
    respond(body);
    await expect(oauthClients.list()).rejects.toThrow();
  }
  respond([client]);
  expect(await oauthClients.list()).toEqual([client]);
});
