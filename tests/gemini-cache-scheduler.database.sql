BEGIN;
DO $$
BEGIN
 IF has_function_privilege('anon','public.s2a_gemini_cache_scheduler_configure(text,text,boolean)','EXECUTE')
 OR has_function_privilege('authenticated','public.s2a_gemini_cache_jobs_dispatch()','EXECUTE')
 OR has_function_privilege('service_role','public.s2a_gemini_cache_jobs_dispatch()','EXECUTE')
 OR has_table_privilege('service_role','public.s2a_gemini_cache_scheduler','SELECT')
 OR NOT has_function_privilege('service_role','public.s2a_gemini_cache_scheduler_configure(text,text,boolean)','EXECUTE') THEN RAISE EXCEPTION 'Gemini scheduler ACL mismatch'; END IF;
 IF public.s2a_gemini_cache_scheduler_configure(NULL,NULL,false)->>'enabled' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Gemini scheduler disabling failed'; END IF;
END $$;
ROLLBACK;
