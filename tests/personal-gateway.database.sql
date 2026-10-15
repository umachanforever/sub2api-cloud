BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE u bigint:=nullif(current_setting('s2a.acceptance.user_id',true),'')::bigint;
    k bigint:=nullif(current_setting('s2a.acceptance.key_id',true),'')::bigint;
    g bigint; a bigint; h text; request uuid:=gen_random_uuid(); acquired jsonb; result jsonb; lease uuid;
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
    UPDATE public.api_keys SET ip_whitelist='["192.0.2.0/24"]' WHERE id=k;
    IF public.s2a_personal_key_policy(h)->>'error' IS DISTINCT FROM 'ip_forbidden' OR public.s2a_personal_key_policy(h,'192.0.2.5') ? 'error' THEN RAISE EXCEPTION 'discovery ignored IP allowlist'; END IF;
    UPDATE public.api_keys SET ip_whitelist='[]',ip_blacklist='["192.0.2.0/24"]' WHERE id=k;
    IF public.s2a_personal_key_policy(h)->>'error' IS DISTINCT FROM 'client_ip_required' OR public.s2a_personal_key_policy(h,'192.0.2.5')->>'error' IS DISTINCT FROM 'ip_forbidden' THEN RAISE EXCEPTION 'discovery ignored IP denylist'; END IF;
    UPDATE public.api_keys SET status='inactive' WHERE id=k;
    IF public.s2a_personal_key_policy(h)->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'discovery accepted revoked key'; END IF;
    IF public.s2a_personal_acquire(h,'alias',gen_random_uuid())->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'revoked key accepted'; END IF;
END $$;
ROLLBACK;
