BEGIN;
DELETE FROM public.settings WHERE key IN ('openai_codex_client_version_synced','openai_codex_version_auto_sync_enabled');
INSERT INTO public.settings(key,value) VALUES('openai_codex_version_auto_sync_enabled','true');
DO $$
DECLARE result jsonb;
BEGIN
    result:=public.s2a_gateway_codex_version_save('0.162.1');
    IF result->>'version'<>'0.162.1' THEN RAISE EXCEPTION 'Version not saved'; END IF;
    result:=public.s2a_gateway_codex_version_save('0.146.0');
    IF result->>'version'<>'0.162.1' THEN RAISE EXCEPTION 'Version downgrade allowed'; END IF;
    UPDATE public.settings SET value='false' WHERE key='openai_codex_version_auto_sync_enabled';
    result:=public.s2a_gateway_codex_version_save('0.163.0');
    IF result<>'{}'::jsonb THEN RAISE EXCEPTION 'Disabled sync changed settings'; END IF;
    IF (SELECT value FROM public.settings WHERE key='openai_codex_client_version_synced')<>'0.162.1' THEN RAISE EXCEPTION 'Disabled sync overwritten'; END IF;
    IF has_function_privilege('anon','public.s2a_gateway_codex_version_save(text)','EXECUTE') OR
       has_function_privilege('authenticated','public.s2a_gateway_codex_version_save(text)','EXECUTE') THEN RAISE EXCEPTION 'Public sync permission granted'; END IF;
    IF NOT has_function_privilege('service_role','public.s2a_gateway_codex_version_save(text)','EXECUTE') THEN RAISE EXCEPTION 'Worker permission missing'; END IF;
END $$;
ROLLBACK;
