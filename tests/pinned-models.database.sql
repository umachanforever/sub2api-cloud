BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE g bigint; other_group bigint; a bigint; b bigint; foreign_account bigint; sources jsonb; role_name text;
BEGIN
 FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
  IF has_function_privilege(role_name,'s2a_private.pinned_model_sources(bigint)','EXECUTE') THEN
   RAISE EXCEPTION 'pinned source credentials exposed to %',role_name;
  END IF;
 END LOOP;
 INSERT INTO public.groups(name,platform) VALUES('Pinned discovery acceptance','openai') RETURNING id INTO g;
 INSERT INTO public.groups(name,platform) VALUES('Foreign pinned group','openai') RETURNING id INTO other_group;
 IF s2a_private.pinned_model_sources(g) IS NOT NULL THEN RAISE EXCEPTION 'disabled pinned configuration enabled'; END IF;
 INSERT INTO public.accounts(name,platform,type,credentials,priority,concurrency) VALUES('Pinned first','openai','apikey','{"api_key":"synthetic-first"}',100,1) RETURNING id INTO a;
 INSERT INTO public.accounts(name,platform,type,credentials,priority,concurrency) VALUES('Pinned second','openai','oauth','{"access_token":"synthetic-second"}',0,1) RETURNING id INTO b;
 INSERT INTO public.accounts(name,platform,type,credentials) VALUES('Foreign account','openai','apikey','{"api_key":"synthetic-foreign"}') RETURNING id INTO foreign_account;
 INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g),(b,g),(foreign_account,other_group);
 UPDATE public.groups SET codex_models_manifest_config=jsonb_build_object('enabled',true,'account_ids',jsonb_build_array(a,b,a,foreign_account),'fallback_to_scheduler',true) WHERE id=g;
 UPDATE s2a_private.accounts SET overload_until=now()+interval '1 hour',rate_limit_reset_at=now()+interval '1 hour',temp_unschedulable_until=now()+interval '1 hour' WHERE id=a;
 sources:=s2a_private.pinned_model_sources(g);
 IF jsonb_array_length(sources->'accounts')<>2 OR sources->'accounts'->0->>'id' IS DISTINCT FROM a::text OR sources->'accounts'->1->>'id' IS DISTINCT FROM b::text THEN RAISE EXCEPTION 'pinned order, deduplication or membership mismatch'; END IF;
 IF sources->'fallback_to_scheduler' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'fallback policy lost'; END IF;
 IF sources->'accounts'->0->>'credential_storage' IS DISTINCT FROM 'vault' OR sources->'accounts'->0->'credentials'->>'api_key' IS DISTINCT FROM 'synthetic-first' THEN RAISE EXCEPTION 'trusted pinned snapshot unavailable'; END IF;
 IF EXISTS(SELECT FROM s2a_private.accounts WHERE id IN (a,b) AND credentials::text LIKE '%synthetic-%') THEN RAISE EXCEPTION 'pinned credentials not encrypted at rest'; END IF;
 UPDATE s2a_private.accounts SET auto_pause_on_expired=true,expires_at=now()-interval '1 minute' WHERE id=a;
 UPDATE s2a_private.accounts SET schedulable=false WHERE id=b;
 IF jsonb_array_length(s2a_private.pinned_model_sources(g)->'accounts')<>0 THEN RAISE EXCEPTION 'persistent ineligibility ignored'; END IF;
 UPDATE s2a_private.accounts SET auto_pause_on_expired=false WHERE id=a;
 IF jsonb_array_length(s2a_private.pinned_model_sources(g)->'accounts')<>1 THEN RAISE EXCEPTION 'disabled expiry pause excluded account'; END IF;
 UPDATE s2a_private.accounts SET status='error' WHERE id=a;
 IF jsonb_array_length(s2a_private.pinned_model_sources(g)->'accounts')<>0 THEN RAISE EXCEPTION 'inactive account exposed'; END IF;
 UPDATE public.groups SET codex_models_manifest_config='{"enabled":true,"account_ids":["1"]}' WHERE id=g;
 IF s2a_private.pinned_model_sources(g)->>'error' IS DISTINCT FROM 'invalid_pinned_model_config' THEN RAISE EXCEPTION 'invalid account identifiers accepted'; END IF;
 UPDATE public.groups SET platform='anthropic' WHERE id=g;
 IF s2a_private.pinned_model_sources(g) IS NOT NULL THEN RAISE EXCEPTION 'foreign platform pinned configuration used'; END IF;
 IF s2a_private.pinned_model_sources(-1) IS NOT NULL THEN RAISE EXCEPTION 'missing group accepted'; END IF;
END $$;
ROLLBACK;
