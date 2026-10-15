-- Install after account-vault.sql and gateway-admission.sql.
BEGIN;
CREATE TABLE IF NOT EXISTS s2a_private.gateway_account_leases (
    lease_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id uuid NOT NULL REFERENCES s2a_private.gateway_requests(request_id),
    account_id bigint NOT NULL,
    credential_version bigint NOT NULL,
    policy jsonb NOT NULL,
    account_base_cost numeric,
    account_cost numeric,
    reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    released_at timestamptz
);
ALTER TABLE s2a_private.gateway_account_leases ADD COLUMN IF NOT EXISTS account_base_cost numeric;
ALTER TABLE s2a_private.gateway_account_leases ADD COLUMN IF NOT EXISTS account_cost numeric;
ALTER TABLE s2a_private.gateway_account_leases OWNER TO s2a_management;
ALTER TABLE s2a_private.gateway_account_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE s2a_private.gateway_account_leases FROM PUBLIC, anon, authenticated, service_role;
CREATE UNIQUE INDEX IF NOT EXISTS gateway_account_request_active ON s2a_private.gateway_account_leases(request_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS gateway_account_active ON s2a_private.gateway_account_leases(account_id, expires_at) WHERE released_at IS NULL;

-- Native scheduler EWMAs are shared across Edge workers and updated by finish.
CREATE TABLE IF NOT EXISTS s2a_private.gateway_account_stats (
    account_id bigint PRIMARY KEY,
    error_rate double precision NOT NULL CHECK(error_rate>=0 AND error_rate<=1),
    ttft_ms double precision CHECK(ttft_ms>0 AND ttft_ms<=2147483647),
    samples bigint NOT NULL CHECK(samples>0),
    updated_at timestamptz NOT NULL
);
ALTER TABLE s2a_private.gateway_account_stats OWNER TO s2a_management;
ALTER TABLE s2a_private.gateway_account_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE s2a_private.gateway_account_stats FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION s2a_private.gateway_account_quota_exceeded(p_extra jsonb, p_now timestamptz) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE dimension text; period_start timestamptz; last_reset timestamptz;
    tz text := coalesce(nullif(p_extra->>'quota_reset_timezone',''), 'UTC');
    local_reset timestamp; hour integer; day integer; days_back integer; seconds integer;
BEGIN
    IF coalesce((p_extra->>'quota_limit')::numeric,0) > 0
        AND coalesce((p_extra->>'quota_used')::numeric,0) >= (p_extra->>'quota_limit')::numeric THEN RETURN true; END IF;
    IF NOT EXISTS(SELECT FROM pg_timezone_names WHERE name = tz) THEN tz := 'UTC'; END IF;
    FOREACH dimension IN ARRAY ARRAY['daily','weekly'] LOOP
        IF coalesce((p_extra->>('quota_'||dimension||'_limit'))::numeric,0) <= 0 THEN CONTINUE; END IF;
        period_start := (p_extra->>('quota_'||dimension||'_start'))::timestamptz;
        IF period_start IS NULL THEN CONTINUE; END IF;
        IF p_extra->>('quota_'||dimension||'_reset_mode') = 'fixed' THEN
            hour := coalesce((p_extra->>('quota_'||dimension||'_reset_hour'))::integer,0);
            IF hour NOT BETWEEN 0 AND 23 THEN hour := 0; END IF;
            local_reset := date_trunc('day',p_now AT TIME ZONE tz) + make_interval(hours=>hour);
            IF dimension = 'weekly' THEN
                day := coalesce((p_extra->>'quota_weekly_reset_day')::integer,1);
                IF day NOT BETWEEN 0 AND 6 THEN day := 1; END IF;
                days_back := (extract(dow FROM p_now AT TIME ZONE tz)::integer - day + 7) % 7;
                IF days_back = 0 AND p_now < local_reset AT TIME ZONE tz THEN days_back := 7; END IF;
                local_reset := local_reset - make_interval(days=>days_back);
            ELSIF p_now < local_reset AT TIME ZONE tz THEN
                local_reset := local_reset - interval '1 day';
            END IF;
            last_reset := local_reset AT TIME ZONE tz;
            IF period_start < last_reset THEN CONTINUE; END IF;
        ELSE
            seconds := CASE WHEN dimension = 'daily' THEN 86400 ELSE 604800 END;
            IF period_start + make_interval(secs=>seconds) <= p_now THEN CONTINUE; END IF;
        END IF;
        IF coalesce((p_extra->>('quota_'||dimension||'_used'))::numeric,0) >= (p_extra->>('quota_'||dimension||'_limit'))::numeric THEN RETURN true; END IF;
    END LOOP;
    RETURN false;
END $$;
ALTER FUNCTION s2a_private.gateway_account_quota_exceeded(jsonb,timestamptz) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.gateway_account_quota_exceeded(jsonb,timestamptz) FROM PUBLIC, anon, authenticated, service_role;

-- The scheduler supplies a candidate; this operation revalidates and reserves its slot.
CREATE OR REPLACE FUNCTION public.s2a_gateway_account_reserve(p_request_id uuid, p_account_id bigint, p_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r s2a_private.gateway_requests; a s2a_private.accounts;
    existing s2a_private.gateway_account_leases; lease s2a_private.gateway_account_leases;
    g public.groups; now_at timestamptz; snapshot jsonb;
BEGIN
    IF p_request_id IS NULL OR p_account_id IS NULL OR p_version IS NULL OR p_version < 1 THEN
        RETURN jsonb_build_object('error','invalid_account_reservation','status',400);
    END IF;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id = p_request_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','request_lease_not_found','status',409); END IF;
    PERFORM 1 FROM public.users WHERE id = r.user_id AND deleted_at IS NULL AND status = 'active' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','user_disabled','status',403); END IF;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id = p_request_id FOR UPDATE;
    now_at := clock_timestamp();
    IF r.finished_at IS NOT NULL OR r.expires_at <= now_at THEN RETURN jsonb_build_object('error','request_lease_expired','status',409); END IF;
    IF NOT EXISTS(SELECT FROM public.api_keys WHERE id = r.api_key_id AND user_id = r.user_id AND group_id = r.group_id
        AND deleted_at IS NULL AND status = 'active' AND (expires_at IS NULL OR expires_at > now_at)) THEN
        RETURN jsonb_build_object('error','invalid_api_key','status',401);
    END IF;
    SELECT * INTO g FROM public.groups WHERE id = r.group_id AND deleted_at IS NULL AND status = 'active';
    IF NOT FOUND THEN RETURN jsonb_build_object('error','group_unavailable','status',403); END IF;
    IF (g.is_exclusive OR (SELECT restrict_public_groups FROM public.users WHERE id = r.user_id))
        AND NOT EXISTS(SELECT FROM public.user_allowed_groups WHERE user_id = r.user_id AND group_id = g.id) THEN
        RETURN jsonb_build_object('error','group_forbidden','status',403);
    END IF;
    SELECT * INTO existing FROM s2a_private.gateway_account_leases WHERE request_id = p_request_id AND released_at IS NULL FOR UPDATE;
    IF FOUND THEN
        IF existing.expires_at > now_at THEN
            IF existing.account_id <> p_account_id OR existing.credential_version <> p_version THEN
                RETURN jsonb_build_object('error','account_reservation_conflict','status',409);
            END IF;
        ELSE
            UPDATE s2a_private.gateway_account_leases SET released_at = now_at WHERE lease_id = existing.lease_id;
            existing := NULL;
        END IF;
    END IF;
    SELECT * INTO a FROM s2a_private.accounts WHERE id = p_account_id FOR UPDATE;
    now_at := clock_timestamp();
    IF r.expires_at <= now_at THEN RETURN jsonb_build_object('error','request_lease_expired','status',409); END IF;
    IF NOT FOUND OR a.deleted_at IS NOT NULL OR a.status <> 'active' OR NOT a.schedulable
        OR (a.auto_pause_on_expired AND a.expires_at <= now_at)
        OR a.overload_until > now_at OR a.rate_limit_reset_at > now_at OR a.temp_unschedulable_until > now_at
        OR NOT EXISTS(SELECT FROM public.account_groups WHERE account_id = a.id AND group_id = g.id) THEN
        RETURN jsonb_build_object('error','account_unavailable','status',503);
    END IF;
    IF a.s2a_credential_version <> p_version THEN RETURN jsonb_build_object('error','account_credentials_changed','status',409); END IF;
    IF g.platform <> a.platform THEN RETURN jsonb_build_object('error','account_platform_mismatch','status',503); END IF;
    IF (g.require_oauth_only AND a.type = 'apikey') OR (g.require_privacy_set AND (
        (a.platform = 'openai' AND coalesce(a.extra->>'privacy_mode','') <> 'training_off')
        OR (a.platform = 'antigravity' AND coalesce(a.extra->>'privacy_mode','') <> 'privacy_set'))) THEN
        RETURN jsonb_build_object('error','account_policy_forbidden','status',503);
    END IF;
    IF a.type IN ('apikey','bedrock') AND s2a_private.gateway_account_quota_exceeded(a.extra,now_at) THEN
        RETURN jsonb_build_object('error','account_quota_exceeded','status',503);
    END IF;
    IF existing.lease_id IS NOT NULL THEN
        lease := existing;
    ELSE
        IF (SELECT count(*) FROM s2a_private.gateway_account_leases WHERE account_id = a.id AND released_at IS NULL AND expires_at > now_at) >= greatest(a.concurrency,1) THEN
            RETURN jsonb_build_object('error','account_concurrency_exceeded','status',429);
        END IF;
        snapshot := jsonb_build_object('account_id',a.id::text,'proxy_id',a.proxy_id::text,
            'platform',a.platform,'type',a.type,'account_rate_multiplier',a.rate_multiplier::text,
            'credential_version',a.s2a_credential_version,
            'account_quota_enabled',coalesce((a.extra->>'quota_limit')::numeric,0) > 0
                OR coalesce((a.extra->>'quota_daily_limit')::numeric,0) > 0
                OR coalesce((a.extra->>'quota_weekly_limit')::numeric,0) > 0);
        INSERT INTO s2a_private.gateway_account_leases(request_id,account_id,credential_version,policy,reserved_at,expires_at)
        VALUES(p_request_id,a.id,a.s2a_credential_version,snapshot,now_at,r.expires_at) RETURNING * INTO lease;
        UPDATE s2a_private.accounts SET last_used_at = now_at WHERE id = a.id;
    END IF;
    snapshot := public.s2a_gateway_account_snapshot(a.id);
    IF snapshot ? 'error' THEN RAISE EXCEPTION 'reserved_account_unavailable'; END IF;
    RETURN jsonb_build_object('lease_id',lease.lease_id::text,'request_id',p_request_id::text,
        'account',snapshot || jsonb_build_object('proxy_id',lease.policy->'proxy_id'), 'policy',lease.policy,'request_policy',r.policy);
END $$;
ALTER FUNCTION public.s2a_gateway_account_reserve(uuid,bigint,bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_account_reserve(uuid,bigint,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_account_reserve(uuid,bigint,bigint) TO service_role;

-- Bind the native model decision before provider dispatch; replays cannot change it.
CREATE OR REPLACE FUNCTION public.s2a_gateway_account_route(p_lease_id uuid,p_version bigint,p_route jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE lease s2a_private.gateway_account_leases; r s2a_private.gateway_requests;
    field text; route jsonb; now_at timestamptz;
BEGIN
    IF p_lease_id IS NULL OR p_version IS NULL OR p_version<1 OR p_route IS NULL
        OR jsonb_typeof(p_route)<>'object'
        OR NOT p_route ?& ARRAY['upstream_model','channel_model','protocol','stream']
        OR EXISTS(SELECT FROM jsonb_object_keys(p_route) k WHERE k NOT IN
            ('upstream_model','channel_model','protocol','stream','service_tier','reasoning_effort')) THEN
        RETURN jsonb_build_object('error','invalid_account_route','status',400);
    END IF;
    FOREACH field IN ARRAY ARRAY['upstream_model','channel_model'] LOOP
        IF jsonb_typeof(p_route->field)<>'string' OR length(p_route->>field) NOT BETWEEN 1 AND 200
            OR p_route->>field ~ '[[:cntrl:]]' THEN
            RETURN jsonb_build_object('error','invalid_account_route','status',400);
        END IF;
    END LOOP;
    IF jsonb_typeof(p_route->'protocol')<>'string' OR p_route->>'protocol' NOT IN ('models','responses','chat','messages','gemini')
        OR jsonb_typeof(p_route->'stream')<>'boolean' THEN
        RETURN jsonb_build_object('error','invalid_account_route','status',400);
    END IF;
    FOREACH field IN ARRAY ARRAY['service_tier','reasoning_effort'] LOOP
        IF p_route ? field AND p_route->field<>'null'::jsonb AND
            (jsonb_typeof(p_route->field)<>'string' OR length(p_route->>field)>100 OR p_route->>field ~ '[[:cntrl:]]') THEN
            RETURN jsonb_build_object('error','invalid_account_route','status',400);
        END IF;
    END LOOP;
    route := p_route || jsonb_build_object('service_tier',p_route->'service_tier','reasoning_effort',p_route->'reasoning_effort');
    SELECT * INTO lease FROM s2a_private.gateway_account_leases WHERE lease_id=p_lease_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','account_lease_not_found','status',404); END IF;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id=lease.request_id;
    PERFORM 1 FROM public.users WHERE id=r.user_id AND deleted_at IS NULL AND status='active' FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','user_disabled','status',403); END IF;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id=lease.request_id FOR UPDATE;
    SELECT * INTO lease FROM s2a_private.gateway_account_leases WHERE lease_id=p_lease_id FOR UPDATE;
    now_at := clock_timestamp();
    IF r.finished_at IS NOT NULL OR r.expires_at<=now_at OR lease.released_at IS NOT NULL OR lease.expires_at<=now_at THEN
        RETURN jsonb_build_object('error','request_lease_expired','status',409);
    END IF;
    IF NOT EXISTS(SELECT FROM public.api_keys WHERE id=r.api_key_id AND user_id=r.user_id AND group_id=r.group_id
        AND deleted_at IS NULL AND status='active' AND (expires_at IS NULL OR expires_at>now_at)) THEN
        RETURN jsonb_build_object('error','invalid_api_key','status',401);
    END IF;
    IF NOT EXISTS(SELECT FROM public.groups g WHERE g.id=r.group_id AND g.deleted_at IS NULL AND g.status='active'
        AND (NOT (g.is_exclusive OR (SELECT restrict_public_groups FROM public.users WHERE id=r.user_id))
            OR EXISTS(SELECT FROM public.user_allowed_groups WHERE user_id=r.user_id AND group_id=g.id))) THEN
        RETURN jsonb_build_object('error','group_forbidden','status',403);
    END IF;
    IF lease.credential_version<>p_version OR NOT EXISTS(SELECT FROM s2a_private.accounts
        WHERE id=lease.account_id AND deleted_at IS NULL AND s2a_credential_version=p_version) THEN
        RETURN jsonb_build_object('error','account_credentials_changed','status',409);
    END IF;
    IF (r.policy->>'model'='__models__') IS DISTINCT FROM (route->>'protocol'='models')
        OR (route->>'protocol'='models' AND (route->>'stream')::boolean) THEN
        RETURN jsonb_build_object('error','account_route_mismatch','status',409);
    END IF;
    IF lease.policy ? 'route' THEN
        IF lease.policy->'route'<>route THEN RETURN jsonb_build_object('error','account_route_conflict','status',409); END IF;
    ELSE
        UPDATE s2a_private.gateway_account_leases SET policy=policy || jsonb_build_object(
            'route',route,'upstream_model',route->'upstream_model','channel_model',route->'channel_model')
        WHERE lease_id=p_lease_id RETURNING * INTO lease;
    END IF;
    RETURN jsonb_build_object('lease_id',lease.lease_id::text,'request_id',lease.request_id::text,
        'account_id',lease.account_id::text,'credential_version',lease.credential_version,'policy',lease.policy);
END $$;
ALTER FUNCTION public.s2a_gateway_account_route(uuid,bigint,jsonb) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_account_route(uuid,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_account_route(uuid,bigint,jsonb) TO service_role;

-- Abandoning a request releases both admission and account slots atomically.
CREATE OR REPLACE FUNCTION public.s2a_gateway_key_release(p_request_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r s2a_private.gateway_requests; now_at timestamptz;
BEGIN
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id=p_request_id;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM 1 FROM public.users WHERE id=r.user_id FOR UPDATE;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id=p_request_id FOR UPDATE;
    IF r.finished_at IS NOT NULL THEN RETURN false; END IF;
    now_at := clock_timestamp();
    UPDATE s2a_private.gateway_account_leases SET released_at=now_at WHERE request_id=p_request_id AND released_at IS NULL;
    UPDATE s2a_private.gateway_requests SET finished_at=now_at WHERE request_id=p_request_id;
    RETURN true;
END $$;
ALTER FUNCTION public.s2a_gateway_key_release(uuid) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_key_release(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_key_release(uuid) TO service_role;

CREATE OR REPLACE FUNCTION s2a_private.gateway_charge_account(p_lease_id uuid, p_base_cost numeric, p_now timestamptz DEFAULT clock_timestamp()) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
<<account_charge>>
DECLARE lease s2a_private.gateway_account_leases; extra jsonb; cost numeric;
    dimension text; expired boolean; seconds integer; period_start timestamptz;
    tz text; reset_local timestamp; next_reset timestamptz; hour integer; day integer; days_forward integer;
    now_text text;
BEGIN
    IF p_base_cost IS NULL OR p_base_cost < 0 OR p_base_cost::text IN ('NaN','Infinity','-Infinity')
        OR p_base_cost >= 1000000000000 OR p_now IS NULL OR NOT isfinite(p_now) THEN
        RAISE EXCEPTION 'invalid_account_charge' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO lease FROM s2a_private.gateway_account_leases WHERE lease_id = p_lease_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'account_lease_not_found' USING ERRCODE = '22023'; END IF;
    IF lease.account_cost IS NOT NULL THEN
        IF lease.account_base_cost IS DISTINCT FROM p_base_cost THEN RAISE EXCEPTION 'account_billing_conflict' USING ERRCODE = '23505'; END IF;
        RETURN jsonb_build_object('applied',false,'account_cost',lease.account_cost::text);
    END IF;
    cost := round(p_base_cost * (lease.policy->>'account_rate_multiplier')::numeric,8);
    IF cost IS NULL OR cost < 0 OR cost >= 1000000000000 OR cost::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'invalid_account_billing_policy' USING ERRCODE = '22023';
    END IF;
    IF cost > 0 AND lease.policy->>'type' IN ('apikey','bedrock') AND coalesce((lease.policy->>'account_quota_enabled')::boolean,false) THEN
        SELECT a.extra INTO extra FROM s2a_private.accounts a WHERE id = lease.account_id AND deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'billing_account_not_found'; END IF;
        extra := coalesce(extra,'{}') || jsonb_build_object('quota_used',coalesce((extra->>'quota_used')::numeric,0)+cost);
        tz := coalesce(nullif(extra->>'quota_reset_timezone',''),'UTC');
        now_text := to_char(p_now AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
        FOREACH dimension IN ARRAY ARRAY['daily','weekly'] LOOP
            IF coalesce((extra->>('quota_'||dimension||'_limit'))::numeric,0) <= 0 THEN CONTINUE; END IF;
            period_start := (extra->>('quota_'||dimension||'_start'))::timestamptz;
            seconds := CASE WHEN dimension = 'daily' THEN 86400 ELSE 604800 END;
            IF extra->>('quota_'||dimension||'_reset_mode') = 'fixed' THEN
                expired := p_now >= coalesce((extra->>('quota_'||dimension||'_reset_at'))::timestamptz,'1970-01-01'::timestamptz);
                IF expired THEN
                    hour := coalesce((extra->>('quota_'||dimension||'_reset_hour'))::integer,0);
                    reset_local := date_trunc('day',p_now AT TIME ZONE tz) + make_interval(hours=>hour);
                    IF dimension = 'weekly' THEN
                        day := coalesce((extra->>'quota_weekly_reset_day')::integer,1);
                        days_forward := (day-extract(dow FROM p_now AT TIME ZONE tz)::integer+7)%7;
                        IF days_forward = 0 AND p_now >= reset_local AT TIME ZONE tz THEN days_forward := 7; END IF;
                        reset_local := reset_local + make_interval(days=>days_forward);
                    ELSIF p_now >= reset_local AT TIME ZONE tz THEN reset_local := reset_local + interval '1 day';
                    END IF;
                    next_reset := reset_local AT TIME ZONE tz;
                    extra := extra || jsonb_build_object('quota_'||dimension||'_reset_at',to_char(next_reset AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'));
                END IF;
            ELSE
                expired := coalesce(period_start,'1970-01-01'::timestamptz)+make_interval(secs=>seconds) <= p_now;
            END IF;
            extra := extra || jsonb_build_object(
                'quota_'||dimension||'_used', CASE WHEN expired THEN cost ELSE coalesce((extra->>('quota_'||dimension||'_used'))::numeric,0)+cost END,
                'quota_'||dimension||'_start',CASE WHEN expired OR period_start IS NULL THEN now_text ELSE extra->>('quota_'||dimension||'_start') END);
        END LOOP;
        UPDATE s2a_private.accounts SET extra = account_charge.extra, updated_at = p_now WHERE id = lease.account_id;
    END IF;
    UPDATE s2a_private.gateway_account_leases SET account_base_cost = p_base_cost, account_cost = cost WHERE lease_id = p_lease_id;
    RETURN jsonb_build_object('applied',true,'account_cost',cost::text);
END $$;
ALTER FUNCTION s2a_private.gateway_charge_account(uuid,numeric,timestamptz) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.gateway_charge_account(uuid,numeric,timestamptz) FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
