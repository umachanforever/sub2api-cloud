BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE g bigint; a bigint; u bigint; h text; decision jsonb; lease uuid; version bigint; metadata jsonb;
BEGIN
 IF has_function_privilege('authenticated','public.s2a_personal_model_backoff(uuid,bigint,text,integer)','EXECUTE')
  OR has_function_privilege('anon','public.s2a_personal_model_backoff(uuid,bigint,text,integer)','EXECUTE')
  OR NOT has_function_privilege('service_role','public.s2a_personal_model_backoff(uuid,bigint,text,integer)','EXECUTE') THEN RAISE EXCEPTION 'backoff RPC grant mismatch'; END IF;
 INSERT INTO public.groups(name,platform) VALUES('Antigravity backoff fixture','antigravity') RETURNING id INTO g;
 INSERT INTO public.accounts(name,platform,type,credentials,concurrency,extra) VALUES('Antigravity backoff fixture','antigravity','oauth',
  '{"access_token":"synthetic-token","project_id":"synthetic-project","model_mapping":{"alias":"gemini-test","alias-two":"gemini-test","gemini-other":"gemini-other","claude-other":"claude-other","gemini-test-image":"gemini-test-image","gemini-new-high":"gemini-new-high"}}',10,'{"overages_enabled":false}') RETURNING id INTO a;
 INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g);
 INSERT INTO public.users(email,password_hash,concurrency) VALUES('backoff-'||gen_random_uuid()||'@example.invalid','!fixture',0) RETURNING id INTO u;
 INSERT INTO public.api_keys(user_id,group_id,key,name) VALUES(u,g,'synthetic-'||gen_random_uuid(),'Backoff key') RETURNING s2a_key_hash INTO h;
 decision:=public.s2a_personal_acquire(h,'alias',gen_random_uuid());
 lease:=(decision->>'lease_id')::uuid; version:=(decision->'account'->>'credential_version')::bigint;
 IF lease IS NULL THEN RAISE EXCEPTION 'fixture admission failed: %',decision; END IF;
 IF decision->'account'->'overages_enabled' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'overages enabled without opt-in'; END IF;
 IF public.s2a_personal_model_backoff(lease,version+1,'gemini-test',120) THEN RAISE EXCEPTION 'stale version accepted'; END IF;
 IF public.s2a_personal_model_backoff(lease,version,'gemini-test',86401) THEN RAISE EXCEPTION 'unbounded backoff accepted'; END IF;
 IF NOT public.s2a_personal_model_backoff(lease,version,'gemini-test',120) THEN RAISE EXCEPTION 'backoff save failed'; END IF;
 SELECT extra INTO metadata FROM s2a_private.accounts WHERE id=a;
 IF NOT s2a_private.model_backoff_active(metadata,'gemini-test') OR NOT s2a_private.model_backoff_active(metadata,'antigravity:gemini') THEN RAISE EXCEPTION 'alias/model backoff missing'; END IF;
 IF EXISTS(SELECT FROM s2a_private.accounts WHERE id=a AND temp_unschedulable_until>clock_timestamp()) THEN RAISE EXCEPTION 'account cooled down'; END IF;
 UPDATE s2a_private.personal_gateway_leases SET finished_at=clock_timestamp() WHERE id=lease;
 IF public.s2a_personal_model_backoff(lease,version,'gemini-test',120) THEN RAISE EXCEPTION 'finished lease wrote backoff'; END IF;
 decision:=public.s2a_personal_acquire(h,'alias-two',gen_random_uuid());
 IF decision ? 'account' THEN RAISE EXCEPTION 'mapped alias bypassed model cooldown'; END IF;
 decision:=public.s2a_personal_acquire(h,'gemini-other',gen_random_uuid());
 IF decision ? 'account' THEN RAISE EXCEPTION 'shared Gemini text scope bypassed'; END IF;
  decision:=public.s2a_personal_acquire(h,'claude-other',gen_random_uuid());
  IF NOT decision ? 'account' THEN RAISE EXCEPTION 'Claude incorrectly blocked by Gemini text quota'; END IF;
  decision:=public.s2a_personal_acquire(h,'gemini-test-image',gen_random_uuid());
  IF NOT decision ? 'account' THEN RAISE EXCEPTION 'image incorrectly blocked by Gemini text quota'; END IF;
 UPDATE s2a_private.accounts SET extra=extra||'{"overages_enabled":true}' WHERE id=a;
 decision:=public.s2a_personal_acquire(h,'alias-two',gen_random_uuid());
 lease:=(decision->>'lease_id')::uuid;
 IF lease IS NULL OR decision->'account'->'model_rate_limited' IS DISTINCT FROM 'true'::jsonb
  OR decision->'account'->'overages_enabled' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'opted-in credits request was not admitted'; END IF;
 IF NOT public.s2a_personal_model_backoff(lease,version,'AICredits',18000) THEN RAISE EXCEPTION 'credits cooldown save failed'; END IF;
 decision:=public.s2a_personal_acquire(h,'gemini-other',gen_random_uuid());
 IF decision ? 'account' THEN RAISE EXCEPTION 'exhausted credits bypassed shared quota'; END IF;
 decision:=public.s2a_personal_acquire(h,'claude-other',gen_random_uuid());
 IF NOT decision ? 'account' OR decision->'account'->'overages_enabled' IS DISTINCT FROM 'false'::jsonb THEN RAISE EXCEPTION 'credits exhaustion blocked normal inference or failed to disable overages'; END IF;
 IF NOT public.s2a_personal_model_backoff(lease,version,'AICredits',0) THEN RAISE EXCEPTION 'credits success did not clear exhaustion'; END IF;
 SELECT extra INTO metadata FROM s2a_private.accounts WHERE id=a;
 IF metadata->'model_rate_limits' ? 'AICredits' THEN RAISE EXCEPTION 'credits exhaustion key was not removed'; END IF;
 UPDATE s2a_private.accounts SET extra=extra-'model_rate_limits' WHERE id=a;
 decision:=public.s2a_personal_acquire(h,'gemini-new',gen_random_uuid());
 IF NOT decision ? 'account' THEN RAISE EXCEPTION 'variant-only bare model was not admitted: %',decision; END IF;
 IF s2a_private.model_backoff_active('{"model_rate_limits":{"test":{"rate_limit_reset_at":"invalid"}}}','test') THEN RAISE EXCEPTION 'invalid timestamp active'; END IF;
END $$;
ROLLBACK;
