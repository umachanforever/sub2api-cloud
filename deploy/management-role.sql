-- Run as the database administrator before enabling Go management.
-- Set the login password separately through the deployment secret channel.
BEGIN;
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 's2a_management') THEN
        CREATE ROLE s2a_management LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    END IF;
    IF EXISTS (
        SELECT FROM pg_roles WHERE rolname = 's2a_management'
        AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    ) OR EXISTS (
        SELECT FROM pg_auth_members
        WHERE member = 's2a_management'::regrole OR (
            roleid = 's2a_management'::regrole AND member NOT IN (
                SELECT oid FROM pg_roles WHERE rolsuper OR rolname IN ('postgres', 'supabase_admin')
            )
        )
    ) THEN
        RAISE EXCEPTION 'Management role must not inherit privileges or have non-administrator members';
    END IF;
END $$;
GRANT USAGE, CREATE ON SCHEMA public TO s2a_management;
-- Supabase grants the creator ADMIN without SET; configure defaults as the owner.
DO $$ BEGIN
    EXECUTE format('GRANT s2a_management TO %I WITH SET TRUE', current_user);
END $$;
SET LOCAL ROLE s2a_management;
ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management REVOKE ALL ON FUNCTIONS FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management REVOKE ALL ON TABLES FROM %I', api_role);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management REVOKE ALL ON SEQUENCES FROM %I', api_role);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management REVOKE ALL ON FUNCTIONS FROM %I', api_role);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management IN SCHEMA public REVOKE ALL ON TABLES FROM %I', api_role);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', api_role);
            EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', api_role);
        END IF;
    END LOOP;
END $$;
ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE s2a_management IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
COMMIT;
