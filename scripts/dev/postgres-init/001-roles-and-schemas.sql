-- Local development role/schema model
-- (docs/implementation-handoff/02-runtime-database.md). Runs once against a
-- fresh `relay` database via docker-entrypoint-initdb.d. Passwords here are
-- dev-only defaults matching compose.dev.yaml and are never valid outside
-- this disposable local stack.
--
-- relay_owner    NOLOGIN; owns the auth/relay schemas and their objects.
-- relay_migrator LOGIN NOINHERIT; the one-shot migration command connects as
--                this role and uses SET ROLE relay_owner for DDL.
-- relay_app      LOGIN; runtime DML only -- cannot create, alter, truncate,
--                drop objects, or assume relay_owner.

CREATE ROLE relay_owner NOLOGIN;
CREATE ROLE relay_migrator LOGIN NOINHERIT PASSWORD 'relay_dev_only';
CREATE ROLE relay_app LOGIN PASSWORD 'relay_dev_only';

GRANT relay_owner TO relay_migrator;

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

ALTER ROLE relay_app SET search_path = relay, auth;
ALTER ROLE relay_migrator SET search_path = relay, auth;
