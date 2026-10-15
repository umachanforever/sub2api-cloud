-- Install after gateway-accounts.sql. Candidate reads never expose provider tokens.
BEGIN;
CREATE TABLE IF NOT EXISTS s2a_private.gateway_account_waiters (
    request_id uuid PRIMARY KEY REFERENCES s2a_private.gateway_requests(request_id),
    account_id bigint NOT NULL,
    queued_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL
);
ALTER TABLE s2a_private.gateway_account_waiters OWNER TO s2a_management;
ALTER TABLE s2a_private.gateway_account_waiters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE s2a_private.gateway_account_waiters FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS gateway_account_waiters_active ON s2a_private.gateway_account_waiters(account_id,expires_at);

CREATE OR REPLACE FUNCTION public.s2a_gateway_scheduler_settings() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) FROM public.settings
    WHERE key=ANY(ARRAY[
        'openai_low_upstream_rate_priority_enabled',
        'openai_oauth_scheduling_rate_multiplier',
        'openai_advanced_scheduler_enabled',
        'openai_advanced_scheduler_sticky_weighted_enabled',
        'openai_advanced_scheduler_subscription_priority_enabled',
        'openai_advanced_scheduler_lb_top_k',
        'openai_advanced_scheduler_weight_priority',
        'openai_advanced_scheduler_weight_load',
        'openai_advanced_scheduler_weight_queue',
        'openai_advanced_scheduler_weight_error_rate',
        'openai_advanced_scheduler_weight_ttft',
        'openai_advanced_scheduler_weight_reset',
        'openai_advanced_scheduler_weight_quota_headroom',
        'openai_advanced_scheduler_weight_upstream_cost',
        'openai_advanced_scheduler_weight_previous_response',
        'openai_advanced_scheduler_weight_session_sticky'
    ]);
$$;
ALTER FUNCTION public.s2a_gateway_scheduler_settings() OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_scheduler_settings() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_scheduler_settings() TO service_role;

CREATE OR REPLACE FUNCTION s2a_private.gateway_scheduler_extra(p_extra jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(p_extra)
        WHERE key=ANY(ARRAY['openai_passthrough','openai_oauth_passthrough','openai_compact_mode','openai_compact_supported',
            'codex_usage_updated_at','codex_5h_used_percent','codex_7d_used_percent',
            'codex_primary_used_percent','codex_secondary_used_percent','codex_primary_window_minutes',
            'codex_secondary_window_minutes','codex_5h_reset_at','codex_7d_reset_at',
            'codex_primary_reset_at','codex_secondary_reset_at','codex_5h_reset_after_seconds',
            'codex_7d_reset_after_seconds','codex_primary_reset_after_seconds','codex_secondary_reset_after_seconds'])), '{}'::jsonb)
    || CASE WHEN jsonb_typeof(p_extra->'upstream_billing_probe')='object' THEN jsonb_build_object('upstream_billing_probe',
        coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(p_extra->'upstream_billing_probe')
            WHERE key=ANY(ARRAY['status','received_at','fresh_until','next_probe_at'])), '{}'::jsonb)
        || jsonb_build_object('data',CASE WHEN jsonb_typeof(p_extra->'upstream_billing_probe'->'data')='object' THEN
            coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(p_extra->'upstream_billing_probe'->'data')
                WHERE key=ANY(ARRAY['billing_scope','resolved_rate_multiplier','peak_rate_enabled',
                    'peak_start','peak_end','peak_rate_multiplier','timezone'])), '{}'::jsonb)
            ELSE '{}'::jsonb END)) ELSE '{}'::jsonb END;
$$;
ALTER FUNCTION s2a_private.gateway_scheduler_extra(jsonb) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.gateway_scheduler_extra(jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.s2a_gateway_candidates(
    p_request_id uuid,p_after_id bigint DEFAULT 0,p_limit integer DEFAULT 128,p_excluded bigint[] DEFAULT '{}'
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE r s2a_private.gateway_requests; g public.groups; candidates jsonb; last_id bigint; now_at timestamptz:=statement_timestamp();
BEGIN
    IF p_request_id IS NULL OR p_after_id IS NULL OR p_after_id<0 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 256
        OR cardinality(coalesce(p_excluded,'{}'))>256 OR array_position(p_excluded,NULL) IS NOT NULL THEN
        RETURN jsonb_build_object('error','invalid_candidate_query','status',400);
    END IF;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id=p_request_id;
    IF NOT FOUND OR r.finished_at IS NOT NULL OR r.expires_at<=now_at THEN RETURN jsonb_build_object('error','request_lease_expired','status',409); END IF;
    IF NOT EXISTS(SELECT FROM public.users WHERE id=r.user_id AND deleted_at IS NULL AND status='active') THEN
        RETURN jsonb_build_object('error','user_disabled','status',403);
    END IF;
    IF NOT EXISTS(SELECT FROM public.api_keys WHERE id=r.api_key_id AND user_id=r.user_id AND group_id=r.group_id
        AND deleted_at IS NULL AND status='active' AND (expires_at IS NULL OR expires_at>now_at)) THEN
        RETURN jsonb_build_object('error','invalid_api_key','status',401);
    END IF;
    SELECT * INTO g FROM public.groups WHERE id=r.group_id AND deleted_at IS NULL AND status='active';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('error','group_unavailable','status',403);
    END IF;
    IF (g.is_exclusive OR (SELECT restrict_public_groups FROM public.users WHERE id=r.user_id))
        AND NOT EXISTS(SELECT FROM public.user_allowed_groups WHERE user_id=r.user_id AND group_id=g.id) THEN
        RETURN jsonb_build_object('error','group_forbidden','status',403);
    END IF;
    WITH pool AS MATERIALIZED (
        SELECT a.* FROM s2a_private.accounts a
        WHERE a.id>p_after_id AND a.deleted_at IS NULL AND a.status='active' AND a.schedulable
            AND NOT(a.id=ANY(coalesce(p_excluded,'{}')))
            AND NOT coalesce(a.auto_pause_on_expired AND a.expires_at<=now_at,false)
            AND (a.overload_until IS NULL OR a.overload_until<=now_at)
            AND (a.rate_limit_reset_at IS NULL OR a.rate_limit_reset_at<=now_at)
            AND (a.temp_unschedulable_until IS NULL OR a.temp_unschedulable_until<=now_at)
            AND (a.type NOT IN ('apikey','bedrock') OR NOT s2a_private.gateway_account_quota_exceeded(a.extra,now_at))
            AND (NOT g.require_oauth_only OR a.type<>'apikey')
            AND (NOT g.require_privacy_set OR (
                (a.platform<>'openai' OR coalesce(a.extra->>'privacy_mode','')='training_off')
                AND (a.platform<>'antigravity' OR coalesce(a.extra->>'privacy_mode','')='privacy_set')))
            AND EXISTS(SELECT FROM public.account_groups WHERE account_id=a.id AND group_id=r.group_id)
        ORDER BY a.id LIMIT p_limit
    ), candidate_rows AS (
        SELECT a.id,jsonb_build_object('id',a.id::text,'platform',a.platform,'type',a.type,
            'rate_multiplier',a.rate_multiplier::text,'priority',a.priority,'concurrency',a.concurrency,'load_factor',a.load_factor,'last_used_at',a.last_used_at,
            'session_window_end',a.session_window_end,'credential_version',a.s2a_credential_version,'parent_account_id',a.parent_account_id::text,
            'runtime_stats',jsonb_build_object('error_rate',coalesce(stats.error_rate,0),'ttft_ms',coalesce(stats.ttft_ms,0),
                'has_ttft',stats.ttft_ms IS NOT NULL,'samples',coalesce(stats.samples,0)::text),
            'waiting_count',(SELECT count(*) FROM s2a_private.gateway_account_waiters w JOIN s2a_private.gateway_requests wr ON wr.request_id=w.request_id WHERE w.account_id=a.id AND w.expires_at>now_at AND wr.finished_at IS NULL AND wr.expires_at>now_at),
            'active_slots',(SELECT count(*) FROM s2a_private.gateway_account_leases WHERE account_id=a.id AND released_at IS NULL AND expires_at>now_at),
            'credentials',jsonb_strip_nulls(jsonb_build_object('model_mapping',decoded.credentials->'model_mapping',
                'oauth_type',decoded.credentials->'oauth_type','project_id',decoded.credentials->'project_id','plan_type',decoded.credentials->'plan_type')),
            'extra',s2a_private.gateway_scheduler_extra(a.extra)) AS metadata
        FROM pool a JOIN public.accounts decoded ON decoded.id=a.id
        LEFT JOIN s2a_private.gateway_account_stats stats ON stats.account_id=a.id
    ) SELECT coalesce(jsonb_agg(metadata ORDER BY id),'[]'::jsonb),max(id) INTO candidates,last_id FROM candidate_rows;
    RETURN jsonb_build_object('candidates',candidates,'request_policy',r.policy,'scheduling_at',now_at,
        'next_after',CASE WHEN jsonb_array_length(candidates)=p_limit THEN last_id::text END);
END $$;
ALTER FUNCTION public.s2a_gateway_candidates(uuid,bigint,integer,bigint[]) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_candidates(uuid,bigint,integer,bigint[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_candidates(uuid,bigint,integer,bigint[]) TO service_role;
-- Serialize queue admission on the same account row used by slot reservation.
CREATE OR REPLACE FUNCTION public.s2a_gateway_account_wait(
    p_request_id uuid,p_account_id bigint,p_max_waiting integer,p_timeout_ms integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE r s2a_private.gateway_requests; w s2a_private.gateway_account_waiters;
    result jsonb; now_at timestamptz; waiting bigint;
BEGIN
    IF p_request_id IS NULL OR p_account_id IS NULL OR p_account_id<1
        OR p_max_waiting IS NULL OR p_max_waiting NOT BETWEEN 1 AND 100
        OR p_timeout_ms IS NULL OR p_timeout_ms NOT BETWEEN 1 AND 45000 THEN
        RETURN jsonb_build_object('error','invalid_wait_plan','status',400);
    END IF;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id=p_request_id FOR UPDATE;
    now_at:=clock_timestamp();
    IF NOT FOUND OR r.finished_at IS NOT NULL OR r.expires_at<=now_at THEN
        RETURN jsonb_build_object('error','request_lease_expired','status',409);
    END IF;
    PERFORM 1 FROM s2a_private.accounts WHERE id=p_account_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','account_unavailable','status',503); END IF;
    now_at:=clock_timestamp();
    IF r.expires_at<=now_at THEN RETURN jsonb_build_object('error','request_lease_expired','status',409); END IF;
    result:=public.s2a_gateway_candidates(p_request_id,p_account_id-1,1);
    IF result ? 'error' THEN RETURN result; END IF;
    IF result->'candidates'->0->>'id' IS DISTINCT FROM p_account_id::text THEN
        RETURN jsonb_build_object('error','account_unavailable','status',503);
    END IF;
    SELECT * INTO w FROM s2a_private.gateway_account_waiters WHERE request_id=p_request_id;
    IF FOUND THEN
        IF w.account_id<>p_account_id THEN RETURN jsonb_build_object('error','wait_plan_conflict','status',409); END IF;
        IF w.expires_at<=now_at THEN RETURN jsonb_build_object('error','account_wait_timeout','status',429); END IF;
        RETURN jsonb_build_object('account_id',w.account_id::text,'expires_at',w.expires_at);
    END IF;
    SELECT count(*) INTO waiting FROM s2a_private.gateway_account_waiters q
        JOIN s2a_private.gateway_requests qr ON qr.request_id=q.request_id
        WHERE q.account_id=p_account_id AND q.expires_at>now_at AND qr.finished_at IS NULL AND qr.expires_at>now_at;
    IF waiting>=p_max_waiting THEN RETURN jsonb_build_object('error','account_wait_queue_full','status',429); END IF;
    INSERT INTO s2a_private.gateway_account_waiters(request_id,account_id,queued_at,expires_at)
        VALUES(p_request_id,p_account_id,now_at,least(r.expires_at,now_at+make_interval(secs=>p_timeout_ms/1000.0))) RETURNING * INTO w;
    RETURN jsonb_build_object('account_id',w.account_id::text,'expires_at',w.expires_at);
END $$;
ALTER FUNCTION public.s2a_gateway_account_wait(uuid,bigint,integer,integer) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_account_wait(uuid,bigint,integer,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_account_wait(uuid,bigint,integer,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.s2a_gateway_account_wait_release(p_request_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    DELETE FROM s2a_private.gateway_account_waiters WHERE request_id=p_request_id;
    RETURN FOUND;
END $$;
ALTER FUNCTION public.s2a_gateway_account_wait_release(uuid) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_account_wait_release(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_account_wait_release(uuid) TO service_role;
COMMIT;
