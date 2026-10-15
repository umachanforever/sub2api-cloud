-- Install after the native business migrations, before importing provider accounts.
-- Vault encrypts the canonical credential document while Go retains its native JSON contract.
BEGIN;
CREATE EXTENSION IF NOT EXISTS supabase_vault;
CREATE SCHEMA IF NOT EXISTS s2a_private AUTHORIZATION s2a_management;
GRANT USAGE ON SCHEMA vault TO s2a_management;
GRANT SELECT, DELETE ON TABLE vault.secrets TO s2a_management;
GRANT SELECT ON TABLE vault.decrypted_secrets TO s2a_management;
GRANT EXECUTE ON FUNCTION vault.create_secret(text,text,text,uuid) TO s2a_management;
GRANT EXECUTE ON FUNCTION vault._crypto_aead_det_decrypt(bytea,bytea,bigint,bytea,bytea) TO s2a_management;
REVOKE ALL ON SCHEMA s2a_private FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_class WHERE oid = 'public.accounts'::regclass AND relkind = 'r') THEN
        IF EXISTS (SELECT FROM public.accounts) THEN
            RAISE EXCEPTION 'Install account Vault storage on a fresh native account schema';
        END IF;
        IF (SELECT relowner FROM pg_class WHERE oid = 'public.accounts'::regclass) <> 's2a_management'::regrole THEN
            RAISE EXCEPTION 'Native accounts must be owned by s2a_management';
        END IF;
        ALTER TABLE public.accounts SET SCHEMA s2a_private;
    END IF;
END $$;
ALTER TABLE s2a_private.accounts ADD COLUMN IF NOT EXISTS s2a_credential_version bigint NOT NULL DEFAULT 1;
ALTER TABLE s2a_private.accounts ADD COLUMN IF NOT EXISTS s2a_refresh_lock_id uuid;
ALTER TABLE s2a_private.accounts ADD COLUMN IF NOT EXISTS s2a_refresh_lock_until timestamptz;

CREATE OR REPLACE FUNCTION s2a_private.account_credentials(p_id bigint) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE secret_id uuid; document text;
BEGIN
    SELECT (credentials->>'s2a_vault')::uuid INTO secret_id FROM s2a_private.accounts WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF secret_id IS NULL THEN RAISE EXCEPTION 'Account credentials are not encrypted'; END IF;
    SELECT decrypted_secret INTO document FROM vault.decrypted_secrets WHERE id = secret_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Account credential secret is missing'; END IF;
    RETURN document::jsonb;
END $$;
REVOKE ALL ON FUNCTION s2a_private.account_credentials(bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION s2a_private.account_credentials(bigint) TO s2a_management;

DO $$
DECLARE projection text; column_default record;
BEGIN
    SELECT string_agg(CASE WHEN attname = 'credentials'
        THEN 's2a_private.account_credentials(a.id) AS credentials'
        ELSE format('a.%I', attname) END, ', ' ORDER BY attnum)
    INTO projection FROM pg_attribute
    WHERE attrelid = 's2a_private.accounts'::regclass AND attnum > 0 AND NOT attisdropped;
    EXECUTE 'CREATE OR REPLACE VIEW public.accounts WITH (security_invoker = true) AS SELECT ' || projection || ' FROM s2a_private.accounts a';
    ALTER VIEW public.accounts OWNER TO s2a_management;
    FOR column_default IN
        SELECT a.attname, pg_get_expr(d.adbin, d.adrelid) AS expression
        FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 's2a_private.accounts'::regclass
    LOOP
        EXECUTE format('ALTER VIEW public.accounts ALTER COLUMN %I SET DEFAULT %s', column_default.attname, column_default.expression);
    END LOOP;
END $$;
REVOKE ALL ON TABLE public.accounts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE s2a_private.accounts FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE s2a_private.accounts ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION s2a_private.write_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE current_row public.accounts; stored_row s2a_private.accounts; payload jsonb;
    secret_id uuid; old_secret_id uuid; columns_sql text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        SELECT * INTO stored_row FROM s2a_private.accounts WHERE id = OLD.id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Account changed concurrently' USING ERRCODE = '40001'; END IF;
        SELECT * INTO current_row FROM public.accounts WHERE id = OLD.id;
        IF to_jsonb(current_row) IS DISTINCT FROM to_jsonb(OLD) THEN
            RAISE EXCEPTION 'Account changed concurrently' USING ERRCODE = '40001';
        END IF;
        old_secret_id := (stored_row.credentials->>'s2a_vault')::uuid;
    END IF;
    IF TG_OP = 'DELETE' THEN
        DELETE FROM s2a_private.accounts WHERE id = OLD.id;
        DELETE FROM vault.secrets WHERE id = old_secret_id;
        RETURN OLD;
    END IF;
    IF NEW.credentials IS NULL THEN RAISE EXCEPTION 'Account credentials are required' USING ERRCODE = '23502'; END IF;
    IF TG_OP = 'INSERT' OR NEW.credentials IS DISTINCT FROM OLD.credentials THEN
        secret_id := vault.create_secret(NEW.credentials::text);
    ELSE
        secret_id := old_secret_id;
    END IF;
    payload := to_jsonb(NEW) || jsonb_build_object('credentials', jsonb_build_object('s2a_vault', secret_id));
    stored_row := jsonb_populate_record(NULL::s2a_private.accounts, payload);
    IF TG_OP = 'INSERT' THEN
        stored_row.s2a_credential_version := 1;
        stored_row.s2a_refresh_lock_id := NULL;
        stored_row.s2a_refresh_lock_until := NULL;
    ELSE
        stored_row.s2a_credential_version := current_row.s2a_credential_version;
        IF NEW.credentials IS DISTINCT FROM OLD.credentials THEN
            stored_row.s2a_credential_version := current_row.s2a_credential_version + 1;
            stored_row.s2a_refresh_lock_id := NULL;
            stored_row.s2a_refresh_lock_until := NULL;
        END IF;
    END IF;
    IF TG_OP = 'INSERT' THEN
        INSERT INTO s2a_private.accounts SELECT stored_row.*;
    ELSE
        SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum) INTO columns_sql
        FROM pg_attribute WHERE attrelid = 's2a_private.accounts'::regclass AND attnum > 0 AND NOT attisdropped;
        EXECUTE 'UPDATE s2a_private.accounts SET (' || columns_sql || ') = (SELECT ($1).*) WHERE id = $2'
        USING stored_row, OLD.id;
        IF secret_id IS DISTINCT FROM old_secret_id THEN DELETE FROM vault.secrets WHERE id = old_secret_id; END IF;
    END IF;
    SELECT * INTO current_row FROM public.accounts WHERE id = NEW.id;
    RETURN current_row;
END $$;
REVOKE ALL ON FUNCTION s2a_private.write_account() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION s2a_private.write_account() TO s2a_management;
SET LOCAL ROLE s2a_management;
DROP TRIGGER IF EXISTS s2a_account_vault_write ON public.accounts;
CREATE TRIGGER s2a_account_vault_write INSTEAD OF INSERT OR UPDATE OR DELETE ON public.accounts
FOR EACH ROW EXECUTE FUNCTION s2a_private.write_account();
RESET ROLE;

CREATE OR REPLACE FUNCTION public.s2a_gateway_account_snapshot(p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE a public.accounts;
BEGIN
    SELECT * INTO a FROM public.accounts WHERE id = p_id AND deleted_at IS NULL AND status = 'active';
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'account_unavailable'); END IF;
    RETURN jsonb_build_object('id', a.id::text, 'credential_storage', 'vault', 'credentials', a.credentials,
        'credential_version', a.s2a_credential_version, 'platform', a.platform, 'type', a.type,
        'privacy_mode', a.extra->>'privacy_mode',
        'codex_settings', (SELECT jsonb_build_object(
            'version',max(value) FILTER(WHERE key='openai_codex_client_version'),
            'synced',max(value) FILTER(WHERE key='openai_codex_client_version_synced'),
            'synced_at',max(updated_at) FILTER(WHERE key='openai_codex_client_version_synced'),
            'auto_sync',max(value) FILTER(WHERE key='openai_codex_version_auto_sync_enabled'),
            'user_agent',max(value) FILTER(WHERE key='openai_codex_user_agent')) FROM public.settings
            WHERE key IN ('openai_codex_client_version','openai_codex_client_version_synced','openai_codex_version_auto_sync_enabled','openai_codex_user_agent')));
END $$;

CREATE OR REPLACE FUNCTION public.s2a_gateway_refresh_acquire(p_id bigint, p_version bigint, p_lock_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE affected integer;
BEGIN
    IF p_lock_id IS NULL THEN RETURN false; END IF;
    UPDATE public.accounts SET s2a_refresh_lock_id = p_lock_id,
        s2a_refresh_lock_until = statement_timestamp() + interval '30 seconds'
    WHERE id = p_id AND deleted_at IS NULL AND status = 'active' AND type = 'oauth'
        AND s2a_credential_version = p_version
        AND (s2a_refresh_lock_until IS NULL OR s2a_refresh_lock_until <= statement_timestamp());
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected = 1;
EXCEPTION WHEN serialization_failure THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.s2a_gateway_refresh_save(p_id bigint, p_version bigint, p_lock_id uuid, p_credentials jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE affected integer;
BEGIN
    IF p_credentials IS NULL OR jsonb_typeof(p_credentials) <> 'object' OR
        jsonb_typeof(p_credentials->'access_token') IS DISTINCT FROM 'string' OR
        btrim(p_credentials->>'access_token') = '' OR octet_length(p_credentials::text) > 131072 THEN
        RETURN false;
    END IF;
    UPDATE public.accounts SET credentials = p_credentials,
        s2a_refresh_lock_id = NULL, s2a_refresh_lock_until = NULL, updated_at = statement_timestamp()
    WHERE id = p_id AND deleted_at IS NULL AND status = 'active' AND type = 'oauth'
        AND s2a_credential_version = p_version AND s2a_refresh_lock_id = p_lock_id
        AND s2a_refresh_lock_until > statement_timestamp();
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected = 1;
EXCEPTION WHEN serialization_failure THEN RETURN false;
END $$;

CREATE OR REPLACE FUNCTION public.s2a_gateway_refresh_release(p_id bigint, p_lock_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    UPDATE public.accounts SET s2a_refresh_lock_id = NULL, s2a_refresh_lock_until = NULL
    WHERE id = p_id AND s2a_refresh_lock_id = p_lock_id;
EXCEPTION WHEN serialization_failure THEN RETURN;
END $$;
REVOKE ALL ON FUNCTION public.s2a_gateway_account_snapshot(bigint),
    public.s2a_gateway_refresh_acquire(bigint,bigint,uuid),
    public.s2a_gateway_refresh_save(bigint,bigint,uuid,jsonb),
    public.s2a_gateway_refresh_release(bigint,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_account_snapshot(bigint),
    public.s2a_gateway_refresh_acquire(bigint,bigint,uuid),
    public.s2a_gateway_refresh_save(bigint,bigint,uuid,jsonb),
    public.s2a_gateway_refresh_release(bigint,uuid) TO service_role;
CREATE OR REPLACE FUNCTION public.s2a_gateway_privacy_save(p_id bigint, p_version bigint, p_previous text, p_mode text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE affected integer;
BEGIN
    IF p_mode IS NULL OR p_mode NOT IN ('training_off', 'failed', 'cf_blocked') THEN RETURN false; END IF;
    UPDATE public.accounts SET extra = coalesce(extra, '{}'::jsonb) || jsonb_build_object('privacy_mode', p_mode),
        updated_at = statement_timestamp()
    WHERE id = p_id AND deleted_at IS NULL AND status = 'active' AND platform = 'openai' AND type = 'oauth'
        AND s2a_credential_version = p_version AND extra->>'privacy_mode' IS NOT DISTINCT FROM p_previous;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected = 1;
EXCEPTION WHEN serialization_failure THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.s2a_gateway_privacy_save(bigint,bigint,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_privacy_save(bigint,bigint,text,text) TO service_role;
-- Invoking a management-owned trigger must never inherit administrator privileges.
ALTER FUNCTION s2a_private.account_credentials(bigint) OWNER TO s2a_management;
ALTER FUNCTION s2a_private.write_account() OWNER TO s2a_management;
ALTER FUNCTION public.s2a_gateway_account_snapshot(bigint) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_gateway_refresh_acquire(bigint,bigint,uuid) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_gateway_refresh_save(bigint,bigint,uuid,jsonb) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_gateway_refresh_release(bigint,uuid) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_gateway_privacy_save(bigint,bigint,text,text) OWNER TO s2a_management;
CREATE OR REPLACE FUNCTION public.s2a_gateway_codex_version_save(p_version text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE current_version text; saved_at timestamptz;
BEGIN
    IF p_version !~ '^[0-9]+[.][0-9]+[.][0-9]+$' OR length(p_version)>32 THEN RAISE EXCEPTION 'Invalid Codex version'; END IF;
    IF EXISTS(SELECT FROM public.settings WHERE key='openai_codex_version_auto_sync_enabled' AND value='false') THEN RETURN '{}'::jsonb; END IF;
    PERFORM pg_advisory_xact_lock(246810246);
    SELECT value INTO current_version FROM public.settings WHERE key='openai_codex_client_version_synced';
    IF current_version ~ '^[0-9]+[.][0-9]+[.][0-9]+$' AND string_to_array(current_version,'.')::bigint[] > string_to_array(p_version,'.')::bigint[] THEN
        SELECT updated_at INTO saved_at FROM public.settings WHERE key='openai_codex_client_version_synced';
        RETURN jsonb_build_object('version',current_version,'synced_at',saved_at);
    END IF;
    INSERT INTO public.settings(key,value,updated_at) VALUES('openai_codex_client_version_synced',p_version,clock_timestamp())
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at RETURNING updated_at INTO saved_at;
    RETURN jsonb_build_object('version',p_version,'synced_at',saved_at);
END $$;
ALTER FUNCTION public.s2a_gateway_codex_version_save(text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_codex_version_save(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_codex_version_save(text) TO service_role;
COMMIT;
