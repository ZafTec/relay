import { sql } from "kysely";
import type { Migration } from "./types.ts";

// Native Better Auth endpoints own client validation, ownership, and secret
// hashing. This trigger records management changes in their own transaction;
// secrets, hashes, redirect query strings, and freeform metadata never enter it.
export const CANONICAL_SQL = `
CREATE FUNCTION relay.audit_oauth_client_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, relay, auth
AS $body$
DECLARE
  owner_id text;
  client_id text;
  event_action text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    owner_id := OLD."userId";
    client_id := OLD."clientId";
    event_action := 'oauth_client.delete';
  ELSE
    owner_id := NEW."userId";
    client_id := NEW."clientId";
    IF TG_OP = 'INSERT' THEN
      event_action := 'oauth_client.create';
    ELSIF NEW."clientSecret" IS DISTINCT FROM OLD."clientSecret" THEN
      event_action := 'oauth_client.rotate_secret';
    ELSE
      event_action := 'oauth_client.update';
    END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth."user" WHERE id = owner_id) THEN
    owner_id := NULL;
  END IF;
  INSERT INTO relay.audit_events
    (actor_type, actor_user_id, action, target_type, target_id, outcome)
  VALUES
    (CASE WHEN owner_id IS NULL THEN 'system' ELSE 'user' END,
     owner_id, event_action, 'oauth_client', client_id, 'success');
  RETURN NULL;
END;
$body$;
REVOKE ALL ON FUNCTION relay.audit_oauth_client_change() FROM PUBLIC;
CREATE TRIGGER oauth_client_change_audit
AFTER INSERT OR UPDATE OR DELETE ON auth."oauthClient"
FOR EACH ROW EXECUTE FUNCTION relay.audit_oauth_client_change();
`;

export const migration: Migration = {
  id: "0003_oauth_client_audit",
  checksumSha256:
    "7dfa38382529c22abc8627ec43250274ab64a9235de2f1f6a2fa86acc1ba6d0e",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
