BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE u bigint := current_setting('s2a.acceptance.user_id')::bigint;
    k bigint := current_setting('s2a.acceptance.key_id')::bigint;
    g bigint := current_setting('s2a.acceptance.group_id')::bigint;
    request uuid := gen_random_uuid(); subscription_request uuid := gen_random_uuid();
    missing_request uuid := gen_random_uuid(); sub_id bigint; q_id bigint;
    result jsonb; before_balance numeric; previous_quota numeric; previous_rate numeric; fingerprint text := repeat('a',64);
BEGIN
    IF has_function_privilege('service_role','s2a_private.gateway_charge_user(uuid,numeric,text,text)','EXECUTE')
        OR has_function_privilege('anon','s2a_private.gateway_charge_user(uuid,numeric,text,text)','EXECUTE')
        OR has_function_privilege('authenticated','s2a_private.gateway_charge_user(uuid,numeric,text,text)','EXECUTE') THEN
        RAISE EXCEPTION 'billing helper must be private';
    END IF;
    UPDATE public.users SET balance=1 WHERE id=u;
    UPDATE public.api_keys SET quota=1,quota_used=0,rate_limit_5h=1,usage_5h=0.5,
        rate_limit_1d=0,rate_limit_7d=0,usage_1d=0,usage_7d=0,
        window_5h_start=now()-interval '6 hours',window_1d_start=NULL,window_7d_start=NULL WHERE id=k;
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,k,u,g,repeat('b',64),jsonb_build_object('quota','1','rate_limit_5h','1','subscription_type','standard','rate_multiplier','1.25','platform','openai'),now()-interval '1 minute');
    INSERT INTO public.user_platform_quotas(user_id,platform,daily_limit_usd,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,
        daily_window_start,weekly_window_start,monthly_window_start,created_at,updated_at)
    VALUES(u,'openai',10,2,2,2,now()-interval '2 days',now()-interval '14 days',now()-interval '31 days',now(),now()) RETURNING id INTO q_id;
    result := s2a_private.gateway_charge_user(request,0.0000625,fingerprint);
    IF result->>'actual_cost' <> '0.00007813' OR result->>'applied' <> 'true' THEN RAISE EXCEPTION 'monetary quantization failed: %',result; END IF;
    IF (SELECT balance FROM public.users WHERE id=u) <> 1-0.00007813 THEN RAISE EXCEPTION 'balance delta mismatch'; END IF;
    IF (SELECT quota_used FROM public.api_keys WHERE id=k) <> 0.00007813 THEN RAISE EXCEPTION 'quota delta mismatch'; END IF;
    IF EXISTS(SELECT FROM public.api_keys WHERE id=k AND (usage_5h<>0.00007813 OR usage_1d<>0.00007813 OR usage_7d<>0.00007813)) THEN RAISE EXCEPTION 'rate window reset mismatch'; END IF;
    IF EXISTS(SELECT FROM public.user_platform_quotas WHERE id=q_id AND (daily_usage_usd<>0.00007813 OR weekly_usage_usd<>0.00007813 OR monthly_usage_usd<>0.00007813)) THEN RAISE EXCEPTION 'platform window reset mismatch'; END IF;
    IF s2a_private.gateway_charge_user(request,0.0000625,fingerprint)->>'applied' <> 'false' THEN RAISE EXCEPTION 'replay billed twice'; END IF;
    IF s2a_private.gateway_charge_user(request,0.0000625000,fingerprint)->>'applied' <> 'false' THEN RAISE EXCEPTION 'equivalent decimal replay billed twice'; END IF;
    BEGIN
        PERFORM s2a_private.gateway_charge_user(request,0.000062501,fingerprint);
        RAISE EXCEPTION 'unrounded cost conflict accepted';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    BEGIN
        PERFORM s2a_private.gateway_charge_user(request,0.0000625,repeat('c',64));
        RAISE EXCEPTION 'usage conflict accepted';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    INSERT INTO public.usage_billing_dedup_archive(request_id,api_key_id,request_fingerprint,created_at)
    SELECT request_id,api_key_id,request_fingerprint,created_at FROM public.usage_billing_dedup WHERE request_id=request::text AND api_key_id=k;
    DELETE FROM public.usage_billing_dedup WHERE request_id=request::text AND api_key_id=k;
    IF s2a_private.gateway_charge_user(request,0.0000625,fingerprint)->>'applied' <> 'false' THEN RAISE EXCEPTION 'archived replay billed twice'; END IF;
    BEGIN
        PERFORM s2a_private.gateway_charge_user(request,1,fingerprint);
        RAISE EXCEPTION 'archived conflict accepted';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    request := gen_random_uuid();
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,k,u,g,repeat('b',64),jsonb_build_object('quota','1','rate_limit_5h','1','subscription_type','standard','rate_multiplier','1','platform','openai'),now());
    result := s2a_private.gateway_charge_user(request,2,fingerprint);
    IF result->>'balance_overdrafted' <> 'true' OR result->>'api_key_quota_exhausted' <> 'true' THEN RAISE EXCEPTION 'incurred overdraft not recorded'; END IF;
    IF (SELECT status FROM public.api_keys WHERE id=k) <> 'quota_exhausted' THEN RAISE EXCEPTION 'key quota state mismatch'; END IF;
    SELECT balance INTO before_balance FROM public.users WHERE id=u;
    UPDATE public.user_platform_quotas SET deleted_at=now() WHERE id=q_id;
    UPDATE public.user_subscriptions SET deleted_at=now() WHERE user_id=u AND group_id=g AND deleted_at IS NULL;
    INSERT INTO public.user_subscriptions(user_id,group_id,starts_at,expires_at,status,daily_usage_usd,weekly_usage_usd,monthly_usage_usd,created_at,updated_at,assigned_at)
    VALUES(u,g,now()-interval '2 days',now()-interval '1 day','active',0,0,0,now(),now(),now()) RETURNING id INTO sub_id;
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(subscription_request,k,u,g,repeat('b',64),jsonb_build_object('quota','1','rate_limit_5h','1','subscription_type','subscription','subscription_id',sub_id::text,'rate_multiplier','2','platform','openai'),now());
    PERFORM s2a_private.gateway_charge_user(subscription_request,0.25,fingerprint);
    IF (SELECT balance FROM public.users WHERE id=u) <> before_balance THEN RAISE EXCEPTION 'subscription debited balance'; END IF;
    IF EXISTS(SELECT FROM public.user_subscriptions WHERE id=sub_id AND (daily_usage_usd<>0.5 OR weekly_usage_usd<>0.5 OR monthly_usage_usd<>0.5)) THEN RAISE EXCEPTION 'subscription usage mismatch'; END IF;
    IF (SELECT daily_usage_usd FROM public.user_platform_quotas WHERE id=q_id) <> 2.00007813 THEN RAISE EXCEPTION 'subscription changed platform quota'; END IF;
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(missing_request,k,u,g,repeat('b',64),jsonb_build_object('quota','1','rate_limit_5h','1','subscription_type','subscription','subscription_id','-1','rate_multiplier','1'),now());
    BEGIN
        PERFORM s2a_private.gateway_charge_user(missing_request,1,fingerprint);
        RAISE EXCEPTION 'missing subscription accepted';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'billing_subscription_not_found' THEN RAISE; END IF;
    END;
    IF EXISTS(SELECT FROM public.usage_billing_dedup WHERE request_id=missing_request::text) THEN RAISE EXCEPTION 'failed transaction retained dedup key'; END IF;
    BEGIN
        PERFORM s2a_private.gateway_charge_user(request,'NaN'::numeric,fingerprint);
        RAISE EXCEPTION 'NaN cost accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
    BEGIN
        PERFORM s2a_private.gateway_charge_user(request,-1,fingerprint);
        RAISE EXCEPTION 'negative cost accepted';
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
    request := gen_random_uuid();
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,k,u,g,repeat('b',64),jsonb_build_object('quota','1','rate_limit_5h','1','subscription_type','standard','rate_multiplier','1','platform','openai'),now());
    SELECT quota_used,usage_5h INTO previous_quota,previous_rate FROM public.api_keys WHERE id=k;
    UPDATE public.api_keys SET quota=0,rate_limit_5h=0 WHERE id=k;
    PERFORM s2a_private.gateway_charge_user(request,0.1,fingerprint);
    IF EXISTS(SELECT FROM public.api_keys WHERE id=k AND (quota_used<>previous_quota+0.1 OR usage_5h<>previous_rate+0.1)) THEN RAISE EXCEPTION 'settlement ignored admitted key policy'; END IF;
    request := gen_random_uuid();
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,k,u,g,repeat('b',64),jsonb_build_object('subscription_type','standard','rate_multiplier','1','platform','openai'),now());
    SELECT quota_used,usage_5h INTO previous_quota,previous_rate FROM public.api_keys WHERE id=k;
    UPDATE public.api_keys SET quota=1,rate_limit_5h=1 WHERE id=k;
    PERFORM s2a_private.gateway_charge_user(request,0.1,fingerprint);
    IF EXISTS(SELECT FROM public.api_keys WHERE id=k AND (quota_used<>previous_quota OR usage_5h<>previous_rate)) THEN RAISE EXCEPTION 'settlement used post-admission key limits'; END IF;
    SELECT balance INTO before_balance FROM public.users WHERE id=u;
    request := gen_random_uuid();
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,k,u,g,repeat('b',64),jsonb_build_object('subscription_type','standard','rate_multiplier','0','platform','openai'),now());
    result := s2a_private.gateway_charge_user(request,100,fingerprint);
    IF (result->>'actual_cost')::numeric <> 0 OR (SELECT balance FROM public.users WHERE id=u) <> before_balance THEN RAISE EXCEPTION 'free group charged balance'; END IF;
    UPDATE public.api_keys SET deleted_at=now() WHERE id=k;
    request := gen_random_uuid();
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,k,u,g,repeat('b',64),jsonb_build_object('quota','1','rate_limit_5h','1','subscription_type','standard','rate_multiplier','1','platform','openai'),now());
    PERFORM s2a_private.gateway_charge_user(request,0.1,fingerprint);
    IF (SELECT balance FROM public.users WHERE id=u) <> before_balance-0.1 THEN RAISE EXCEPTION 'key deletion discarded incurred cost'; END IF;
END $$;
DO $$
DECLARE policy jsonb := '{"subscription_type":"subscription","peak_rate_enabled":true,"peak_start":"14:00","peak_end":"18:00","peak_rate_multiplier":3}';
    moment timestamptz; sample record;
BEGIN
    FOR sample IN SELECT * FROM (VALUES
        ('2026-06-29 13:59:59+00'::timestamptz,1),('2026-06-29 14:00:00+00'::timestamptz,3),
        ('2026-06-29 17:59:59+00'::timestamptz,3),('2026-06-29 18:00:00+00'::timestamptz,1)) AS cases(at,want)
    LOOP
        IF s2a_private.gateway_peak_multiplier(policy,sample.at,'UTC') <> sample.want THEN RAISE EXCEPTION 'peak boundary mismatch'; END IF;
    END LOOP;
    moment := '2026-06-29 15:00:00+08';
    IF s2a_private.gateway_peak_multiplier(policy,moment,'UTC') <> 1
        OR s2a_private.gateway_peak_multiplier(policy,moment,'Asia/Shanghai') <> 3 THEN RAISE EXCEPTION 'peak timezone mismatch'; END IF;
    FOR sample IN SELECT * FROM (VALUES
        ('{"subscription_type":"standard"}'::jsonb,1),('{"peak_rate_enabled":false}'::jsonb,1),
        ('{"peak_start":"18:00","peak_end":"14:00"}'::jsonb,1),('{"peak_end":"14:00"}'::jsonb,1),
        ('{"peak_start":"99:99"}'::jsonb,1),('{"peak_start":"1:30"}'::jsonb,3),
        ('{"peak_start":"01:30"}'::jsonb,3),('{"peak_start":" 1:30"}'::jsonb,1),
        ('{"peak_rate_multiplier":0}'::jsonb,0)) AS cases(patch,want)
    LOOP
        IF s2a_private.gateway_peak_multiplier(policy||sample.patch,'2026-06-29 15:00:00+00','UTC') <> sample.want THEN RAISE EXCEPTION 'peak configuration mismatch: %',sample.patch; END IF;
    END LOOP;
    IF has_function_privilege('service_role','s2a_private.gateway_peak_multiplier(jsonb,timestamptz,text)','EXECUTE') THEN RAISE EXCEPTION 'peak helper exposed'; END IF;
END $$;
ROLLBACK;
