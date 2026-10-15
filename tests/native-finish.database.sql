BEGIN;
SET LOCAL ROLE s2a_management;
CREATE FUNCTION pg_temp.finish_fixture(p_user bigint,p_key bigint,p_group bigint,p_account bigint,p_model text DEFAULT 'gpt-test',p_subscription bigint DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE request uuid := gen_random_uuid(); result jsonb;
BEGIN
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,p_key,p_user,p_group,repeat('b',64),jsonb_build_object('model',p_model,'subscription_type',CASE WHEN p_subscription IS NULL THEN 'standard' ELSE 'subscription' END,'subscription_id',p_subscription::text,'rate_multiplier','1.25','quota','100','rate_limit_5h','100','platform','openai','timezone','Asia/Shanghai'),clock_timestamp()+interval '3 minutes');
    result := public.s2a_gateway_account_reserve(request,p_account,(SELECT s2a_credential_version FROM s2a_private.accounts WHERE id=p_account));
    IF result ? 'error' THEN RAISE EXCEPTION 'finish fixture reservation failed: %',result->>'error'; END IF;
    RETURN (result->>'lease_id')::uuid;
END $$;
DO $$
DECLARE u bigint := current_setting('s2a.acceptance.user_id')::bigint;
    k bigint := current_setting('s2a.acceptance.key_id')::bigint;
    g bigint := current_setting('s2a.acceptance.group_id')::bigint;
    a bigint; v bigint; lease uuid; retry_lease uuid; request uuid; result jsonb; usage_id bigint; sub_id bigint;
    measured jsonb := '{"input":10,"output":5,"cacheCreation":0,"cacheRead":0,"firstTokenMs":12,"durationMs":100,"stream":true}';
    unknown_usage jsonb := '{"input":null,"output":null,"cacheCreation":null,"cacheRead":null}';
    costs jsonb := '{"input":"0.0000125","output":"0.00005","cacheCreation":0,"cacheRead":0}';
    balance_before numeric; quota_before numeric; peak_timezone text; samples_before bigint;
BEGIN
    IF has_function_privilege('anon','public.s2a_gateway_finish(uuid,integer,text,jsonb,jsonb,boolean,integer,bigint)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_gateway_finish(uuid,integer,text,jsonb,jsonb,boolean,integer,bigint)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_gateway_finish(uuid,integer,text,jsonb,jsonb,boolean,integer,bigint)','EXECUTE') THEN RAISE EXCEPTION 'finish ACL mismatch'; END IF;
    IF has_table_privilege('anon','s2a_private.gateway_account_stats','SELECT')
        OR has_table_privilege('authenticated','s2a_private.gateway_account_stats','SELECT')
        OR has_table_privilege('service_role','s2a_private.gateway_account_stats','SELECT') THEN RAISE EXCEPTION 'scheduler statistics exposed'; END IF;
    UPDATE public.users SET balance=10 WHERE id=u;
    UPDATE public.api_keys SET quota=100,quota_used=0,rate_limit_5h=100,usage_5h=0 WHERE id=k;
    INSERT INTO public.accounts(name,platform,type,credentials,concurrency,rate_multiplier,extra)
    VALUES('Finish fixture','openai','apikey','{"api_key":"synthetic-finish-key"}',100,0.5,'{"quota_limit":100,"quota_used":0}') RETURNING id,s2a_credential_version INTO a,v;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g);
    lease := pg_temp.finish_fixture(u,k,g,a);
    SELECT request_id INTO request FROM s2a_private.gateway_account_leases WHERE lease_id=lease;
    result := public.s2a_gateway_finish(lease,200,'completed',measured,costs);
    usage_id := (result->>'usage_log_id')::bigint;
    IF result->>'applied'<>'true' OR (result->>'actual_cost')::numeric<>0.00007813 OR (result->>'account_cost')::numeric<>0.00003125 OR usage_id IS NULL THEN RAISE EXCEPTION 'finish charge mismatch: %',result; END IF;
    IF (SELECT balance FROM public.users WHERE id=u)<>10-0.00007813 OR (SELECT quota_used FROM public.api_keys WHERE id=k)<>0.00007813 THEN RAISE EXCEPTION 'finish balance/quota mismatch'; END IF;
    IF (SELECT (extra->>'quota_used')::numeric FROM s2a_private.accounts WHERE id=a)<>0.00003125 THEN RAISE EXCEPTION 'finish account charge mismatch'; END IF;
    IF NOT EXISTS(SELECT FROM public.usage_logs WHERE id=usage_id AND input_tokens=10 AND output_tokens=5 AND first_token_ms=12 AND duration_ms=100 AND stream AND request_type=2
        AND total_cost=0.0000625 AND actual_cost=0.00007813 AND account_rate_multiplier=0.5 AND account_stats_cost=0.00003125 AND request_id=request::text) THEN RAISE EXCEPTION 'native usage log mismatch'; END IF;
    IF NOT EXISTS(SELECT FROM public.billing_usage_entries WHERE usage_log_id=usage_id AND delta_usd=0.00007813) THEN RAISE EXCEPTION 'billing reconciliation entry missing'; END IF;
    IF (SELECT finished_at FROM s2a_private.gateway_requests WHERE request_id=request) IS NULL OR (SELECT released_at FROM s2a_private.gateway_account_leases WHERE lease_id=lease) IS NULL THEN RAISE EXCEPTION 'finish did not release request/account slots'; END IF;
    IF NOT EXISTS(SELECT FROM s2a_private.gateway_account_stats WHERE account_id=a AND error_rate=0 AND ttft_ms=12 AND samples=1) THEN RAISE EXCEPTION 'initial scheduler statistics mismatch'; END IF;
    IF public.s2a_gateway_finish(lease,200,'completed',measured,costs)->>'applied'<>'false' THEN RAISE EXCEPTION 'finish replay billed twice'; END IF;
    IF public.s2a_gateway_finish(lease,200,'completed',measured,costs||'{"output":"0.00005000"}')->>'applied'<>'false' THEN RAISE EXCEPTION 'equivalent price replay conflict'; END IF;
    IF public.s2a_gateway_finish(lease,200,'completed',measured||'{"input":11}',costs)->>'error'<>'completion_conflict' THEN RAISE EXCEPTION 'changed completion accepted'; END IF;
    IF (SELECT samples FROM s2a_private.gateway_account_stats WHERE account_id=a)<>1 THEN RAISE EXCEPTION 'replay updated scheduler statistics'; END IF;
    lease := pg_temp.finish_fixture(u,k,g,a);
    SELECT request_id INTO request FROM s2a_private.gateway_account_leases WHERE lease_id=lease;
    IF public.s2a_gateway_finish(lease,200,'completed',measured)->>'error'<>'pricing_required' THEN RAISE EXCEPTION 'missing prices treated as free'; END IF;
    IF (SELECT released_at FROM s2a_private.gateway_account_leases WHERE lease_id=lease) IS NOT NULL OR EXISTS(SELECT FROM public.usage_billing_dedup WHERE request_id=request::text) THEN RAISE EXCEPTION 'unpriced completion mutated billing'; END IF;
    IF public.s2a_gateway_finish(lease,200,'completed',measured,'{}')->>'error'<>'invalid_costs' THEN RAISE EXCEPTION 'empty price document accepted'; END IF;
    IF public.s2a_gateway_finish(lease,200,'completed',measured,costs||'{"input":"NaN"}')->>'error'<>'invalid_costs' THEN RAISE EXCEPTION 'NaN price accepted'; END IF;
    IF public.s2a_gateway_finish(lease,200,'completed',measured||'{"input":-1}',costs)->>'error'<>'invalid_usage' THEN RAISE EXCEPTION 'negative usage accepted'; END IF;
    IF public.s2a_gateway_finish(lease,500,'completed',measured,costs)->>'error'<>'invalid_completion' THEN RAISE EXCEPTION 'invalid success status accepted'; END IF;
    PERFORM public.s2a_gateway_finish(lease,200,'completed',unknown_usage,'{"input":0,"output":0,"cacheCreation":0,"cacheRead":0}');
    IF NOT EXISTS(SELECT FROM public.usage_logs WHERE request_id=request::text AND s2a_gateway_details->'usage'->'input'='null'::jsonb) THEN RAISE EXCEPTION 'unknown usage lost'; END IF;
    lease := pg_temp.finish_fixture(u,k,g,a);
    SELECT request_id INTO request FROM s2a_private.gateway_account_leases WHERE lease_id=lease;
    result := public.s2a_gateway_finish(lease,429,'failed',unknown_usage,NULL,false,60,v);
    IF result->>'applied'<>'true' OR (SELECT finished_at FROM s2a_private.gateway_requests WHERE request_id=request) IS NOT NULL
        OR EXISTS(SELECT FROM public.usage_billing_dedup WHERE request_id=request::text) OR EXISTS(SELECT FROM public.usage_logs WHERE request_id=request::text) THEN RAISE EXCEPTION 'retry consumed final billing identity'; END IF;
    IF (SELECT rate_limit_reset_at FROM s2a_private.accounts WHERE id=a) <= clock_timestamp() THEN RAISE EXCEPTION '429 cooldown missing'; END IF;
    IF public.s2a_gateway_finish(lease,429,'failed',unknown_usage,NULL,false,60,v)->>'applied'<>'false' THEN RAISE EXCEPTION 'retry completion replay failed'; END IF;
    IF NOT EXISTS(SELECT FROM s2a_private.gateway_account_stats WHERE account_id=a AND abs(error_rate-0.2)<1e-12 AND ttft_ms=12 AND samples=3) THEN RAISE EXCEPTION 'retry EWMA or replay mismatch'; END IF;
    UPDATE s2a_private.accounts SET rate_limit_reset_at=NULL WHERE id=a;
    result := public.s2a_gateway_account_reserve(request,a,v);
    retry_lease := (result->>'lease_id')::uuid;
    IF retry_lease IS NULL OR retry_lease=lease THEN RAISE EXCEPTION 'retry slot could not be reserved'; END IF;
    PERFORM public.s2a_gateway_finish(retry_lease,200,'completed',measured||'{"firstTokenMs":32}',costs);
    IF NOT EXISTS(SELECT FROM s2a_private.gateway_account_stats WHERE account_id=a AND abs(error_rate-0.16)<1e-12 AND abs(ttft_ms-16)<1e-12 AND samples=4) THEN RAISE EXCEPTION 'scheduler recovery EWMA mismatch'; END IF;
    IF (SELECT count(*) FROM public.usage_logs WHERE request_id=request::text)<>1 THEN RAISE EXCEPTION 'retry wrote duplicate usage'; END IF;
    lease := pg_temp.finish_fixture(u,k,g,a);
    UPDATE public.accounts SET credentials='{"api_key":"new-synthetic-finish-key"}' WHERE id=a;
    PERFORM public.s2a_gateway_finish(lease,401,'failed',unknown_usage,NULL,true,60,v);
    IF (SELECT temp_unschedulable_until FROM s2a_private.accounts WHERE id=a) IS NOT NULL THEN RAISE EXCEPTION 'stale failure cooled reauthorized credentials'; END IF;
    SELECT samples INTO samples_before FROM s2a_private.gateway_account_stats WHERE account_id=a;
    lease := pg_temp.finish_fixture(u,k,g,a,'__models__');
    SELECT request_id INTO request FROM s2a_private.gateway_account_leases WHERE lease_id=lease;
    PERFORM public.s2a_gateway_finish(lease,200,'completed',unknown_usage);
    IF EXISTS(SELECT FROM public.usage_logs WHERE request_id=request::text) THEN RAISE EXCEPTION 'metadata request created billable usage'; END IF;
    IF (SELECT samples FROM s2a_private.gateway_account_stats WHERE account_id=a)<>samples_before THEN RAISE EXCEPTION 'model listing changed scheduler health'; END IF;
    lease := pg_temp.finish_fixture(u,k,g,a);
    SELECT request_id INTO request FROM s2a_private.gateway_account_leases WHERE lease_id=lease;
    SELECT balance INTO balance_before FROM public.users WHERE id=u;
    SELECT (extra->>'quota_used')::numeric INTO quota_before FROM s2a_private.accounts WHERE id=a;
    SELECT samples INTO samples_before FROM s2a_private.gateway_account_stats WHERE account_id=a;
    UPDATE s2a_private.accounts SET deleted_at=clock_timestamp() WHERE id=a;
    BEGIN
        PERFORM public.s2a_gateway_finish(lease,200,'completed',measured,costs);
        RAISE EXCEPTION 'deleted account charge accepted';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'billing_account_not_found' THEN RAISE; END IF; END;
    IF (SELECT balance FROM public.users WHERE id=u)<>balance_before OR EXISTS(SELECT FROM public.usage_billing_dedup WHERE request_id=request::text)
        OR (SELECT finish_fingerprint FROM s2a_private.gateway_account_leases WHERE lease_id=lease) IS NOT NULL THEN RAISE EXCEPTION 'failed account charge did not roll back user debit'; END IF;
    UPDATE s2a_private.accounts SET deleted_at=NULL WHERE id=a;
    EXECUTE 'CREATE FUNCTION pg_temp.fail_native_usage() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION ''synthetic_usage_write_failure''; END $body$';
    EXECUTE 'CREATE TRIGGER fail_native_usage BEFORE INSERT ON public.usage_logs FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_native_usage()';
    BEGIN
        PERFORM public.s2a_gateway_finish(lease,200,'completed',measured,costs);
        RAISE EXCEPTION 'usage write fixture did not fail';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'synthetic_usage_write_failure' THEN RAISE; END IF; END;
    IF (SELECT balance FROM public.users WHERE id=u)<>balance_before OR (SELECT (extra->>'quota_used')::numeric FROM s2a_private.accounts WHERE id=a)<>quota_before
        OR EXISTS(SELECT FROM public.usage_billing_dedup WHERE request_id=request::text) OR EXISTS(SELECT FROM public.usage_logs WHERE request_id=request::text)
        OR (SELECT account_cost FROM s2a_private.gateway_account_leases WHERE lease_id=lease) IS NOT NULL THEN RAISE EXCEPTION 'usage write failure did not roll back full settlement'; END IF;
    IF (SELECT samples FROM s2a_private.gateway_account_stats WHERE account_id=a)<>samples_before THEN RAISE EXCEPTION 'failed settlement updated scheduler statistics'; END IF;
    DROP TRIGGER fail_native_usage ON public.usage_logs;
    EXECUTE 'CREATE FUNCTION pg_temp.fail_native_finish() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION ''synthetic_finish_failure''; END $body$';
    EXECUTE 'CREATE TRIGGER fail_native_finish BEFORE UPDATE OF finished_at ON s2a_private.gateway_requests FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_native_finish()';
    BEGIN
        PERFORM public.s2a_gateway_finish(lease,200,'completed',measured,costs);
        RAISE EXCEPTION 'finish rollback fixture did not fail';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'synthetic_finish_failure' THEN RAISE; END IF; END;
    IF (SELECT samples FROM s2a_private.gateway_account_stats WHERE account_id=a)<>samples_before
        OR (SELECT balance FROM public.users WHERE id=u)<>balance_before
        OR (SELECT finish_fingerprint FROM s2a_private.gateway_account_leases WHERE lease_id=lease) IS NOT NULL THEN RAISE EXCEPTION 'finish failure did not roll back scheduler health'; END IF;
    DROP TRIGGER fail_native_finish ON s2a_private.gateway_requests;
    PERFORM public.s2a_gateway_finish(lease,200,'completed',measured,costs);
    lease := pg_temp.finish_fixture(u,k,g,a);
    SELECT request_id INTO request FROM s2a_private.gateway_account_leases WHERE lease_id=lease;
    PERFORM public.s2a_gateway_finish(lease,200,'incomplete',measured,costs);
    IF NOT EXISTS(SELECT FROM public.usage_logs WHERE request_id=request::text AND actual_cost=0.00007813 AND s2a_gateway_details->>'outcome'='incomplete') THEN RAISE EXCEPTION 'known partial usage was discarded'; END IF;
    SELECT balance INTO balance_before FROM public.users WHERE id=u;
    UPDATE public.user_subscriptions SET deleted_at=now() WHERE user_id=u AND group_id=g AND deleted_at IS NULL;
    UPDATE public.groups SET subscription_type='subscription',rate_multiplier=2,peak_rate_enabled=true,peak_start='0:00',peak_end='23:59',peak_rate_multiplier=3 WHERE id=g;
    INSERT INTO public.user_subscriptions(user_id,group_id,starts_at,expires_at,status,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,created_at,updated_at,assigned_at)
    VALUES(u,g,now()-interval '1 day',now()+interval '1 day','active',0,0,0,now(),now(),now()) RETURNING id INTO sub_id;
    UPDATE public.users SET concurrency=0,rpm_limit=0 WHERE id=u;
    UPDATE public.api_keys SET status='active',quota=0,rate_limit_5h=0,rate_limit_1d=0,rate_limit_7d=0,ip_whitelist='[]',ip_blacklist='[]' WHERE id=k;
    UPDATE public.user_group_rate_multipliers SET rate_multiplier=1.25,rpm_override=0 WHERE user_id=u AND group_id=g;
    UPDATE public.groups SET rpm_limit=0,model_allowlist='{}' WHERE id=g;
    peak_timezone := CASE WHEN to_char(clock_timestamp() AT TIME ZONE 'UTC','HH24:MI')='23:59' THEN 'Pacific/Honolulu' ELSE 'UTC' END;
    request := gen_random_uuid();
    result := public.s2a_gateway_key_admit((SELECT s2a_key_hash FROM public.api_keys WHERE id=k),request,'gpt-test',NULL,peak_timezone);
    IF result ? 'error' OR (result->>'token_rate_multiplier')::numeric<>3.75 OR (result->>'rate_multiplier')::numeric<>1.25 THEN RAISE EXCEPTION 'peak admission snapshot mismatch: %',result; END IF;
    result := public.s2a_gateway_account_reserve(request,a,(SELECT s2a_credential_version FROM s2a_private.accounts WHERE id=a));
    IF result ? 'error' THEN RAISE EXCEPTION 'peak account reservation failed: %',result; END IF;
    lease := (result->>'lease_id')::uuid;
    UPDATE public.groups SET peak_rate_multiplier=7,rate_multiplier=5 WHERE id=g;
    UPDATE public.user_group_rate_multipliers SET rate_multiplier=4 WHERE user_id=u AND group_id=g;
    result := public.s2a_gateway_finish(lease,200,'completed',measured,costs);
    usage_id := (result->>'usage_log_id')::bigint;
    IF (SELECT balance FROM public.users WHERE id=u)<>balance_before THEN RAISE EXCEPTION 'subscription finish debited balance'; END IF;
    IF NOT EXISTS(SELECT FROM public.user_subscriptions WHERE id=sub_id AND daily_usage_usd=0.00023438 AND weekly_usage_usd=0.00023438 AND monthly_usage_usd=0.00023438) THEN RAISE EXCEPTION 'subscription finish did not meter usage'; END IF;
    IF NOT EXISTS(SELECT FROM public.usage_logs WHERE id=usage_id AND subscription_id=sub_id AND billing_type=1 AND rate_multiplier=3.75 AND account_rate_multiplier=0.5 AND account_stats_cost=0.00003125)
        OR NOT EXISTS(SELECT FROM public.billing_usage_entries WHERE usage_log_id=usage_id AND subscription_id=sub_id AND billing_type=1 AND delta_usd=0.00023438) THEN RAISE EXCEPTION 'subscription usage/reconciliation mismatch'; END IF;
END $$;
ROLLBACK;
