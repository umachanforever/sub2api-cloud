BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE g bigint; u bigint; a bigint; b bigint; h text; decision jsonb; acquired jsonb; catalog jsonb;
BEGIN
 IF has_function_privilege('service_role','s2a_private.composite_resolve(bigint,text,text)','EXECUTE') THEN RAISE EXCEPTION 'private resolver exposed'; END IF;
 INSERT INTO public.users(email,password_hash,concurrency) VALUES('composite-'||gen_random_uuid()||'@example.invalid','!fixture',0) RETURNING id INTO u;
 INSERT INTO public.groups(name,platform) VALUES('Composite acceptance','composite') RETURNING id INTO g;
 INSERT INTO public.api_keys(user_id,group_id,key,name) VALUES(u,g,'synthetic-'||gen_random_uuid(),'Composite') RETURNING s2a_key_hash INTO h;
 INSERT INTO public.accounts(name,platform,type,credentials,concurrency,priority) VALUES('Composite OpenAI','openai','apikey','{"api_key":"synthetic","model_mapping":{"gpt-6":"gpt-6-sol","shared":"gpt-6","claude-owned":"gpt-6","public-openai":"gpt-6"}}',10,0) RETURNING id INTO a;
 INSERT INTO public.accounts(name,platform,type,credentials,concurrency,priority) VALUES('Composite Grok','grok','apikey','{"api_key":"synthetic","model_mapping":{"grok-*":"grok-4.6","shared":"grok-4.6"}}',10,0) RETURNING id INTO b;
 INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g),(b,g);
 IF s2a_private.composite_resolve(g,'shared','responses')->>'error' IS DISTINCT FROM 'composite_model_ambiguous' THEN RAISE EXCEPTION 'ambiguous account ownership guessed'; END IF;
 IF s2a_private.composite_resolve(g,'claude-owned','responses')->>'platform' IS DISTINCT FROM 'openai' THEN RAISE EXCEPTION 'detector overrode account ownership'; END IF;
 IF s2a_private.composite_resolve(g,'unknown-model','responses')->>'error' IS DISTINCT FROM 'composite_model_unresolved' THEN RAISE EXCEPTION 'unknown model guessed'; END IF;
 INSERT INTO public.composite_model_routes(group_id,public_model,match_type,target_platform,upstream_model,endpoint,priority) VALUES
 (g,'alias','prefix','grok','','responses',0),
 (g,'alias-long','exact','openai','gpt-6','any',100),
 (g,'alias-long','exact','grok','grok-4.6','responses',200),
 (g,'alias-','prefix','openai','gpt-6','chat_completions',100);
 catalog:=s2a_private.composite_catalog_sources(g);
 IF jsonb_array_length(catalog->'sources')<>2 OR jsonb_array_length(catalog->'routes')<>4 THEN RAISE EXCEPTION 'Composite catalog sources missing'; END IF;
 IF catalog::text LIKE '%synthetic%' OR catalog::text LIKE '%api_key%' OR catalog::text LIKE '%credential%' THEN RAISE EXCEPTION 'Composite catalog leaked provider credentials'; END IF;
 IF has_function_privilege('service_role','s2a_private.composite_catalog_sources(bigint)','EXECUTE') OR has_function_privilege('authenticated','s2a_private.composite_catalog_sources(bigint)','EXECUTE') THEN RAISE EXCEPTION 'private catalog exposed'; END IF;
 IF s2a_private.composite_catalog_sources(-1) IS DISTINCT FROM '{"sources":[],"routes":[]}'::jsonb THEN RAISE EXCEPTION 'Composite catalog group isolation failed'; END IF;
 UPDATE s2a_private.accounts SET schedulable=false WHERE id=b;
 IF jsonb_array_length(s2a_private.composite_catalog_sources(g)->'sources')<>1 THEN RAISE EXCEPTION 'disabled account included in catalog'; END IF;
 UPDATE s2a_private.accounts SET schedulable=true WHERE id=b;
 decision:=s2a_private.composite_resolve(g,'alias-long','responses');
 IF decision->>'platform'<>'grok' OR decision->>'upstream_model'<>'grok-4.6' THEN RAISE EXCEPTION 'endpoint specificity failed'; END IF;
 decision:=s2a_private.composite_resolve(g,'alias-long','chat_completions');
 IF decision->>'platform'<>'openai' THEN RAISE EXCEPTION 'exact route did not beat endpoint prefix'; END IF;
 decision:=s2a_private.composite_resolve(g,'alias-other','responses');
 IF decision->>'upstream_model'<>'alias-other' THEN RAISE EXCEPTION 'blank prefix upstream collapsed model'; END IF;
 acquired:=public.s2a_personal_acquire(h,'alias-long',gen_random_uuid(),p_billing_context=>'{"inbound_endpoint":"/v1/chat/completions"}');
 IF acquired ? 'error' OR acquired->'account'->>'id' IS DISTINCT FROM a::text OR acquired->>'upstream_model' IS DISTINCT FROM 'gpt-6-sol' THEN RAISE EXCEPTION 'Composite account mapping chain failed: %',acquired->>'error'; END IF;
 UPDATE public.composite_model_routes SET upstream_model='grok-4.6',target_platform='grok' WHERE group_id=g AND public_model='alias-long' AND endpoint='any';
 decision:=public.s2a_personal_acquire(h,'alias-long',(SELECT request_id FROM s2a_private.personal_gateway_leases WHERE id=(acquired->>'lease_id')::uuid),p_billing_context=>'{"inbound_endpoint":"/v1/chat/completions"}');
 IF decision->>'lease_id' IS DISTINCT FROM acquired->>'lease_id' OR decision->>'upstream_model' IS DISTINCT FROM acquired->>'upstream_model' THEN RAISE EXCEPTION 'Composite route changed during replay'; END IF;
 acquired:=public.s2a_personal_acquire(h,'grok-4.6',gen_random_uuid(),p_billing_context=>'{"inbound_endpoint":"/v1/responses"}');
 IF acquired ? 'error' OR acquired->'account'->>'id' IS DISTINCT FROM b::text THEN RAISE EXCEPTION 'Composite detector did not select Grok'; END IF;
 acquired:=public.s2a_personal_acquire(h,'public-openai',gen_random_uuid(),p_billing_context=>'{"inbound_endpoint":"/v1/responses"}');
 IF acquired ? 'error' OR acquired->'account'->>'id' IS DISTINCT FROM a::text THEN RAISE EXCEPTION 'Composite exact account alias failed'; END IF;
END $$;
ROLLBACK;
