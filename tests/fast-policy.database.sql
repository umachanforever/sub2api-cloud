BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE role_name text; g bigint; u bigint; a bigint; h text; decision jsonb;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(role_name,'s2a_private.fast_policy_context(bigint,boolean)','EXECUTE') THEN RAISE EXCEPTION 'fast policy helper exposed'; END IF;
 END LOOP;
 INSERT INTO public.settings(key,value) VALUES('openai_fast_policy_settings','{"rules":[{"service_tier":"priority","action":"block","user_ids":[7]}]}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;
 INSERT INTO public.groups(name,platform,force_openai_fast) VALUES('Fast policy acceptance','openai',true) RETURNING id INTO g;
 INSERT INTO public.users(email,password_hash,concurrency) VALUES('fast-'||gen_random_uuid()||'@example.invalid','!fixture',10) RETURNING id INTO u;
 INSERT INTO public.api_keys(user_id,group_id,key,name) VALUES(u,g,'synthetic-'||gen_random_uuid(),'Fast policy key') RETURNING s2a_key_hash INTO h;
 INSERT INTO public.accounts(name,platform,type,credentials) VALUES('Fast policy account','openai','apikey','{"api_key":"synthetic"}') RETURNING id INTO a;
 INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g);
 decision:=public.s2a_personal_acquire(h,'gpt-6-sol',gen_random_uuid(),p_billing_context=>'{"inbound_endpoint":"/v1/responses","count_only":true}');
 IF decision->'fast_policy'->>'user_id' IS DISTINCT FROM u::text OR decision->'fast_policy'->>'force_priority' IS DISTINCT FROM 'true' OR decision->'fast_policy'->'settings'->'rules'->0->>'action' IS DISTINCT FROM 'block' THEN RAISE EXCEPTION 'trusted policy snapshot missing'; END IF;
 UPDATE public.settings SET value='not-json' WHERE key='openai_fast_policy_settings';
 IF s2a_private.fast_policy_context(u,false)->'settings' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'corrupt settings did not use original fallback'; END IF;
END $$;
ROLLBACK;
