-- Install after gateway-admission.sql. Called inside the cloud finish transaction.
BEGIN;
-- Native key triggers must resolve their outbox even when cloud callers use an empty path.
ALTER FUNCTION public.enqueue_api_key_auth_cache_invalidation() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.enqueue_auth_cache_invalidation(text) SET search_path = pg_catalog, public, pg_temp;
CREATE OR REPLACE FUNCTION s2a_private.gateway_charge_user(
    p_request_id uuid, p_base_cost numeric, p_usage_fingerprint text,
    p_timezone text DEFAULT 'Asia/Shanghai'
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE r s2a_private.gateway_requests; cost numeric; effective_rate numeric; fingerprint text; previous text;
    new_balance numeric; exhausted boolean := false; subscription bigint;
    today timestamptz; week_start timestamptz; now_at timestamptz;
BEGIN
    IF p_base_cost IS NULL OR p_base_cost < 0 OR p_base_cost::text IN ('NaN','Infinity','-Infinity')
        OR p_base_cost >= 1000000000000 OR p_usage_fingerprint IS NULL
        OR p_usage_fingerprint !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'invalid_billing_command' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id = p_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'request_lease_not_found' USING ERRCODE = '22023'; END IF;
    -- Match admission's user-first lock order; incurred costs remain payable after lease expiry.
    PERFORM 1 FROM public.users WHERE id = r.user_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'billing_user_not_found'; END IF;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id = p_request_id FOR UPDATE;
    -- The finish API currently settles token usage; media retains the separate base rate.
    effective_rate := coalesce(r.policy->>'token_rate_multiplier',r.policy->>'rate_multiplier')::numeric;
    IF r.policy->>'subscription_type' NOT IN ('standard','subscription')
        OR r.policy->>'subscription_type' IS NULL
        OR effective_rate IS NULL OR effective_rate < 0
        OR effective_rate::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'invalid_billing_policy' USING ERRCODE = '22023';
    END IF;
    fingerprint := encode(sha256(convert_to(jsonb_build_array(
        r.fingerprint, p_usage_fingerprint, trim_scale(p_base_cost), effective_rate::text,
        r.policy->>'subscription_id', r.policy->>'subscription_type')::text, 'UTF8')), 'hex');
    SELECT request_fingerprint INTO previous FROM public.usage_billing_dedup
        WHERE request_id = p_request_id::text AND api_key_id = r.api_key_id;
    IF NOT FOUND THEN
        SELECT request_fingerprint INTO previous FROM public.usage_billing_dedup_archive
            WHERE request_id = p_request_id::text AND api_key_id = r.api_key_id;
    END IF;
    IF FOUND THEN
        IF previous <> fingerprint THEN RAISE EXCEPTION 'billing_request_conflict' USING ERRCODE = '23505'; END IF;
        RETURN jsonb_build_object('applied', false);
    END IF;
    INSERT INTO public.usage_billing_dedup(request_id,api_key_id,request_fingerprint)
    VALUES (p_request_id::text,r.api_key_id,fingerprint) ON CONFLICT DO NOTHING;
    IF NOT FOUND THEN
        SELECT request_fingerprint INTO previous FROM public.usage_billing_dedup
            WHERE request_id = p_request_id::text AND api_key_id = r.api_key_id;
        IF previous IS DISTINCT FROM fingerprint THEN RAISE EXCEPTION 'billing_request_conflict' USING ERRCODE = '23505'; END IF;
        RETURN jsonb_build_object('applied', false);
    END IF;
    -- Quantize once before opposite balance/quota updates, matching Go decimal.Round(8).
    cost := round(p_base_cost * effective_rate, 8);
    IF cost >= 1000000000000 THEN RAISE EXCEPTION 'billing_cost_out_of_range' USING ERRCODE = '22023'; END IF;
    now_at := clock_timestamp();
    today := date_trunc('day', now_at AT TIME ZONE p_timezone) AT TIME ZONE p_timezone;
    week_start := date_trunc('week', now_at AT TIME ZONE p_timezone) AT TIME ZONE p_timezone;
    IF cost > 0 THEN
        IF r.policy->>'subscription_type' = 'subscription' THEN
            subscription := (r.policy->>'subscription_id')::bigint;
            UPDATE public.user_subscriptions us SET daily_usage_usd = us.daily_usage_usd + cost,
                weekly_usage_usd = us.weekly_usage_usd + cost, monthly_usage_usd = us.monthly_usage_usd + cost,
                updated_at = now_at
            FROM public.groups g WHERE us.id = subscription AND us.user_id = r.user_id AND us.group_id = r.group_id
                AND us.deleted_at IS NULL AND g.id = us.group_id AND g.deleted_at IS NULL;
            IF NOT FOUND THEN RAISE EXCEPTION 'billing_subscription_not_found'; END IF;
        ELSE
            UPDATE public.users SET balance = balance - cost, updated_at = now_at
            WHERE id = r.user_id AND deleted_at IS NULL RETURNING balance INTO new_balance;
            UPDATE public.user_platform_quotas SET
                daily_usage_usd = CASE WHEN daily_window_start IS DISTINCT FROM today THEN cost ELSE daily_usage_usd + cost END,
                weekly_usage_usd = CASE WHEN weekly_window_start IS DISTINCT FROM week_start THEN cost ELSE weekly_usage_usd + cost END,
                monthly_usage_usd = CASE WHEN monthly_window_start IS NULL OR monthly_window_start + interval '720 hours' <= now_at THEN cost ELSE monthly_usage_usd + cost END,
                daily_window_start = today, weekly_window_start = week_start,
                monthly_window_start = CASE WHEN monthly_window_start IS NULL OR monthly_window_start + interval '720 hours' <= now_at THEN now_at ELSE monthly_window_start END,
                updated_at = now_at
            WHERE user_id = r.user_id AND platform = r.policy->>'platform' AND deleted_at IS NULL
                AND (daily_limit_usd IS NOT NULL OR weekly_limit_usd IS NOT NULL OR monthly_limit_usd IS NOT NULL);
        END IF;
        IF coalesce((r.policy->>'quota')::numeric,0) > 0 THEN
        UPDATE public.api_keys SET quota_used = quota_used + cost,
            status = CASE WHEN quota > 0 AND status = 'active' AND quota_used < quota AND quota_used + cost >= quota THEN 'quota_exhausted' ELSE status END,
            updated_at = now_at
        WHERE id = r.api_key_id AND deleted_at IS NULL
        RETURNING quota > 0 AND quota_used >= quota AND quota_used - cost < quota INTO exhausted;
        END IF;
        IF coalesce((r.policy->>'rate_limit_5h')::numeric,0) > 0
            OR coalesce((r.policy->>'rate_limit_1d')::numeric,0) > 0
            OR coalesce((r.policy->>'rate_limit_7d')::numeric,0) > 0 THEN
        UPDATE public.api_keys SET
            usage_5h = CASE WHEN window_5h_start IS NOT NULL AND window_5h_start + interval '5 hours' <= now_at THEN cost ELSE usage_5h + cost END,
            usage_1d = CASE WHEN window_1d_start IS NOT NULL AND window_1d_start + interval '24 hours' <= now_at THEN cost ELSE usage_1d + cost END,
            usage_7d = CASE WHEN window_7d_start IS NOT NULL AND window_7d_start + interval '7 days' <= now_at THEN cost ELSE usage_7d + cost END,
            window_5h_start = CASE WHEN window_5h_start IS NULL OR window_5h_start + interval '5 hours' <= now_at THEN now_at ELSE window_5h_start END,
            window_1d_start = CASE WHEN window_1d_start IS NULL OR window_1d_start + interval '24 hours' <= now_at THEN today ELSE window_1d_start END,
            window_7d_start = CASE WHEN window_7d_start IS NULL OR window_7d_start + interval '7 days' <= now_at THEN today ELSE window_7d_start END,
            updated_at = now_at
        WHERE id = r.api_key_id AND deleted_at IS NULL;
        END IF;
    END IF;
    RETURN jsonb_build_object('applied', true, 'actual_cost', cost::text, 'new_balance', new_balance::text,
        'balance_overdrafted', coalesce(new_balance < 0, false), 'api_key_quota_exhausted', coalesce(exhausted, false));
END $$;
ALTER FUNCTION s2a_private.gateway_charge_user(uuid,numeric,text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.gateway_charge_user(uuid,numeric,text,text) FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
