BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE g bigint; other_group bigint; a bigint; b bigint; foreign_account bigint; u bigint; h text; decision jsonb; sources jsonb; role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(role_name,'s2a_private.composite_catalog_sources(bigint)','EXECUTE') THEN RAISE EXCEPTION 'configured sources callable by %',role_name; END IF;
 END LOOP;
 INSERT INTO public.groups(name,platform) VALUES('Configured catalog acceptance','openai') RETURNING id INTO g;
 INSERT INTO public.groups(name,platform) VALUES('Other configured group','openai') RETURNING id INTO other_group;
 INSERT INTO public.accounts(name,platform,type,credentials,priority) VALUES('Configured first','openai','apikey','{"api_key":"private-first","model_mapping":{"first":"target"}}',0) RETURNING id INTO a;
 INSERT INTO public.accounts(name,platform,type,credentials,priority) VALUES('Configured second','openai','oauth','{"access_token":"private-second","model_mapping":{"second":"target"}}',1) RETURNING id INTO b;
 INSERT INTO public.accounts(name,platform,type,credentials) VALUES('Foreign configured account','openai','apikey','{"api_key":"private-foreign","model_mapping":{"foreign":"target"}}') RETURNING id INTO foreign_account;
 INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g),(b,g),(foreign_account,other_group);
 sources:=s2a_private.composite_catalog_sources(g);
 IF jsonb_array_length(sources->'sources')<>2 OR sources->'sources'->0->'mapping'->>'first' IS DISTINCT FROM 'target' OR sources->'sources'->1->'mapping'->>'second' IS DISTINCT FROM 'target' THEN RAISE EXCEPTION 'configured group mappings missing'; END IF;
 IF sources::text LIKE '%private-%' OR sources::text LIKE '%credentials%' OR sources::text LIKE '%foreign%' THEN RAISE EXCEPTION 'configured sources exposed credentials or another group'; END IF;
 UPDATE s2a_private.accounts SET temp_unschedulable_until=now()+interval '1 hour' WHERE id=b;
 IF jsonb_array_length(s2a_private.composite_catalog_sources(g)->'sources')<>1 THEN RAISE EXCEPTION 'configured picker includes cooldown account'; END IF;
 UPDATE s2a_private.accounts SET temp_unschedulable_until=NULL,auto_pause_on_expired=true,expires_at=now()-interval '1 minute' WHERE id=b;
 IF jsonb_array_length(s2a_private.composite_catalog_sources(g)->'sources')<>1 THEN RAISE EXCEPTION 'configured picker includes expired account'; END IF;
 UPDATE s2a_private.accounts SET auto_pause_on_expired=false WHERE id=b;
 INSERT INTO public.users(email,password_hash,concurrency) VALUES('configured-'||gen_random_uuid()||'@example.invalid','!fixture',2) RETURNING id INTO u;
 INSERT INTO public.api_keys(user_id,group_id,key,name) VALUES(u,g,'synthetic-'||gen_random_uuid(),'Configured key') RETURNING s2a_key_hash INTO h;
 decision:=public.s2a_personal_acquire(h,'__models__',gen_random_uuid(),p_billing_context=>'{"inbound_endpoint":"/backend-api/codex/models"}');
 IF decision ? 'error' OR jsonb_array_length(decision->'configured_model_sources'->'sources') IS DISTINCT FROM 2 THEN RAISE EXCEPTION 'scheduled discovery lacks configured sources'; END IF;
 UPDATE s2a_private.personal_gateway_leases SET finished_at=now() WHERE group_id=g AND finished_at IS NULL;
 decision:=public.s2a_personal_acquire(h,'first',gen_random_uuid(),p_billing_context=>'{"inbound_endpoint":"/v1/responses"}');
 IF decision ? 'error' OR decision ? 'configured_model_sources' THEN RAISE EXCEPTION 'inference acquired unnecessary catalog data'; END IF;
 UPDATE public.accounts SET status='error' WHERE id=b;
 IF jsonb_array_length(s2a_private.composite_catalog_sources(g)->'sources')<>1 THEN RAISE EXCEPTION 'configured picker includes inactive account'; END IF;
END $$;
ROLLBACK;
