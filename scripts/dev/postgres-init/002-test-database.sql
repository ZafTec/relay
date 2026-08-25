-- A second, fully disposable database with the same role/schema layout as
-- `relay`. Some integration tests (packages/database/src/migrator_test.ts)
-- must exercise genuinely destructive operations -- dropping and
-- recreating `relay.schema_migrations`, replaying the migration manifest
-- against fixture migrations, etc. -- to test the migrator itself. Pointing
-- those tests at the same database as everything else, addressed only by a
-- generic DATABASE_URL, is how a destructive test drops the real migration
-- ledger (see MIGRATOR_TEST_DATABASE_URL in .env.example, and the guard in
-- migrator_test.ts that refuses to run unless connected to a database whose
-- name ends in `_test`). `relay_test` exists purely so those tests always
-- have a target that is never the database anything else depends on.

CREATE DATABASE relay_test;

\c relay_test

REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION relay_owner;
CREATE SCHEMA IF NOT EXISTS relay AUTHORIZATION relay_owner;

GRANT USAGE ON SCHEMA auth, relay TO relay_app;
GRANT USAGE ON SCHEMA auth, relay TO relay_migrator;

ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relay_app;
ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA relay
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO relay_app;
ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA auth
  GRANT USAGE, SELECT ON SEQUENCES TO relay_app;
ALTER DEFAULT PRIVILEGES FOR ROLE relay_owner IN SCHEMA relay
  GRANT USAGE, SELECT ON SEQUENCES TO relay_app;
