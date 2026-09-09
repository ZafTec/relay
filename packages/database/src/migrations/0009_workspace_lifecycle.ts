import { sql } from "kysely";
import type { Migration } from "./types.ts";

export const CANONICAL_SQL = `
ALTER TABLE auth.organization ADD COLUMN "deletedAt" timestamptz, ADD COLUMN "deletedBy" text;

CREATE FUNCTION relay.protect_workspace_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  IF NEW.slug IS DISTINCT FROM OLD.slug THEN RAISE EXCEPTION 'Workspace handles cannot change' USING ERRCODE='23514'; END IF;
  IF OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN RAISE EXCEPTION 'Workspace deletion is permanent' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER workspace_identity_protected BEFORE UPDATE ON auth.organization FOR EACH ROW EXECUTE FUNCTION relay.protect_workspace_identity();

CREATE FUNCTION relay.require_active_workspace() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $body$
BEGIN
  PERFORM id FROM auth.organization WHERE id=NEW.workspace_id AND "deletedAt" IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Workspace is no longer available' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$body$;
CREATE TRIGGER tool_runs_active_workspace BEFORE INSERT ON relay.tool_runs FOR EACH ROW EXECUTE FUNCTION relay.require_active_workspace();
CREATE TRIGGER artifacts_active_workspace BEFORE INSERT ON relay.artifacts FOR EACH ROW EXECUTE FUNCTION relay.require_active_workspace();
CREATE TRIGGER artifact_uploads_active_workspace BEFORE INSERT ON relay.artifact_uploads FOR EACH ROW EXECUTE FUNCTION relay.require_active_workspace();
CREATE TRIGGER artifact_versions_active_workspace BEFORE INSERT ON relay.artifact_versions FOR EACH ROW EXECUTE FUNCTION relay.require_active_workspace();
`;

export const migration: Migration = {
  id: "0009_workspace_lifecycle",
  checksumSha256:
    "d05b2f53086a04fe3065318d11abf1d829cb87de281a07b833b85ab3a8e83b01",
  transactional: true,
  up: async (db) => {
    await sql.raw(CANONICAL_SQL).execute(db);
  },
};
