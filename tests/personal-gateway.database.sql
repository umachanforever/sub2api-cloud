BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE u bigint:=nullif(current_setting('s2a.acceptance.user_id',true),'')::bigint;
    k bigint:=nullif(current_setting('s2a.acceptance.key_id',true),'')::bigint;
    g bigint; a bigint; h text; request uuid:=gen_random_uuid(); acquired jsonb; result jsonb; lease uuid; search_kind text; cache_group bigint; cache_account bigint; alternative_cache_account bigint; oauth_cache_account bigint;
BEGIN
    IF has_function_privilege('anon','public.s2a_personal_key_policy(text,text)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_personal_key_policy(text,text)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_personal_key_policy(text,text)','EXECUTE')
        OR has_function_privilege('anon','public.s2a_personal_acquire(text,text,uuid,bigint[],boolean,text,jsonb)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_personal_acquire(text,text,uuid,bigint[],boolean,text,jsonb)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_personal_finish(uuid,integer,text,integer,integer,integer,integer,integer,bigint,integer,text)','EXECUTE')
        OR has_table_privilege('service_role','s2a_private.personal_gateway_leases','SELECT') THEN RAISE EXCEPTION 'personal gateway ACL mismatch'; END IF;
    IF u IS NULL THEN INSERT INTO public.users(email,password_hash) VALUES('gateway-fixture-'||gen_random_uuid()::text||'@example.invalid','!fixture') RETURNING id INTO u; END IF;
    IF k IS NULL THEN INSERT INTO public.api_keys(user_id,key,name) VALUES(u,'synthetic-gateway-'||gen_random_uuid()::text,'Gateway fixture') RETURNING id INTO k; END IF;
    INSERT INTO public.groups(name,platform) VALUES('Personal cloud contract','openai') RETURNING id INTO g;
    UPDATE public.api_keys SET group_id=g,ip_whitelist='[]',ip_blacklist='[]' WHERE id=k RETURNING s2a_key_hash INTO h;
    UPDATE public.users SET balance=0,restrict_public_groups=false WHERE id=u;
    INSERT INTO public.accounts(name,platform,type,credentials,concurrency,priority)
        VALUES('Personal cloud account','openai','apikey','{"api_key":"synthetic-private-token","model_mapping":{"alias":"gpt-5.4"}}',1,0) RETURNING id INTO a;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g);
    result:=public.s2a_personal_key_policy(h);
    IF result ? 'error' OR result->>'platform'<>'openai' OR result ? 'key_id' THEN RAISE EXCEPTION 'read-only key discovery failed or leaked identity'; END IF;
    IF public.s2a_personal_key_policy(repeat('0',64))->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'discovery accepted invalid key'; END IF;
    IF public.s2a_personal_key_policy(h,'127.0.0.1/8')->>'error' IS DISTINCT FROM 'invalid_client_ip' THEN RAISE EXCEPTION 'discovery accepted subnet'; END IF;
    IF has_function_privilege('anon','public.s2a_personal_key_billing(text,text)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_personal_key_billing(text,text)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_personal_key_billing(text,text)','EXECUTE') THEN RAISE EXCEPTION 'billing ACL mismatch'; END IF;
    UPDATE public.groups SET rate_multiplier=1.5 WHERE id=g;
    result:=public.s2a_personal_key_billing(h);
    IF result->>'object' IS DISTINCT FROM 'sub2api.key_billing' OR (result->>'effective_rate_multiplier')::numeric IS DISTINCT FROM 1.5
        OR result ? 'user_rate_multiplier' OR result ? 'key_id' THEN RAISE EXCEPTION 'billing group rate mismatch or identity leak'; END IF;
    UPDATE public.groups SET subscription_type='subscription',peak_rate_enabled=true,peak_start='00:00',peak_end='23:59',peak_rate_multiplier=0 WHERE id=g;
    result:=public.s2a_personal_key_billing(h);
    IF (result->>'peak_rate_multiplier')::numeric IS DISTINCT FROM 0 OR result->>'timezone' IS DISTINCT FROM 'Asia/Shanghai'
        OR (result->>'effective_rate_multiplier')::numeric IS DISTINCT FROM 1.5*s2a_private.gateway_peak_multiplier((SELECT to_jsonb(gr) FROM public.groups gr WHERE id=g),(result->>'observed_at')::timestamptz,'Asia/Shanghai') THEN RAISE EXCEPTION 'billing peak multiplier mismatch'; END IF;
    UPDATE public.groups SET subscription_type='standard',peak_rate_enabled=false WHERE id=g;
    ALTER FUNCTION s2a_private.gateway_peak_multiplier(jsonb,timestamptz,text) RENAME TO gateway_peak_multiplier_acceptance;
    result:=public.s2a_personal_key_billing(h);
    IF (result->>'effective_rate_multiplier')::numeric IS DISTINCT FROM 1.5 THEN RAISE EXCEPTION 'personal billing depends on native gateway installation'; END IF;
    ALTER FUNCTION s2a_private.gateway_peak_multiplier_acceptance(jsonb,timestamptz,text) RENAME TO gateway_peak_multiplier;
    INSERT INTO public.user_group_rate_multipliers(user_id,group_id,rate_multiplier) VALUES(u,g,0);
    result:=public.s2a_personal_key_billing(h);
    IF (result->>'user_rate_multiplier')::numeric IS DISTINCT FROM 0 OR (result->>'effective_rate_multiplier')::numeric IS DISTINCT FROM 0 THEN RAISE EXCEPTION 'billing lost zero user override'; END IF;
    IF EXISTS(SELECT 1 FROM s2a_private.personal_gateway_leases WHERE key_id=k) THEN RAISE EXCEPTION 'billing reserved account'; END IF;
    IF public.s2a_personal_key_billing(repeat('0',64))->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'billing accepted invalid key'; END IF;
    DELETE FROM public.user_group_rate_multipliers WHERE user_id=u AND group_id=g;
    UPDATE public.groups SET rate_multiplier=1 WHERE id=g;
    acquired:=public.s2a_personal_acquire(h,'alias',request);
    IF acquired ? 'error' OR acquired->'account'->>'id' IS DISTINCT FROM a::text
        OR acquired->'account'->>'credential_storage' IS DISTINCT FROM 'vault'
        OR acquired->'model_sources'->'mapping'->>'alias' IS DISTINCT FROM 'gpt-5.4' THEN RAISE EXCEPTION 'personal acquisition failed: %',acquired->>'error'; END IF;
    IF NOT public.s2a_personal_windows_save(a,1,100,'{"codex_5h_used_percent":25}')
        OR public.s2a_personal_windows_save(a,1,99,'{"codex_5h_used_percent":90}')
        OR public.s2a_personal_windows_save(a,2,101,'{"codex_5h_used_percent":90}')
        OR (SELECT extra->>'codex_5h_used_percent' FROM public.accounts WHERE id=a)<>'25'
        THEN RAISE EXCEPTION 'quota snapshot fencing failed'; END IF;
    PERFORM public.s2a_personal_ops_error_record(jsonb_build_object('request_id',request,'event_id',request,
        'key_hash',h,'account_id',a::text,'platform','openai','model','alias','phase','upstream',
        'type','upstream_error','status_code',502,'code','upstream_request_failed','duration_ms',3));
    IF NOT EXISTS(SELECT FROM public.ops_error_logs WHERE request_id=request::text AND user_id=u AND api_key_id=k
        AND account_id=a AND error_message='upstream_request_failed' AND error_body IS NULL)
        THEN RAISE EXCEPTION 'canonical sanitized ops error missing'; END IF;
    lease:=(acquired->>'lease_id')::uuid;
    IF public.s2a_personal_acquire(h,'alias',request)->>'lease_id' IS DISTINCT FROM lease::text THEN RAISE EXCEPTION 'acquisition replay changed slot'; END IF;
    IF public.s2a_personal_acquire(h,'different',request)->>'error' IS DISTINCT FROM 'request_conflict' THEN RAISE EXCEPTION 'request replay changed model'; END IF;
    IF public.s2a_personal_acquire(h,'alias',gen_random_uuid())->>'error' IS DISTINCT FROM 'no_available_account' THEN RAISE EXCEPTION 'account concurrency ignored'; END IF;
    result:=public.s2a_personal_finish(lease,200,'completed',100,20,NULL,40,0,1,5,'gpt-5.4');
    IF result->>'applied' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'personal finish failed: %',result; END IF;
    IF NOT EXISTS(SELECT FROM public.usage_logs WHERE id=(result->>'usage_log_id')::bigint AND user_id=u AND api_key_id=k AND account_id=a
        AND input_tokens=100 AND output_tokens=20 AND cache_read_tokens=40 AND actual_cost=0 AND total_cost=0
        AND upstream_model='gpt-5.4' AND s2a_personal_details->'cacheCreation'='null'::jsonb) THEN RAISE EXCEPTION 'raw usage was not recorded without charging'; END IF;
    IF (SELECT balance FROM public.users WHERE id=u)<>0 THEN RAISE EXCEPTION 'personal usage charged balance'; END IF;
    IF public.s2a_personal_finish(lease,200,'completed',100,20,NULL,40,0,1,5,'gpt-5.4')->>'applied' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'completion replay not deduplicated'; END IF;
    IF public.s2a_personal_finish(lease,200,'completed',101,20,NULL,40,0,1,5,'gpt-5.4')->>'error' IS DISTINCT FROM 'completion_conflict' THEN RAISE EXCEPTION 'completion replay changed usage'; END IF;
    IF public.s2a_personal_acquire(h,'alias',request)->>'error' IS DISTINCT FROM 'request_finished' THEN RAISE EXCEPTION 'completed request restarted'; END IF;
    acquired:=public.s2a_personal_acquire(h,'alias',gen_random_uuid());
    IF acquired ? 'error' THEN RAISE EXCEPTION 'interrupted acquisition failed'; END IF;
    lease:=(acquired->>'lease_id')::uuid;
    result:=public.s2a_personal_finish(lease,200,'interrupted',10,2,NULL,NULL,0,1,NULL,'gpt-5.4');
    IF result->>'applied' IS DISTINCT FROM 'true' OR NOT EXISTS(SELECT FROM s2a_private.personal_gateway_leases WHERE id=lease AND finished_at IS NOT NULL)
        OR NOT EXISTS(SELECT FROM public.usage_logs WHERE id=(result->>'usage_log_id')::bigint AND output_tokens=2 AND s2a_personal_details->>'outcome'='interrupted') THEN RAISE EXCEPTION 'interrupted usage did not release the lease and retain tokens'; END IF;
    request:=gen_random_uuid();
    acquired:=public.s2a_personal_acquire(h,'alias',request,'{}',true,NULL,'{"count_only":true}');
    IF acquired ? 'error' THEN RAISE EXCEPTION 'token preflight admission failed'; END IF;
    lease:=(acquired->>'lease_id')::uuid;
    IF public.s2a_personal_acquire(h,'alias',request,'{}',true,NULL,'{"count_only":false}')->>'error' IS DISTINCT FROM 'request_conflict' THEN RAISE EXCEPTION 'preflight replay changed request kind'; END IF;
    result:=public.s2a_personal_finish(lease,200,'completed',NULL,NULL,NULL,NULL,0,1,NULL,'gpt-5.4');
    IF result->>'applied' IS DISTINCT FROM 'true' OR EXISTS(SELECT FROM public.usage_logs WHERE request_id=request::text)
        OR NOT EXISTS(SELECT FROM s2a_private.personal_gateway_leases WHERE id=lease AND finished_at IS NOT NULL AND count_only) THEN RAISE EXCEPTION 'preflight counted as generation or leaked account slot'; END IF;
    request:=gen_random_uuid();
    acquired:=public.s2a_personal_acquire(h,'alias',request,'{}',true,NULL,'{"web_search":true}');
    IF acquired ? 'error' THEN RAISE EXCEPTION 'search admission failed'; END IF;
    lease:=(acquired->>'lease_id')::uuid;
    result:=public.s2a_personal_finish(lease,200,'completed',NULL,NULL,NULL,NULL,0,1,NULL,'gpt-5.4');
    IF NOT EXISTS(SELECT FROM public.usage_logs WHERE request_id=request::text AND input_tokens=0 AND output_tokens=0
        AND actual_cost=0 AND s2a_personal_details->>'operation'='alpha_search' AND s2a_personal_details->>'web_search_calls'='1')
        THEN RAISE EXCEPTION 'successful search missing canonical uncharged usage'; END IF;
    request:=gen_random_uuid();
    acquired:=public.s2a_personal_acquire(h,'alias',request,'{}',true,NULL,'{"web_search":true}');
    IF acquired ? 'error' THEN RAISE EXCEPTION 'failed search admission failed'; END IF;
    result:=public.s2a_personal_finish((acquired->>'lease_id')::uuid,403,'failed',NULL,NULL,NULL,NULL,0,1,NULL,'gpt-5.4');
    IF EXISTS(SELECT FROM public.usage_logs WHERE request_id=request::text) THEN RAISE EXCEPTION 'failed search counted as success'; END IF;
    FOREACH search_kind IN ARRAY ARRAY['web_search','x_search'] LOOP
        request:=gen_random_uuid();
        acquired:=public.s2a_personal_acquire(h,'alias',request,'{}',true,NULL,jsonb_build_object('web_search',true,'search_operation',search_kind));
        IF acquired ? 'error' THEN RAISE EXCEPTION 'standalone search admission failed'; END IF;
        result:=public.s2a_personal_finish((acquired->>'lease_id')::uuid,200,'completed',12,7,NULL,NULL,0,1,NULL,'grok-4.6');
        IF NOT EXISTS(SELECT FROM public.usage_logs WHERE request_id=request::text AND input_tokens=12 AND output_tokens=7 AND actual_cost=0
            AND s2a_personal_details->>'operation'=search_kind AND s2a_personal_details->>'web_search_calls'='1') THEN RAISE EXCEPTION 'standalone search usage mismatch'; END IF;
    END LOOP;
    IF has_function_privilege('anon','public.s2a_personal_cache_resolve(text,text,text,text)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_personal_cache_resolve(text,text,text,text)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_personal_cache_resolve(text,text,text,text)','EXECUTE')
        OR has_table_privilege('anon','public.gemini_cached_contents','SELECT')
        OR has_table_privilege('authenticated','public.gemini_cached_contents','SELECT')
        OR has_table_privilege('service_role','public.gemini_cached_contents','SELECT') THEN RAISE EXCEPTION 'cache binding ACL mismatch'; END IF;
    INSERT INTO public.groups(name,platform) VALUES('Cache ownership fixture','gemini') RETURNING id INTO cache_group;
    UPDATE public.api_keys SET group_id=cache_group WHERE id=k;
    INSERT INTO public.accounts(name,platform,type,credentials,concurrency) VALUES('Bound cache account','gemini','apikey','{"api_key":"fixture-cache-key"}',1) RETURNING id INTO cache_account;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(cache_account,cache_group);
    INSERT INTO public.accounts(name,platform,type,credentials,concurrency,priority) VALUES('Alternative cache account','gemini','apikey','{"api_key":"fixture-other-key"}',1,-10) RETURNING id INTO alternative_cache_account;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(alternative_cache_account,cache_group);
    INSERT INTO public.accounts(name,platform,type,credentials,concurrency,priority) VALUES('Cache-ineligible OAuth fixture','gemini','oauth','{"access_token":"fixture"}',1,-100) RETURNING id INTO oauth_cache_account;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(oauth_cache_account,cache_group);
    result:=public.s2a_personal_acquire(h,'gemini-cache',gen_random_uuid(),'{}',true,NULL,'{"cache_create":true,"count_only":true}');
    IF result ? 'error' OR result->'account'->>'id' IS DISTINCT FROM alternative_cache_account::text THEN RAISE EXCEPTION 'cache creation selected unsupported authentication: %',result; END IF;
    PERFORM public.s2a_personal_finish((result->>'lease_id')::uuid,200,'completed',NULL,NULL,NULL,NULL,0,1,NULL,'gemini-cache');
    INSERT INTO public.gemini_cached_contents(public_id,user_id,api_key_id,group_id,account_id,upstream_name,model,upstream_model,expire_time)
        VALUES('cache-fixture',u,k,cache_group,cache_account,'cachedContents/provider-private','gemini-cache','gemini-upstream',now()+interval '1 hour');
    result:=public.s2a_personal_cache_read(h,'cachedContents/cache-fixture');
    IF result->>'name' IS DISTINCT FROM 'cachedContents/cache-fixture' OR result->>'model' IS DISTINCT FROM 'models/gemini-cache'
        OR result ? 'account_id' OR result ? 'upstream_name' THEN RAISE EXCEPTION 'cache view exposed private data or lost identity: %',result; END IF;
    result:=public.s2a_personal_cache_read(h);
    IF jsonb_array_length(result->'cachedContents')<>1 THEN RAISE EXCEPTION 'cache list omitted owned cache'; END IF;
    IF public.s2a_personal_cache_read(h,'cachedContents/missing')->>'status' IS DISTINCT FROM '403' THEN RAISE EXCEPTION 'missing cache detail not forbidden'; END IF;
    result:=public.s2a_personal_cache_resolve(h,'cachedContents/cache-fixture','gemini-cache');
    IF result->>'account_id' IS DISTINCT FROM cache_account::text OR result->>'upstream_name' IS DISTINCT FROM 'cachedContents/provider-private' THEN RAISE EXCEPTION 'cache binding lookup failed: %',result; END IF;
    IF public.s2a_personal_cache_resolve(h,'cachedContents/cache-fixture','different-model')->>'error' IS DISTINCT FROM 'cached_content_model_mismatch' THEN RAISE EXCEPTION 'cache accepted wrong model'; END IF;
    UPDATE public.gemini_cached_contents SET api_key_id=k+100000 WHERE public_id='cache-fixture';
    IF public.s2a_personal_cache_resolve(h,'cachedContents/cache-fixture','gemini-cache')->>'error' IS DISTINCT FROM 'cached_content_not_found' THEN RAISE EXCEPTION 'foreign cache exposed'; END IF;
    IF public.s2a_personal_cache_read(h)<>'{}'::jsonb THEN RAISE EXCEPTION 'foreign cache listed'; END IF;
    UPDATE public.gemini_cached_contents SET api_key_id=k WHERE public_id='cache-fixture';
    UPDATE public.gemini_cached_contents SET user_id=u+100000 WHERE public_id='cache-fixture';
    IF public.s2a_personal_cache_resolve(h,'cachedContents/cache-fixture','gemini-cache')->>'error' IS DISTINCT FROM 'cached_content_not_found' THEN RAISE EXCEPTION 'foreign user cache exposed'; END IF;
    UPDATE public.gemini_cached_contents SET user_id=u,group_id=cache_group+100000 WHERE public_id='cache-fixture';
    IF public.s2a_personal_cache_resolve(h,'cachedContents/cache-fixture','gemini-cache')->>'error' IS DISTINCT FROM 'cached_content_not_found' THEN RAISE EXCEPTION 'foreign group cache exposed'; END IF;
    UPDATE public.gemini_cached_contents SET group_id=cache_group WHERE public_id='cache-fixture';
    request:=gen_random_uuid();
    acquired:=public.s2a_personal_acquire(h,'gemini-cache',request,'{}',true,NULL,'{"cached_content":"cachedContents/cache-fixture"}');
    IF acquired ? 'error' OR acquired->'account'->>'id' IS DISTINCT FROM cache_account::text THEN RAISE EXCEPTION 'cache account not pinned: %',acquired; END IF;
    result:=public.s2a_personal_finish((acquired->>'lease_id')::uuid,200,'completed',10,2,NULL,8,0,1,NULL,'gemini-upstream');
    IF public.s2a_personal_cache_deleted(h,'cachedContents/cache-fixture',gen_random_uuid())->>'error' IS DISTINCT FROM 'invalid_cache_reservation' THEN RAISE EXCEPTION 'cache deletion accepted missing reservation'; END IF;
    acquired:=public.s2a_personal_acquire(h,'gemini-cache',gen_random_uuid(),'{}',true,NULL,'{"cached_content":"cachedContents/cache-fixture","count_only":true}');
    IF acquired ? 'error' THEN RAISE EXCEPTION 'cache delete admission failed: %',acquired; END IF;
    IF has_table_privilege('service_role','s2a_private.cache_creation_intents','SELECT') OR has_function_privilege('anon','public.s2a_personal_cache_create(text,text,uuid,text,text,text,text,timestamptz,bigint,text)','EXECUTE') THEN RAISE EXCEPTION 'cache creation intent exposed'; END IF;
    IF public.s2a_personal_cache_create(h,repeat('a',40),(acquired->>'lease_id')::uuid,'gemini-upstream','Display','complete','cachedContents/new-private',now()+interval '1 hour',100)->>'error' IS DISTINCT FROM 'cache_creation_conflict' THEN RAISE EXCEPTION 'unprepared cache completed'; END IF;
    IF public.s2a_personal_cache_create(h,repeat('a',40),(acquired->>'lease_id')::uuid,'gemini-upstream','Display','prepare')->>'prepared' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'cache create prepare failed'; END IF;
    IF EXISTS(SELECT 1 FROM public.gemini_cached_contents WHERE public_id=repeat('a',40)) THEN RAISE EXCEPTION 'pending cache exposed'; END IF;
    IF public.s2a_personal_cache_create(h,repeat('a',40),(acquired->>'lease_id')::uuid,'other-model','Display','prepare')->>'error' IS DISTINCT FROM 'cache_creation_conflict' THEN RAISE EXCEPTION 'cache intent mutated'; END IF;
    IF public.s2a_personal_cache_create(h,repeat('a',40),(acquired->>'lease_id')::uuid,'gemini-upstream','Display','complete','cachedContents/new-private',now()+interval '1 hour',100)->>'created' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'cache complete failed'; END IF;
    IF public.s2a_personal_cache_create(h,repeat('a',40),(acquired->>'lease_id')::uuid,'gemini-upstream','Display','complete','cachedContents/new-private',now()+interval '1 hour',100)->>'created' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'cache complete replay failed'; END IF;
    IF public.s2a_personal_cache_create(h,repeat('a',40),(acquired->>'lease_id')::uuid,'gemini-upstream','Display','complete','cachedContents/different',now()+interval '1 hour',100)->>'error' IS DISTINCT FROM 'cache_creation_conflict' THEN RAISE EXCEPTION 'cache conflict replay accepted'; END IF;
    result:=public.s2a_personal_cache_read(h,'cachedContents/'||repeat('a',40));
    IF result->>'displayName' IS DISTINCT FROM 'Display' OR result->>'model' IS DISTINCT FROM 'models/gemini-cache' OR result->'usageMetadata'->>'totalTokenCount' IS DISTINCT FROM '100' THEN RAISE EXCEPTION 'created cache view invalid'; END IF;
    DELETE FROM public.gemini_cached_contents WHERE public_id=repeat('a',40);
    IF has_function_privilege('anon','public.s2a_personal_cache_mutation(text,text,uuid,text,timestamptz,text)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_personal_cache_mutation(text,text,uuid,text,timestamptz,text)','EXECUTE') THEN RAISE EXCEPTION 'cache mutation public privileges'; END IF;
    UPDATE public.gemini_cached_contents SET mutation_lease=gen_random_uuid(),mutation_until=now()+interval '1 hour' WHERE public_id='cache-fixture';
    IF public.s2a_personal_cache_mutation(h,'cachedContents/cache-fixture',(acquired->>'lease_id')::uuid,'claim')->>'error' IS DISTINCT FROM 'cache_mutation_in_progress' THEN RAISE EXCEPTION 'concurrent cache mutation admitted'; END IF;
    UPDATE public.gemini_cached_contents SET mutation_until=now()-interval '1 second' WHERE public_id='cache-fixture';
    IF public.s2a_personal_cache_mutation(h,'cachedContents/cache-fixture',(acquired->>'lease_id')::uuid,'claim')->>'recover' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'cache mutation recovery not requested'; END IF;
    IF public.s2a_personal_cache_mutation(h,'cachedContents/cache-fixture',(acquired->>'lease_id')::uuid,'apply',now()+interval '2 hours')->>'updated' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'cache expiry mutation failed'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.gemini_cached_contents WHERE public_id='cache-fixture' AND expire_time>now()+interval '110 minutes' AND upstream_name='cachedContents/provider-private') THEN RAISE EXCEPTION 'cache expiry or immutable binding changed incorrectly'; END IF;
    PERFORM public.s2a_personal_cache_mutation(h,'cachedContents/cache-fixture',(acquired->>'lease_id')::uuid,'release');
    PERFORM public.s2a_personal_cache_mutation(h,'cachedContents/cache-fixture',(acquired->>'lease_id')::uuid,'claim');
    IF public.s2a_personal_cache_deleted(h,'cachedContents/cache-fixture',(acquired->>'lease_id')::uuid)->>'deleted' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'cache deletion failed'; END IF;
    IF public.s2a_personal_cache_read(h)<>'{}'::jsonb THEN RAISE EXCEPTION 'deleted cache listed'; END IF;
    PERFORM public.s2a_personal_finish((acquired->>'lease_id')::uuid,200,'completed',NULL,NULL,NULL,NULL,0,1,NULL,'gemini-upstream');
    IF public.s2a_personal_cache_deleted(h,'cachedContents/cache-fixture',(acquired->>'lease_id')::uuid)->>'error' IS DISTINCT FROM 'invalid_cache_reservation' THEN RAISE EXCEPTION 'finished reservation deleted cache'; END IF;
    UPDATE public.gemini_cached_contents SET deleted_at=NULL WHERE public_id='cache-fixture';
    UPDATE public.accounts SET status='inactive' WHERE id=cache_account;
    IF public.s2a_personal_acquire(h,'gemini-cache',gen_random_uuid(),'{}',true,NULL,'{"cached_content":"cachedContents/cache-fixture"}')->>'error' IS DISTINCT FROM 'no_available_account' THEN RAISE EXCEPTION 'unavailable cache fell back'; END IF;
    UPDATE public.gemini_cached_contents SET expire_time=now()-interval '1 second' WHERE public_id='cache-fixture';
    IF public.s2a_personal_cache_resolve(h,'cachedContents/cache-fixture','gemini-cache')->>'error' IS DISTINCT FROM 'cached_content_not_found' THEN RAISE EXCEPTION 'expired cache accepted'; END IF;
    UPDATE public.gemini_cached_contents SET expire_time=now()+interval '1 hour',deleted_at=now() WHERE public_id='cache-fixture';
    IF public.s2a_personal_cache_resolve(h,'cachedContents/cache-fixture','gemini-cache')->>'error' IS DISTINCT FROM 'cached_content_not_found' THEN RAISE EXCEPTION 'deleted cache accepted'; END IF;
    UPDATE public.api_keys SET group_id=g WHERE id=k;
    UPDATE public.api_keys SET ip_whitelist='["192.0.2.0/24"]' WHERE id=k;
    IF public.s2a_personal_key_billing(h)->>'error' IS DISTINCT FROM 'ip_forbidden' THEN RAISE EXCEPTION 'billing ignored IP allowlist'; END IF;
    IF public.s2a_personal_key_policy(h)->>'error' IS DISTINCT FROM 'ip_forbidden' OR public.s2a_personal_key_policy(h,'192.0.2.5') ? 'error' THEN RAISE EXCEPTION 'discovery ignored IP allowlist'; END IF;
    UPDATE public.api_keys SET ip_whitelist='[]',ip_blacklist='["192.0.2.0/24"]' WHERE id=k;
    IF public.s2a_personal_key_policy(h)->>'error' IS DISTINCT FROM 'client_ip_required' OR public.s2a_personal_key_policy(h,'192.0.2.5')->>'error' IS DISTINCT FROM 'ip_forbidden' THEN RAISE EXCEPTION 'discovery ignored IP denylist'; END IF;
    UPDATE public.api_keys SET status='inactive' WHERE id=k;
    IF public.s2a_personal_key_policy(h)->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'discovery accepted revoked key'; END IF;
    IF public.s2a_personal_acquire(h,'alias',gen_random_uuid())->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'revoked key accepted'; END IF;
END $$;
ROLLBACK;
