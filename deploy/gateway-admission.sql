-- Install after native migrations. Request leases contain policy snapshots, never provider secrets.
BEGIN;
CREATE SCHEMA IF NOT EXISTS s2a_private AUTHORIZATION s2a_management;
REVOKE ALL ON SCHEMA s2a_private FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS s2a_private.gateway_requests (
    request_id uuid PRIMARY KEY,
    api_key_id bigint NOT NULL,
    user_id bigint NOT NULL,
    group_id bigint NOT NULL,
    fingerprint text NOT NULL,
    policy jsonb NOT NULL,
    admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    finished_at timestamptz
);
ALTER TABLE s2a_private.gateway_requests OWNER TO s2a_management;
ALTER TABLE s2a_private.gateway_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE s2a_private.gateway_requests FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX IF NOT EXISTS gateway_requests_user_active ON s2a_private.gateway_requests(user_id, expires_at) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS gateway_requests_user_recent ON s2a_private.gateway_requests(user_id, admitted_at DESC);

-- Match upstream rolling subscription windows, including the first legacy midnight anchor.
CREATE OR REPLACE FUNCTION s2a_private.gateway_subscription_window(p_previous timestamptz, p_starts timestamptz, p_expires timestamptz, p_seconds integer, p_now timestamptz, p_timezone text) RETURNS timestamptz
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE anchor timestamptz; legacy timestamptz; periods bigint;
BEGIN
    IF p_previous IS NULL THEN RETURN p_now; END IF;
    legacy := date_trunc('day', p_starts AT TIME ZONE p_timezone) AT TIME ZONE p_timezone;
    anchor := CASE WHEN legacy < p_starts AND p_previous = legacy THEN p_starts ELSE p_previous END;
    IF p_now < anchor + make_interval(secs => p_seconds) OR anchor + make_interval(secs => p_seconds) >= p_expires THEN RETURN p_previous; END IF;
    periods := least(floor(extract(epoch FROM p_now - anchor) / p_seconds), floor(extract(epoch FROM p_expires - anchor - interval '1 microsecond') / p_seconds))::bigint;
    RETURN anchor + make_interval(secs => periods * p_seconds);
END $$;
ALTER FUNCTION s2a_private.gateway_subscription_window(timestamptz,timestamptz,timestamptz,integer,timestamptz,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.gateway_subscription_window(timestamptz,timestamptz,timestamptz,integer,timestamptz,text) FROM PUBLIC, anon, authenticated, service_role;

-- Match Go Group.PeakMultiplierAt: local minutes, inclusive start, exclusive end.
CREATE OR REPLACE FUNCTION s2a_private.gateway_peak_multiplier(p_group jsonb, p_at timestamptz, p_timezone text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE start_text text := p_group->>'peak_start'; end_text text := p_group->>'peak_end';
    start_minute integer; end_minute integer; local_at timestamp; current_minute integer;
BEGIN
    IF p_group->>'subscription_type' IS DISTINCT FROM 'subscription'
        OR NOT coalesce((p_group->>'peak_rate_enabled')::boolean,false)
        OR start_text IS NULL OR end_text IS NULL
        OR start_text !~ '^([0-9]|[01][0-9]|2[0-3]):[0-5][0-9]$'
        OR end_text !~ '^([0-9]|[01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN 1; END IF;
    start_minute := split_part(start_text,':',1)::integer*60 + split_part(start_text,':',2)::integer;
    end_minute := split_part(end_text,':',1)::integer*60 + split_part(end_text,':',2)::integer;
    IF start_minute >= end_minute THEN RETURN 1; END IF;
    local_at := p_at AT TIME ZONE p_timezone;
    current_minute := extract(hour FROM local_at)::integer*60 + extract(minute FROM local_at)::integer;
    IF current_minute >= start_minute AND current_minute < end_minute THEN RETURN (p_group->>'peak_rate_multiplier')::numeric; END IF;
    RETURN 1;
END $$;
ALTER FUNCTION s2a_private.gateway_peak_multiplier(jsonb,timestamptz,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.gateway_peak_multiplier(jsonb,timestamptz,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.s2a_gateway_key_admit(p_hash text, p_request_id uuid, p_model text, p_client_ip text DEFAULT NULL, p_timezone text DEFAULT 'Asia/Shanghai') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE identity jsonb; k public.api_keys; u public.users; g public.groups;
    existing s2a_private.gateway_requests; address inet; network text;
    allowed boolean; pattern text; fingerprint text; snapshot jsonb; now_at timestamptz := clock_timestamp();
    sub public.user_subscriptions; quota public.user_platform_quotas;
    daily_start timestamptz; weekly_start timestamptz; monthly_start timestamptz; today timestamptz; week_start timestamptz;
    effective_rpm integer; group_rpm integer; requests bigint; user_rate numeric;
BEGIN
    IF p_request_id IS NULL OR p_model IS NULL OR length(p_model) > 200 OR p_model ~ '[[:cntrl:]]' THEN
        RETURN jsonb_build_object('error', 'invalid_request', 'status', 400);
    END IF;
    identity := public.s2a_gateway_key_lookup(p_hash);
    IF identity ? 'error' THEN
        RETURN identity || jsonb_build_object('status', CASE WHEN identity->>'error' = 'invalid_api_key' THEN 401 ELSE 403 END);
    END IF;
    -- All keys for a user share this lock, serializing concurrency and RPM admission.
    SELECT * INTO u FROM public.users WHERE id = (identity->>'user_id')::bigint FOR UPDATE;
    SELECT * INTO k FROM public.api_keys WHERE id = (identity->>'key_id')::bigint FOR UPDATE;
    identity := public.s2a_gateway_key_lookup(p_hash);
    IF identity ? 'error' THEN
        RETURN identity || jsonb_build_object('status', CASE WHEN identity->>'error' = 'invalid_api_key' THEN 401 ELSE 403 END);
    END IF;
    IF k.user_id <> u.id OR k.s2a_key_hash <> p_hash THEN
        RETURN jsonb_build_object('error', 'invalid_api_key', 'status', 401);
    END IF;
    now_at := clock_timestamp();
    IF k.expires_at IS NOT NULL AND k.expires_at <= now_at THEN RETURN jsonb_build_object('error', 'invalid_api_key', 'status', 401); END IF;
    SELECT * INTO g FROM public.groups WHERE id = k.group_id;
    IF p_client_ip IS NOT NULL THEN
        BEGIN
            -- Reject prefixes: accepting a caller-supplied subnet would widen IP access.
            IF strpos(p_client_ip, '/') > 0 THEN RAISE invalid_text_representation; END IF;
            address := p_client_ip::inet;
        EXCEPTION WHEN invalid_text_representation THEN
            RETURN jsonb_build_object('error', 'invalid_client_ip', 'status', 400);
        END;
    END IF;
    IF jsonb_array_length(coalesce(k.ip_whitelist, '[]'::jsonb)) > 0 THEN
        allowed := false;
        IF address IS NOT NULL THEN
            FOR network IN SELECT jsonb_array_elements_text(k.ip_whitelist) LOOP
                IF address <<= network::inet THEN allowed := true; END IF;
            END LOOP;
        END IF;
        IF NOT allowed THEN RETURN jsonb_build_object('error', 'ip_forbidden', 'status', 403); END IF;
    END IF;
    IF address IS NOT NULL THEN
        FOR network IN SELECT jsonb_array_elements_text(coalesce(k.ip_blacklist, '[]'::jsonb)) LOOP
            IF address <<= network::inet THEN RETURN jsonb_build_object('error', 'ip_forbidden', 'status', 403); END IF;
        END LOOP;
    ELSIF jsonb_array_length(coalesce(k.ip_blacklist, '[]'::jsonb)) > 0 THEN
        RETURN jsonb_build_object('error', 'client_ip_required', 'status', 403);
    END IF;
    IF p_model <> '__models__' AND coalesce((g.model_allowlist->>'enabled')::boolean, false) THEN
        allowed := false;
        FOR pattern IN SELECT jsonb_array_elements_text(coalesce(g.model_allowlist->'models', '[]'::jsonb)) LOOP
            IF lower(p_model) = lower(pattern) OR (right(pattern, 1) = '*' AND starts_with(lower(p_model), lower(left(pattern, -1)))) THEN allowed := true; END IF;
        END LOOP;
        IF NOT allowed THEN RETURN jsonb_build_object('error', 'model_not_allowed', 'status', 403); END IF;
    END IF;
    fingerprint := encode(sha256(convert_to(jsonb_build_array(p_hash, p_model, address::text)::text, 'UTF8')), 'hex');
    SELECT * INTO existing FROM s2a_private.gateway_requests WHERE request_id = p_request_id;
    IF FOUND THEN
        IF existing.fingerprint <> fingerprint OR existing.api_key_id <> k.id OR existing.group_id <> g.id THEN
            RETURN jsonb_build_object('error', 'request_conflict', 'status', 409);
        END IF;
        IF existing.finished_at IS NOT NULL OR existing.expires_at <= now_at THEN
            RETURN jsonb_build_object('error', 'request_lease_expired', 'status', 409);
        END IF;
        RETURN existing.policy || jsonb_build_object('lease_id', existing.request_id::text);
    END IF;
    IF k.quota > 0 AND k.quota_used >= k.quota THEN RETURN jsonb_build_object('error', 'api_key_quota_exceeded', 'status', 429); END IF;
    IF k.rate_limit_5h > 0 AND (k.window_5h_start IS NULL OR k.window_5h_start + interval '5 hours' > now_at) AND k.usage_5h >= k.rate_limit_5h THEN
        RETURN jsonb_build_object('error', 'api_key_rate_5h_exceeded', 'status', 429);
    END IF;
    IF k.rate_limit_1d > 0 AND (k.window_1d_start IS NULL OR k.window_1d_start + interval '24 hours' > now_at) AND k.usage_1d >= k.rate_limit_1d THEN
        RETURN jsonb_build_object('error', 'api_key_rate_1d_exceeded', 'status', 429);
    END IF;
    IF k.rate_limit_7d > 0 AND (k.window_7d_start IS NULL OR k.window_7d_start + interval '7 days' > now_at) AND k.usage_7d >= k.rate_limit_7d THEN
        RETURN jsonb_build_object('error', 'api_key_rate_7d_exceeded', 'status', 429);
    END IF;
    today := date_trunc('day', now_at AT TIME ZONE p_timezone) AT TIME ZONE p_timezone;
    week_start := date_trunc('week', now_at AT TIME ZONE p_timezone) AT TIME ZONE p_timezone;
    IF g.subscription_type = 'standard' THEN
        IF u.balance <= 0 THEN RETURN jsonb_build_object('error', 'insufficient_balance', 'status', 402); END IF;
    ELSIF g.subscription_type = 'subscription' THEN
        SELECT * INTO sub FROM public.user_subscriptions WHERE user_id = u.id AND group_id = g.id AND deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND OR sub.status <> 'active' OR sub.starts_at > now_at OR sub.expires_at <= now_at THEN
            RETURN jsonb_build_object('error', 'subscription_unavailable', 'status', 403);
        END IF;
        daily_start := coalesce(sub.daily_window_start, today);
        IF sub.daily_window_start IS NOT NULL AND sub.daily_window_start < today
            AND sub.expires_at > ((sub.starts_at AT TIME ZONE p_timezone) + interval '1 day') AT TIME ZONE p_timezone THEN daily_start := today; END IF;
        weekly_start := s2a_private.gateway_subscription_window(sub.weekly_window_start, sub.starts_at, sub.expires_at, 604800, now_at, p_timezone);
        monthly_start := s2a_private.gateway_subscription_window(sub.monthly_window_start, sub.starts_at, sub.expires_at, 2592000, now_at, p_timezone);
        UPDATE public.user_subscriptions SET
            daily_usage_usd = CASE WHEN sub.daily_window_start IS NOT NULL AND sub.daily_window_start <> daily_start THEN 0 ELSE daily_usage_usd END,
            weekly_usage_usd = CASE WHEN sub.weekly_window_start IS NOT NULL AND sub.weekly_window_start <> weekly_start THEN 0 ELSE weekly_usage_usd END,
            monthly_usage_usd = CASE WHEN sub.monthly_window_start IS NOT NULL AND sub.monthly_window_start <> monthly_start THEN 0 ELSE monthly_usage_usd END,
            daily_window_start = daily_start, weekly_window_start = weekly_start, monthly_window_start = monthly_start, updated_at = now_at
        WHERE id = sub.id RETURNING * INTO sub;
        IF (g.daily_limit_usd > 0 AND sub.daily_usage_usd > g.daily_limit_usd) OR
            (g.weekly_limit_usd > 0 AND sub.weekly_usage_usd > g.weekly_limit_usd) OR
            (g.monthly_limit_usd > 0 AND sub.monthly_usage_usd > g.monthly_limit_usd) THEN
            RETURN jsonb_build_object('error', 'subscription_quota_exceeded', 'status', 429);
        END IF;
    ELSE
        RETURN jsonb_build_object('error', 'invalid_gateway_policy', 'status', 503);
    END IF;
    SELECT * INTO quota FROM public.user_platform_quotas WHERE user_id = u.id AND platform = g.platform AND deleted_at IS NULL AND g.subscription_type = 'standard' FOR UPDATE;
    IF FOUND THEN
        UPDATE public.user_platform_quotas SET
            daily_usage_usd = CASE WHEN quota.daily_window_start IS NULL OR quota.daily_window_start < today THEN 0 ELSE daily_usage_usd END,
            weekly_usage_usd = CASE WHEN quota.weekly_window_start IS NULL OR quota.weekly_window_start < week_start THEN 0 ELSE weekly_usage_usd END,
            monthly_usage_usd = CASE WHEN quota.monthly_window_start IS NULL OR quota.monthly_window_start + interval '720 hours' <= now_at THEN 0 ELSE monthly_usage_usd END,
            daily_window_start = CASE WHEN quota.daily_window_start IS NULL OR quota.daily_window_start < today THEN today ELSE quota.daily_window_start END,
            weekly_window_start = CASE WHEN quota.weekly_window_start IS NULL OR quota.weekly_window_start < week_start THEN week_start ELSE quota.weekly_window_start END,
            monthly_window_start = CASE WHEN quota.monthly_window_start IS NULL OR quota.monthly_window_start + interval '720 hours' <= now_at THEN now_at ELSE quota.monthly_window_start END,
            updated_at = now_at WHERE id = quota.id RETURNING * INTO quota;
        IF (quota.daily_limit_usd IS NOT NULL AND quota.daily_usage_usd >= quota.daily_limit_usd) OR
            (quota.weekly_limit_usd IS NOT NULL AND quota.weekly_usage_usd >= quota.weekly_limit_usd) OR
            (quota.monthly_limit_usd IS NOT NULL AND quota.monthly_usage_usd >= quota.monthly_limit_usd) THEN
            RETURN jsonb_build_object('error', 'platform_quota_exceeded', 'status', 429);
        END IF;
    END IF;
    IF u.concurrency > 0 AND (SELECT count(*) FROM s2a_private.gateway_requests WHERE user_id = u.id AND finished_at IS NULL AND expires_at > now_at) >= u.concurrency THEN
        RETURN jsonb_build_object('error', 'user_concurrency_exceeded', 'status', 429);
    END IF;
    SELECT rpm_override, rate_multiplier INTO group_rpm, user_rate FROM public.user_group_rate_multipliers WHERE user_id = u.id AND group_id = g.id;
    effective_rpm := coalesce(group_rpm, g.rpm_limit);
    IF effective_rpm > 0 THEN
        SELECT count(*) INTO requests FROM s2a_private.gateway_requests WHERE user_id = u.id AND group_id = g.id AND admitted_at >= date_trunc('minute', now_at);
        IF requests >= effective_rpm THEN RETURN jsonb_build_object('error', 'group_rate_limit_exceeded', 'status', 429); END IF;
    END IF;
    -- The user ceiling still applies when a per-group override disables its own limit.
    IF u.rpm_limit > 0 AND (SELECT count(*) FROM s2a_private.gateway_requests WHERE user_id = u.id AND admitted_at >= date_trunc('minute', now_at)) >= u.rpm_limit THEN
        RETURN jsonb_build_object('error', 'rate_limit_exceeded', 'status', 429);
    END IF;
    snapshot := identity || jsonb_build_object('group_policy', to_jsonb(g), 'channel_policy', s2a_private.gateway_channel_policy(g.id), 'pricing_at', now_at, 'model', p_model, 'rate_multiplier', coalesce(user_rate, g.rate_multiplier)::text,
        'token_rate_multiplier', (coalesce(user_rate, g.rate_multiplier) * s2a_private.gateway_peak_multiplier(to_jsonb(g),now_at,p_timezone))::text, 'subscription_id', sub.id::text, 'timezone', p_timezone);
    INSERT INTO s2a_private.gateway_requests(request_id, api_key_id, user_id, group_id, fingerprint, policy, admitted_at, expires_at)
    VALUES(p_request_id, k.id, u.id, g.id, fingerprint, snapshot, now_at, now_at + interval '3 minutes') ON CONFLICT (request_id) DO NOTHING;
    IF NOT FOUND THEN RETURN jsonb_build_object('error', 'request_conflict', 'status', 409); END IF;
    RETURN snapshot || jsonb_build_object('lease_id', p_request_id::text);
EXCEPTION WHEN invalid_text_representation OR invalid_parameter_value THEN
    RETURN jsonb_build_object('error', 'invalid_gateway_policy', 'status', 503);
END $$;
ALTER FUNCTION public.s2a_gateway_key_admit(text,uuid,text,text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_key_admit(text,uuid,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_key_admit(text,uuid,text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.s2a_gateway_key_release(p_request_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    UPDATE s2a_private.gateway_requests SET finished_at = clock_timestamp()
    WHERE request_id = p_request_id AND finished_at IS NULL;
    RETURN FOUND;
END $$;
ALTER FUNCTION public.s2a_gateway_key_release(uuid) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_key_release(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_key_release(uuid) TO service_role;
COMMIT;
