BEGIN;
DO $$
BEGIN
 IF has_function_privilege('anon','public.s2a_codex_scheduler_configure(text,text,boolean)','EXECUTE')
 OR has_function_privilege('authenticated','public.s2a_codex_jobs_dispatch()','EXECUTE')
 OR has_function_privilege('service_role','public.s2a_codex_jobs_dispatch()','EXECUTE')
 OR NOT has_function_privilege('service_role','public.s2a_gateway_codex_settings()','EXECUTE')
 THEN RAISE EXCEPTION 'Codex scheduler ACL mismatch'; END IF;
 IF NOT EXISTS(SELECT FROM cron.job WHERE jobname='s2a-codex-jobs' AND schedule='17 */6 * * *' AND active)
 THEN RAISE EXCEPTION 'Codex cron missing'; END IF;
 INSERT INTO public.settings(key,value) VALUES('openai_codex_version_auto_sync_enabled','false')
 ON CONFLICT(key) DO UPDATE SET value=excluded.value;
 IF public.s2a_codex_jobs_dispatch() IS NOT NULL THEN RAISE EXCEPTION 'Disabled synchronization dispatched'; END IF;
END $$;
ROLLBACK;
