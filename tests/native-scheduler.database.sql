BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE u bigint:=current_setting('s2a.acceptance.user_id')::bigint;
    k bigint:=current_setting('s2a.acceptance.key_id')::bigint;
    g bigint:=current_setting('s2a.acceptance.group_id')::bigint;
    a bigint; b bigint; c bigint; request uuid:=gen_random_uuid(); second_request uuid:=gen_random_uuid(); result jsonb; queued jsonb;
BEGIN
    IF has_function_privilege('anon','public.s2a_gateway_candidates(uuid,bigint,integer,bigint[])','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_gateway_candidates(uuid,bigint,integer,bigint[])','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_gateway_candidates(uuid,bigint,integer,bigint[])','EXECUTE') THEN RAISE EXCEPTION 'candidate ACL mismatch'; END IF;
    IF has_function_privilege('anon','public.s2a_gateway_scheduler_settings()','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_gateway_scheduler_settings()','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_gateway_scheduler_settings()','EXECUTE') THEN RAISE EXCEPTION 'scheduler settings ACL mismatch'; END IF;
    INSERT INTO public.settings(key,value) VALUES('openai_advanced_scheduler_weight_load',' 2.5 '),
        ('openai_advanced_scheduler_unknown','synthetic-private-setting'),('smtp_password','synthetic-private-password')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    result:=public.s2a_gateway_scheduler_settings();
    IF result->>'openai_advanced_scheduler_weight_load' IS DISTINCT FROM ' 2.5 '
        OR result ? 'smtp_password' OR result ? 'openai_advanced_scheduler_unknown'
        OR result::text LIKE '%synthetic-private%' THEN RAISE EXCEPTION 'scheduler settings projection mismatch'; END IF;
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,k,u,g,repeat('b',64),'{"model":"public-alias","pricing_at":"2026-10-15T07:00:00Z"}',clock_timestamp()+interval '3 minutes');
    INSERT INTO public.accounts(name,platform,type,credentials,concurrency,priority,extra)
    VALUES('Candidate A','openai','apikey','{"api_key":"synthetic-never-return-token","model_mapping":{"public-alias":"gpt-5.4"},"oauth_type":"google_one","project_id":"synthetic-project","plan_type":"plus","custom_secret":"synthetic-never-return-secret"}',2,9,'{"openai_passthrough":true,"openai_compact_mode":"auto","openai_compact_supported":true,"private_extra":"synthetic-never-return-extra","codex_7d_used_percent":42,"codex_usage_updated_at":"2026-10-15T07:00:00Z","upstream_billing_probe":{"status":"ok","received_at":"2026-10-15T06:00:00Z","fresh_until":"2026-10-15T08:00:00Z","last_error":"synthetic-never-return-probe-error","data":{"billing_scope":"token","resolved_rate_multiplier":0.5,"peak_rate_enabled":false,"api_key":"synthetic-never-return-nested-token"}}}') RETURNING id INTO a;
    INSERT INTO public.accounts(name,platform,type,credentials,concurrency,priority)
    VALUES('Candidate B','openai','apikey','{"api_key":"synthetic-never-return-token-b"}',2,0) RETURNING id INTO b;
    INSERT INTO public.accounts(id,name,platform,type,credentials,concurrency,priority)
    VALUES(9007199254740993,'Candidate C','openai','apikey','{"api_key":"synthetic-never-return-token-c"}',2,0) RETURNING id INTO c;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g),(b,g);
    INSERT INTO s2a_private.gateway_account_stats(account_id,error_rate,ttft_ms,samples,updated_at) VALUES(a,0.2,123,4,clock_timestamp());
    IF has_table_privilege('service_role','s2a_private.gateway_account_waiters','SELECT')
        OR has_function_privilege('anon','public.s2a_gateway_account_wait(uuid,bigint,integer,integer)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_gateway_account_wait(uuid,bigint,integer,integer)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_gateway_account_wait(uuid,bigint,integer,integer)','EXECUTE') THEN RAISE EXCEPTION 'waiter ACL mismatch'; END IF;
    queued:=public.s2a_gateway_account_wait(request,a,1,30000);
    IF queued->>'account_id' IS DISTINCT FROM a::text OR queued ? 'error' THEN RAISE EXCEPTION 'wait enqueue failed: %',queued; END IF;
    IF public.s2a_gateway_account_wait(request,a,1,45000) IS DISTINCT FROM queued THEN RAISE EXCEPTION 'wait replay extended timeout'; END IF;
    IF public.s2a_gateway_account_wait(request,b,1,30000)->>'error' IS DISTINCT FROM 'wait_plan_conflict' THEN RAISE EXCEPTION 'wait replay changed account'; END IF;
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
        SELECT second_request,api_key_id,user_id,group_id,repeat('c',64),policy,expires_at FROM s2a_private.gateway_requests WHERE request_id=request;
    IF public.s2a_gateway_account_wait(second_request,a,1,30000)->>'error' IS DISTINCT FROM 'account_wait_queue_full' THEN RAISE EXCEPTION 'queue capacity ignored'; END IF;
    result:=public.s2a_gateway_candidates(second_request,a-1,1);
    IF result->'candidates'->0->>'waiting_count' IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'shared waiter count missing'; END IF;
    UPDATE s2a_private.gateway_account_waiters SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=request;
    IF public.s2a_gateway_account_wait(request,a,1,30000)->>'error' IS DISTINCT FROM 'account_wait_timeout' THEN RAISE EXCEPTION 'expired waiter restarted'; END IF;
    IF public.s2a_gateway_account_wait(second_request,a,1,30000)->>'account_id' IS DISTINCT FROM a::text THEN RAISE EXCEPTION 'expired waiter blocked queue'; END IF;
    PERFORM public.s2a_gateway_key_release(second_request);
    result:=public.s2a_gateway_candidates(request,a-1,1);
    IF result->'candidates'->0->>'waiting_count' IS DISTINCT FROM '0' THEN RAISE EXCEPTION 'released waiter counted'; END IF;
    result:=public.s2a_gateway_candidates(request,a-1,1);
    IF (result->>'scheduling_at')::timestamptz IS DISTINCT FROM statement_timestamp()
        OR result->'candidates'->0->>'id' IS DISTINCT FROM a::text
        OR result->>'next_after' IS DISTINCT FROM a::text
        OR result->'candidates'->0->'credentials'->'model_mapping'->>'public-alias' IS DISTINCT FROM 'gpt-5.4'
        OR result->'candidates'->0->'credentials'->>'plan_type' IS DISTINCT FROM 'plus'
        OR result->'candidates'->0->>'rate_multiplier' IS DISTINCT FROM '1.0000'
        OR result->'candidates'->0->'extra'->'upstream_billing_probe'->'data'->'resolved_rate_multiplier' IS DISTINCT FROM '0.5'::jsonb
        OR result->'candidates'->0->'runtime_stats' IS DISTINCT FROM '{"error_rate":0.2,"ttft_ms":123,"has_ttft":true,"samples":"4"}'::jsonb
        OR result->'candidates'->0->'extra'->'openai_passthrough' IS DISTINCT FROM 'true'::jsonb
        OR result->'candidates'->0->'extra'->'openai_compact_supported' IS DISTINCT FROM 'true'::jsonb
        OR result->'candidates'->0->'extra'->'codex_7d_used_percent' IS DISTINCT FROM '42'::jsonb
        OR result->'request_policy' IS DISTINCT FROM (SELECT policy FROM s2a_private.gateway_requests WHERE request_id=request)
        OR result::text LIKE '%synthetic-never-return%' THEN RAISE EXCEPTION 'candidate projection mismatch'; END IF;
    result:=public.s2a_gateway_candidates(request,a,1);
    IF result->'candidates'->0->>'id' IS DISTINCT FROM b::text THEN RAISE EXCEPTION 'candidate page skipped account'; END IF;
    IF result->'candidates'->0->'runtime_stats' IS DISTINCT FROM '{"error_rate":0,"ttft_ms":0,"has_ttft":false,"samples":"0"}'::jsonb THEN RAISE EXCEPTION 'unknown candidate health mismatch'; END IF;
    result:=public.s2a_gateway_candidates(request,b,1);
    IF result->'candidates' IS DISTINCT FROM '[]'::jsonb OR result->'next_after' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'candidate leaked unrelated group'; END IF;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(c,g);
    IF public.s2a_gateway_candidates(request,b,1)->'candidates'->0->>'id' IS DISTINCT FROM '9007199254740993' THEN RAISE EXCEPTION 'candidate bigint identifier changed'; END IF;
    DELETE FROM public.account_groups WHERE account_id=c AND group_id=g;
    result:=public.s2a_gateway_candidates(request,a-1,2,ARRAY[a]);
    IF jsonb_array_length(result->'candidates')<>1 OR result->'candidates'->0->>'id' IS DISTINCT FROM b::text THEN RAISE EXCEPTION 'candidate exclusion mismatch'; END IF;
    UPDATE s2a_private.accounts SET schedulable=false WHERE id=b;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'paused candidate accepted'; END IF;
    UPDATE s2a_private.accounts SET schedulable=true WHERE id=b;
    UPDATE s2a_private.accounts SET expires_at=clock_timestamp()-interval '1 minute',auto_pause_on_expired=true WHERE id=b;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'expired candidate accepted'; END IF;
    UPDATE s2a_private.accounts SET auto_pause_on_expired=false WHERE id=b;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates'->0->>'id' IS DISTINCT FROM b::text THEN RAISE EXCEPTION 'manual expiry override ignored'; END IF;
    UPDATE s2a_private.accounts SET overload_until=clock_timestamp()+interval '1 minute' WHERE id=b;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'overloaded candidate accepted'; END IF;
    UPDATE s2a_private.accounts SET overload_until=NULL,rate_limit_reset_at=clock_timestamp()+interval '1 minute' WHERE id=b;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'rate limited candidate accepted'; END IF;
    UPDATE s2a_private.accounts SET rate_limit_reset_at=NULL,temp_unschedulable_until=clock_timestamp()+interval '1 minute' WHERE id=b;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'cooling candidate accepted'; END IF;
    UPDATE s2a_private.accounts SET temp_unschedulable_until=NULL,extra='{"quota_limit":1,"quota_used":1}' WHERE id=b;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'exhausted candidate accepted'; END IF;
    UPDATE s2a_private.accounts SET extra='{}' WHERE id=b;
    UPDATE public.groups SET require_oauth_only=true WHERE id=g;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'OAuth-only candidate policy ignored'; END IF;
    UPDATE public.groups SET require_oauth_only=false,require_privacy_set=true WHERE id=g;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates' IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'candidate privacy policy ignored'; END IF;
    UPDATE s2a_private.accounts SET extra='{"privacy_mode":"training_off"}' WHERE id=b;
    IF public.s2a_gateway_candidates(request,a,1)->'candidates'->0->>'id' IS DISTINCT FROM b::text THEN RAISE EXCEPTION 'private candidate excluded'; END IF;
    UPDATE public.groups SET require_privacy_set=false WHERE id=g;
    INSERT INTO s2a_private.gateway_account_leases(request_id,account_id,credential_version,policy,expires_at)
    VALUES(request,a,1,'{}',clock_timestamp()+interval '1 minute');
    IF public.s2a_gateway_candidates(request,a-1,1)->'candidates'->0->'active_slots' IS DISTINCT FROM '1'::jsonb THEN RAISE EXCEPTION 'candidate load mismatch'; END IF;
    IF public.s2a_gateway_candidates(request,0,257)->>'error' IS DISTINCT FROM 'invalid_candidate_query'
        OR public.s2a_gateway_candidates(request,0,1,ARRAY[NULL::bigint])->>'error' IS DISTINCT FROM 'invalid_candidate_query' THEN RAISE EXCEPTION 'unbounded candidate query accepted'; END IF;
    DELETE FROM public.user_allowed_groups WHERE user_id=u AND group_id=g;
    UPDATE public.groups SET is_exclusive=true WHERE id=g;
    IF public.s2a_gateway_candidates(request)->>'error' IS DISTINCT FROM 'group_forbidden' THEN RAISE EXCEPTION 'revoked group access listed accounts'; END IF;
    UPDATE public.groups SET is_exclusive=false WHERE id=g;
    UPDATE public.api_keys SET status='disabled' WHERE id=k;
    IF public.s2a_gateway_candidates(request)->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'revoked key listed accounts'; END IF;
    UPDATE public.api_keys SET status='active' WHERE id=k;
    UPDATE s2a_private.gateway_requests SET finished_at=clock_timestamp() WHERE request_id=request;
    IF public.s2a_gateway_candidates(request)->>'error' IS DISTINCT FROM 'request_lease_expired' THEN RAISE EXCEPTION 'finished request listed accounts'; END IF;
END $$;
ROLLBACK;
