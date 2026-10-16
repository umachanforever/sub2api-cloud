BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE role_name text; g bigint; u bigint; a bigint; h text; decision jsonb; completion jsonb; logged_tier text;
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
 IF decision->'fast_policy'->>'user_id' IS DISTINCT FROM u::text OR decision->'fast_policy'->>'force_priority' IS DISTINCT FROM 'true' OR jsonb_typeof(decision->'fast_policy'->'settings_json') IS DISTINCT FROM 'string' OR (decision->'fast_policy'->>'settings_json')::jsonb->'rules'->0->>'action' IS DISTINCT FROM 'block' THEN RAISE EXCEPTION 'trusted policy snapshot missing'; END IF;
 PERFORM public.s2a_personal_finish((decision->>'lease_id')::uuid,200,'completed',0,0,0,0,0,1);
 decision:=public.s2a_personal_acquire(h,'gpt-6-sol',gen_random_uuid(),p_billing_context=>'{"inbound_endpoint":"/v1/responses"}');
 completion:=public.s2a_personal_finish((decision->>'lease_id')::uuid,200,'completed',1,2,0,0,0,1,p_service_tier=>'not a valid tier');
 IF completion->>'error' IS DISTINCT FROM 'invalid_usage' THEN RAISE EXCEPTION 'malformed effective tier accepted'; END IF;
 completion:=public.s2a_personal_finish((decision->>'lease_id')::uuid,200,'completed',1,2,0,0,0,1,p_service_tier=>'priority');
 SELECT service_tier INTO logged_tier FROM public.usage_logs WHERE id=(completion->>'usage_log_id')::bigint AND s2a_personal_details->>'serviceTier'='priority';
 IF logged_tier IS DISTINCT FROM 'priority' THEN RAISE EXCEPTION 'effective tier missing from native usage'; END IF;
 completion:=public.s2a_personal_finish((decision->>'lease_id')::uuid,200,'completed',1,2,0,0,0,1,p_service_tier=>'priority');
 IF completion->>'applied' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'effective tier replay not idempotent'; END IF;
 completion:=public.s2a_personal_finish((decision->>'lease_id')::uuid,200,'completed',1,2,0,0,0,1,p_service_tier=>'flex');
 IF completion->>'error' IS DISTINCT FROM 'completion_conflict' THEN RAISE EXCEPTION 'tier replay mutation accepted'; END IF;
 UPDATE public.settings SET value='not-json' WHERE key='openai_fast_policy_settings';
 IF s2a_private.fast_policy_context(u,false)->>'settings_json' IS DISTINCT FROM 'not-json' THEN RAISE EXCEPTION 'raw settings did not reach original parser'; END IF;
END $$;
ROLLBACK;
