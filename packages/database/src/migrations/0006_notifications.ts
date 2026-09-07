import { sql } from "kysely";
import type { Migration } from "./types.ts";

export const CANONICAL_SQL = `
CREATE TABLE relay.notification_preferences (
  workspace_id text NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  completed boolean NOT NULL DEFAULT false,
  failed boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(workspace_id,user_id)
);
CREATE TABLE relay.notification_deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES auth.organization(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES auth."user"(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES relay.tool_runs(id) ON DELETE CASCADE,
  event text NOT NULL CHECK(event IN ('succeeded','failed')),
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sending','retrying','sent','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
  message_id uuid NOT NULL DEFAULT gen_random_uuid(),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  sent_at timestamptz,
  failure_code text CHECK(failure_code IN ('smtp_permanent','smtp_transient','smtp_transport','smtp_timeout','interrupted','retry_exhausted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,event)
);
CREATE INDEX notification_deliveries_pending ON relay.notification_deliveries(available_at,id) WHERE status IN ('pending','retrying','sending');
CREATE INDEX notification_deliveries_owner ON relay.notification_deliveries(workspace_id,user_id,id DESC);

CREATE FUNCTION relay.enqueue_run_notification() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.status IN ('succeeded','failed') AND OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO relay.notification_deliveries(workspace_id,user_id,run_id,event)
    SELECT NEW.workspace_id,NEW.created_by,NEW.id,NEW.status
    FROM relay.notification_preferences p
    JOIN auth."user" u ON u.id=p.user_id AND u."emailVerified"=true
    JOIN auth.member m ON m."userId"=p.user_id AND m."organizationId"=p.workspace_id
    WHERE p.workspace_id=NEW.workspace_id AND p.user_id=NEW.created_by
      AND ((NEW.status='succeeded' AND p.completed) OR (NEW.status='failed' AND p.failed))
    ON CONFLICT(run_id,event) DO NOTHING;
  END IF;
  RETURN NULL;
END;
$body$;
REVOKE ALL ON FUNCTION relay.enqueue_run_notification() FROM PUBLIC;
CREATE TRIGGER enqueue_run_notification AFTER UPDATE OF status ON relay.tool_runs FOR EACH ROW EXECUTE FUNCTION relay.enqueue_run_notification();
`;
export const migration: Migration = {
  id: "0006_notifications",
  checksumSha256:
    "f6db90b24d74cc6deb5dbbc314a3db5d9eb1325bc35880142dde9b60212a9f9c",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
