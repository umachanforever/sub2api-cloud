BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
<<native_accounts>>
DECLARE u bigint := current_setting('s2a.acceptance.user_id')::bigint;
    k bigint := current_setting('s2a.acceptance.key_id')::bigint;
    g bigint := current_setting('s2a.acceptance.group_id')::bigint;
    a bigint; v bigint; request uuid := gen_random_uuid(); other uuid := gen_random_uuid();
    first_lease uuid; result jsonb; proxy_id bigint; stored_extra jsonb; balance_before numeric;
BEGIN
    IF has_function_privilege('anon','public.s2a_gateway_account_reserve(uuid,bigint,bigint)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_gateway_account_reserve(uuid,bigint,bigint)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_gateway_account_reserve(uuid,bigint,bigint)','EXECUTE') THEN RAISE EXCEPTION 'account reservation ACL mismatch'; END IF;
    IF has_function_privilege('service_role','s2a_private.gateway_charge_account(uuid,numeric,timestamptz)','EXECUTE')
        OR has_function_privilege('anon','s2a_private.gateway_charge_account(uuid,numeric,timestamptz)','EXECUTE')
        OR has_function_privilege('authenticated','s2a_private.gateway_charge_account(uuid,numeric,timestamptz)','EXECUTE')
        OR has_table_privilege('service_role','s2a_private.gateway_account_leases','SELECT') THEN RAISE EXCEPTION 'account lease billing is not private'; END IF;
    INSERT INTO public.accounts(name,platform,type,credentials,concurrency)
    VALUES('Slot fixture','openai','apikey','{"api_key":"synthetic-slot-key"}',1) RETURNING id,s2a_credential_version INTO a,v;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g);
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,k,u,g,repeat('b',64),'{}',clock_timestamp()+interval '3 minutes'),
          (other,k,u,g,repeat('c',64),'{}',clock_timestamp()+interval '3 minutes');
    result := public.s2a_gateway_account_reserve(request,a,v);
    IF result ? 'error' OR result->'account'->'credentials'->>'api_key' <> 'synthetic-slot-key' THEN RAISE EXCEPTION 'account reservation failed'; END IF;
    IF result->'request_policy' IS DISTINCT FROM (SELECT policy FROM s2a_private.gateway_requests WHERE request_id=request) THEN RAISE EXCEPTION 'reservation lost admitted pricing policy'; END IF;
    first_lease := (result->>'lease_id')::uuid;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'lease_id' <> first_lease::text THEN RAISE EXCEPTION 'replay consumed another slot'; END IF;
    IF public.s2a_gateway_account_reserve(request,a+1000000,v)->>'error' <> 'account_reservation_conflict' THEN RAISE EXCEPTION 'candidate conflict accepted'; END IF;
    IF public.s2a_gateway_account_reserve(other,a,v)->>'error' <> 'account_concurrency_exceeded' THEN RAISE EXCEPTION 'account oversubscribed'; END IF;
    IF EXISTS(SELECT FROM s2a_private.gateway_account_leases WHERE policy::text LIKE '%synthetic-slot-key%') THEN RAISE EXCEPTION 'lease persisted credentials'; END IF;
    INSERT INTO public.proxies(name,protocol,host,port) VALUES('slot proxy','http','proxy.invalid',8080) RETURNING id INTO proxy_id;
    UPDATE s2a_private.accounts SET proxy_id=native_accounts.proxy_id WHERE id=a;
    result := public.s2a_gateway_account_reserve(request,a,v);
    IF result->'account'->'proxy_id' <> 'null'::jsonb THEN RAISE EXCEPTION 'replay replaced frozen proxy'; END IF;
    UPDATE s2a_private.gateway_account_leases SET expires_at=clock_timestamp()-interval '1 second' WHERE lease_id=first_lease;
    result := public.s2a_gateway_account_reserve(other,a,v);
    IF result ? 'error' THEN RAISE EXCEPTION 'expired account slot not recovered'; END IF;
    UPDATE s2a_private.gateway_account_leases SET released_at=clock_timestamp() WHERE request_id IN (request,other);
    UPDATE s2a_private.accounts SET schedulable=false WHERE id=a;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_unavailable' THEN RAISE EXCEPTION 'paused account accepted'; END IF;
    UPDATE s2a_private.accounts SET schedulable=true,expires_at=clock_timestamp()-interval '1 second' WHERE id=a;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_unavailable' THEN RAISE EXCEPTION 'expired account accepted'; END IF;
    UPDATE s2a_private.accounts SET auto_pause_on_expired=false WHERE id=a;
    IF public.s2a_gateway_account_reserve(request,a,v) ? 'error' THEN RAISE EXCEPTION 'manual expiry override ignored'; END IF;
    UPDATE s2a_private.gateway_account_leases SET released_at=clock_timestamp() WHERE request_id=request;
    UPDATE s2a_private.accounts SET overload_until=clock_timestamp()+interval '1 minute' WHERE id=a;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_unavailable' THEN RAISE EXCEPTION 'overloaded account accepted'; END IF;
    UPDATE s2a_private.accounts SET overload_until=NULL,rate_limit_reset_at=clock_timestamp()+interval '1 minute' WHERE id=a;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_unavailable' THEN RAISE EXCEPTION 'rate limited account accepted'; END IF;
    UPDATE s2a_private.accounts SET rate_limit_reset_at=NULL,temp_unschedulable_until=clock_timestamp()+interval '1 minute' WHERE id=a;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_unavailable' THEN RAISE EXCEPTION 'cooling account accepted'; END IF;
    UPDATE s2a_private.accounts SET temp_unschedulable_until=NULL,extra='{"quota_limit":1,"quota_used":1}' WHERE id=a;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_quota_exceeded' THEN RAISE EXCEPTION 'exhausted account accepted'; END IF;
    UPDATE s2a_private.accounts SET extra='{}',platform='anthropic' WHERE id=a;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_platform_mismatch' THEN RAISE EXCEPTION 'wrong platform accepted'; END IF;
    UPDATE s2a_private.accounts SET platform='openai' WHERE id=a;
    UPDATE public.groups SET require_oauth_only=true WHERE id=g;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_policy_forbidden' THEN RAISE EXCEPTION 'OAuth-only policy ignored'; END IF;
    UPDATE public.groups SET require_oauth_only=false,require_privacy_set=true WHERE id=g;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_policy_forbidden' THEN RAISE EXCEPTION 'privacy policy ignored'; END IF;
    UPDATE s2a_private.accounts SET extra='{"privacy_mode":"training_off"}',concurrency=0 WHERE id=a;
    result := public.s2a_gateway_account_reserve(request,a,v);
    IF result ? 'error' THEN RAISE EXCEPTION 'private account rejected'; END IF;
    IF public.s2a_gateway_account_reserve(other,a,v)->>'error' <> 'account_concurrency_exceeded' THEN RAISE EXCEPTION 'zero concurrency bypassed safe default'; END IF;
    UPDATE s2a_private.gateway_account_leases SET released_at=clock_timestamp() WHERE request_id=request;
    UPDATE public.accounts SET credentials='{"api_key":"new-synthetic-key"}' WHERE id=a;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_credentials_changed' THEN RAISE EXCEPTION 'stale credential candidate accepted'; END IF;
    SELECT s2a_credential_version INTO v FROM s2a_private.accounts WHERE id=a;
    DELETE FROM public.account_groups WHERE account_id=a AND group_id=g;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'account_unavailable' THEN RAISE EXCEPTION 'unbound account accepted'; END IF;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g);
    UPDATE s2a_private.accounts SET rate_multiplier=1.25,extra='{"privacy_mode":"training_off","quota_limit":100,"quota_used":0,"quota_daily_limit":100,"quota_daily_used":10,"quota_daily_reset_mode":"fixed","quota_daily_reset_hour":3,"quota_daily_reset_at":"2026-03-01T08:00:00Z","quota_weekly_limit":100,"quota_weekly_used":10,"quota_weekly_reset_mode":"fixed","quota_weekly_reset_day":0,"quota_weekly_reset_hour":3,"quota_weekly_reset_at":"2026-03-01T08:00:00Z","quota_reset_timezone":"America/New_York"}' WHERE id=a;
    result := public.s2a_gateway_account_reserve(request,a,v);
    IF result ? 'error' THEN RAISE EXCEPTION 'quota charge fixture reservation failed'; END IF;
    first_lease := (result->>'lease_id')::uuid;
    UPDATE s2a_private.accounts SET rate_multiplier=0 WHERE id=a;
    result := s2a_private.gateway_charge_account(first_lease,0.0000625,'2026-03-08 08:00:00+00');
    IF result->>'account_cost' <> '0.00007813' THEN RAISE EXCEPTION 'frozen account multiplier or quantization mismatch'; END IF;
    SELECT extra INTO stored_extra FROM s2a_private.accounts WHERE id=a;
    IF (stored_extra->>'quota_used')::numeric<>0.00007813 OR (stored_extra->>'quota_daily_used')::numeric<>0.00007813
        OR (stored_extra->>'quota_weekly_used')::numeric<>0.00007813 THEN RAISE EXCEPTION 'account quota increment mismatch'; END IF;
    IF stored_extra->>'quota_daily_reset_at'<>'2026-03-09T07:00:00Z' OR stored_extra->>'quota_weekly_reset_at'<>'2026-03-15T07:00:00Z' THEN RAISE EXCEPTION 'account fixed reset boundary mismatch'; END IF;
    IF s2a_private.gateway_charge_account(first_lease,0.0000625000)->>'applied' <> 'false' THEN RAISE EXCEPTION 'account charge replay billed twice'; END IF;
    BEGIN
        PERFORM s2a_private.gateway_charge_account(first_lease,0.000062501);
        RAISE EXCEPTION 'account charge conflict accepted';
    EXCEPTION WHEN unique_violation THEN NULL; END;
    UPDATE s2a_private.gateway_account_leases SET released_at=clock_timestamp() WHERE lease_id=first_lease;
    UPDATE s2a_private.accounts SET rate_multiplier=1 WHERE id=a;
    result := public.s2a_gateway_account_reserve(other,a,v);
    first_lease := (result->>'lease_id')::uuid;
    IF first_lease IS NULL THEN RAISE EXCEPTION 'atomic charge fixture reservation failed'; END IF;
    UPDATE s2a_private.gateway_requests SET policy='{"subscription_type":"standard","rate_multiplier":"2","platform":"openai"}' WHERE request_id=other;
    SELECT balance INTO balance_before FROM public.users WHERE id=u;
    SELECT extra INTO stored_extra FROM s2a_private.accounts WHERE id=a;
    BEGIN
        PERFORM s2a_private.gateway_charge_user(other,1,repeat('a',64));
        PERFORM s2a_private.gateway_charge_account(first_lease,1);
        RAISE EXCEPTION 'synthetic_billing_rollback';
    EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'synthetic_billing_rollback' THEN RAISE; END IF; END;
    IF (SELECT balance FROM public.users WHERE id=u) <> balance_before
        OR (SELECT extra FROM s2a_private.accounts WHERE id=a) <> stored_extra
        OR EXISTS(SELECT FROM public.usage_billing_dedup WHERE request_id=other::text)
        OR (SELECT account_cost FROM s2a_private.gateway_account_leases WHERE lease_id=first_lease) IS NOT NULL THEN RAISE EXCEPTION 'combined billing rollback was incomplete'; END IF;
    UPDATE public.api_keys SET status='inactive' WHERE id=k;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'invalid_api_key' THEN RAISE EXCEPTION 'revoked key accepted'; END IF;
    UPDATE public.api_keys SET status='active' WHERE id=k;
    UPDATE s2a_private.gateway_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE request_id=request;
    IF public.s2a_gateway_account_reserve(request,a,v)->>'error' <> 'request_lease_expired' THEN RAISE EXCEPTION 'expired request accepted'; END IF;
END $$;
DO $$
DECLARE at_time timestamptz := '2026-03-08 08:00:00+00'; extra jsonb;
BEGIN
    IF s2a_private.gateway_account_quota_exceeded('{}',at_time) THEN RAISE EXCEPTION 'unlimited account rejected'; END IF;
    extra := '{"quota_daily_limit":1,"quota_daily_used":1,"quota_daily_start":"2026-03-07T08:00:01Z"}';
    IF NOT s2a_private.gateway_account_quota_exceeded(extra,at_time) THEN RAISE EXCEPTION 'rolling daily quota ignored'; END IF;
    IF s2a_private.gateway_account_quota_exceeded(extra,at_time+interval '1 second') THEN RAISE EXCEPTION 'rolling daily boundary incorrect'; END IF;
    extra := '{"quota_weekly_limit":1,"quota_weekly_used":1,"quota_weekly_start":"2026-03-01T08:00:01Z"}';
    IF NOT s2a_private.gateway_account_quota_exceeded(extra,at_time) THEN RAISE EXCEPTION 'rolling weekly quota ignored'; END IF;
    IF s2a_private.gateway_account_quota_exceeded(extra,at_time+interval '1 second') THEN RAISE EXCEPTION 'rolling weekly boundary incorrect'; END IF;
    extra := '{"quota_daily_limit":1,"quota_daily_used":1,"quota_daily_reset_mode":"fixed","quota_daily_reset_hour":3,"quota_reset_timezone":"America/New_York","quota_daily_start":"2026-03-08T06:59:59Z"}';
    IF s2a_private.gateway_account_quota_exceeded(extra,at_time) THEN RAISE EXCEPTION 'fixed daily DST reset incorrect'; END IF;
    IF NOT s2a_private.gateway_account_quota_exceeded(extra||'{"quota_daily_start":"2026-03-08T07:00:00Z"}',at_time) THEN RAISE EXCEPTION 'fixed daily active window ignored'; END IF;
    extra := '{"quota_weekly_limit":1,"quota_weekly_used":1,"quota_weekly_reset_mode":"fixed","quota_weekly_reset_hour":3,"quota_weekly_reset_day":0,"quota_reset_timezone":"America/New_York","quota_weekly_start":"2026-03-08T06:59:59Z"}';
    IF s2a_private.gateway_account_quota_exceeded(extra,at_time) THEN RAISE EXCEPTION 'fixed weekly DST reset incorrect'; END IF;
    IF NOT s2a_private.gateway_account_quota_exceeded(extra||'{"quota_weekly_start":"2026-03-08T07:00:00Z"}',at_time) THEN RAISE EXCEPTION 'fixed weekly active window ignored'; END IF;
END $$;
ROLLBACK;
