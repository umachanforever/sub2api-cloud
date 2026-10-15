-- Install after gateway-billing.sql and gateway-accounts.sql.
BEGIN;
ALTER TABLE s2a_private.gateway_account_leases ADD COLUMN IF NOT EXISTS finish_fingerprint text;
ALTER TABLE s2a_private.gateway_account_leases ADD COLUMN IF NOT EXISTS finish_result jsonb;
ALTER TABLE s2a_private.gateway_account_leases ADD COLUMN IF NOT EXISTS completion jsonb;
ALTER TABLE public.usage_logs ADD COLUMN IF NOT EXISTS s2a_gateway_details jsonb NOT NULL DEFAULT '{}';
ALTER TABLE public.usage_logs ALTER COLUMN model TYPE varchar(200);
ALTER TABLE public.usage_logs ALTER COLUMN requested_model TYPE varchar(200);
ALTER TABLE public.usage_logs ALTER COLUMN upstream_model TYPE varchar(200);
ALTER FUNCTION public.invalidate_group_usage_rollup_state() SET search_path = pg_catalog, public, pg_temp;
ALTER FUNCTION public.invalidate_group_usage_rollup_state_after_insert() SET search_path = pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION public.s2a_gateway_finish(
    p_lease_id uuid, p_status integer, p_outcome text, p_usage jsonb,
    p_costs jsonb DEFAULT NULL, p_final boolean DEFAULT true,
    p_cooldown_seconds integer DEFAULT 0, p_credential_version bigint DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE lease s2a_private.gateway_account_leases; r s2a_private.gateway_requests;
    field text; value numeric; has_tokens boolean := false; fingerprint text;
    usage jsonb; costs jsonb; base_cost numeric := 0; actual_cost numeric := 0; account_cost numeric := 0;
    user_charge jsonb; account_charge jsonb; usage_id bigint; result jsonb;
    now_at timestamptz; cooldown_until timestamptz; version bigint; model text;
    timezone_name text; previous_timezone text; duration integer;
BEGIN
    IF p_lease_id IS NULL OR p_status IS NULL OR p_status NOT BETWEEN 100 AND 599
        OR p_outcome IS NULL OR p_outcome NOT IN ('completed','failed','incomplete','cancelled')
        OR p_final IS NULL OR p_cooldown_seconds IS NULL OR p_cooldown_seconds NOT BETWEEN 0 AND 604800
        OR (p_credential_version IS NOT NULL AND p_credential_version < 1)
        OR p_usage IS NULL OR jsonb_typeof(p_usage) <> 'object' THEN
        RETURN jsonb_build_object('error','invalid_completion','status',400);
    END IF;
    IF (p_outcome = 'completed' AND p_status NOT BETWEEN 200 AND 299)
        OR (p_cooldown_seconds > 0 AND p_status < 400) THEN
        RETURN jsonb_build_object('error','invalid_completion','status',400);
    END IF;
    IF NOT p_usage ?& ARRAY['input','output','cacheCreation','cacheRead']
        OR EXISTS(SELECT FROM jsonb_object_keys(p_usage) k WHERE k NOT IN ('input','output','cacheCreation','cacheRead','firstTokenMs','durationMs','stream')) THEN
        RETURN jsonb_build_object('error','invalid_usage','status',400);
    END IF;
    FOREACH field IN ARRAY ARRAY['input','output','cacheCreation','cacheRead','firstTokenMs','durationMs'] LOOP
        IF p_usage ? field AND p_usage->field <> 'null'::jsonb THEN
            IF jsonb_typeof(p_usage->field) <> 'number' THEN RETURN jsonb_build_object('error','invalid_usage','status',400); END IF;
            value := (p_usage->>field)::numeric;
            IF value < 0 OR value > 2147483647 OR trunc(value) <> value THEN RETURN jsonb_build_object('error','invalid_usage','status',400); END IF;
            IF field IN ('input','output','cacheCreation','cacheRead') AND value > 0 THEN has_tokens := true; END IF;
        END IF;
    END LOOP;
    IF p_usage ? 'stream' AND jsonb_typeof(p_usage->'stream') <> 'boolean' THEN RETURN jsonb_build_object('error','invalid_usage','status',400); END IF;
    usage := jsonb_build_object('input',p_usage->'input','output',p_usage->'output',
        'cacheCreation',p_usage->'cacheCreation','cacheRead',p_usage->'cacheRead',
        'firstTokenMs',p_usage->'firstTokenMs','durationMs',p_usage->'durationMs',
        'stream',coalesce((p_usage->>'stream')::boolean,false));
    IF p_costs IS NOT NULL THEN
        IF jsonb_typeof(p_costs) <> 'object' OR NOT p_costs ?& ARRAY['input','output','cacheCreation','cacheRead']
            OR EXISTS(SELECT FROM jsonb_object_keys(p_costs) k WHERE k NOT IN ('input','output','cacheCreation','cacheRead','accountStats')) THEN
            RETURN jsonb_build_object('error','invalid_costs','status',400);
        END IF;
        costs := '{}';
        FOREACH field IN ARRAY ARRAY['input','output','cacheCreation','cacheRead','accountStats'] LOOP
            IF field = 'accountStats' AND NOT p_costs ? field THEN CONTINUE; END IF;
            IF jsonb_typeof(p_costs->field) NOT IN ('number','string') OR p_costs->>field IS NULL
                OR p_costs->>field !~ '^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' THEN
                RETURN jsonb_build_object('error','invalid_costs','status',400);
            END IF;
            value := (p_costs->>field)::numeric;
            IF value >= 10000000000 THEN RETURN jsonb_build_object('error','invalid_costs','status',400); END IF;
            costs := costs || jsonb_build_object(field,trim_scale(value));
            IF field <> 'accountStats' THEN base_cost := base_cost + value; END IF;
        END LOOP;
        IF base_cost >= 10000000000 THEN RETURN jsonb_build_object('error','invalid_costs','status',400); END IF;
    END IF;
    IF NOT p_final AND (p_outcome <> 'failed' OR p_status < 400 OR has_tokens OR p_costs IS NOT NULL) THEN
        RETURN jsonb_build_object('error','invalid_retry_completion','status',400);
    END IF;
    SELECT * INTO lease FROM s2a_private.gateway_account_leases WHERE lease_id = p_lease_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','account_lease_not_found','status',404); END IF;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id = lease.request_id;
    PERFORM 1 FROM public.users WHERE id = r.user_id FOR UPDATE;
    SELECT * INTO r FROM s2a_private.gateway_requests WHERE request_id = lease.request_id FOR UPDATE;
    SELECT * INTO lease FROM s2a_private.gateway_account_leases WHERE lease_id = p_lease_id FOR UPDATE;
    model := r.policy->>'model';
    IF model IS NULL OR model = '' OR length(model) > 200 THEN RETURN jsonb_build_object('error','invalid_completion_policy','status',503); END IF;
    IF p_final AND model <> '__models__' AND p_costs IS NULL AND (p_outcome = 'completed' OR has_tokens) THEN
        RETURN jsonb_build_object('error','pricing_required','status',503);
    END IF;
    IF model = '__models__' AND (base_cost <> 0 OR has_tokens) THEN RETURN jsonb_build_object('error','invalid_metadata_usage','status',400); END IF;
    version := coalesce(p_credential_version,lease.credential_version);
    fingerprint := encode(sha256(convert_to(jsonb_build_array(p_lease_id,p_status,p_outcome,usage,costs,p_final,p_cooldown_seconds,version)::text,'UTF8')),'hex');
    IF lease.finish_fingerprint IS NOT NULL THEN
        IF lease.finish_fingerprint <> fingerprint THEN RETURN jsonb_build_object('error','completion_conflict','status',409); END IF;
        RETURN lease.finish_result || jsonb_build_object('applied',false);
    END IF;
    now_at := clock_timestamp();
    duration := coalesce((usage->>'durationMs')::integer,least(2147483647,greatest(0,floor(extract(epoch FROM now_at-lease.reserved_at)*1000)))::integer);
    timezone_name := coalesce(r.policy->>'timezone','Asia/Shanghai');
    IF NOT EXISTS(SELECT FROM pg_timezone_names WHERE name=timezone_name) THEN RETURN jsonb_build_object('error','invalid_completion_policy','status',503); END IF;
    previous_timezone := current_setting('TimeZone');
    PERFORM set_config('TimeZone',timezone_name,true);
    IF p_final AND model <> '__models__' AND p_costs IS NOT NULL THEN
        user_charge := s2a_private.gateway_charge_user(r.request_id,base_cost,fingerprint,timezone_name);
        IF user_charge->>'applied' <> 'true' THEN RAISE EXCEPTION 'billing_completion_conflict' USING ERRCODE = '23505'; END IF;
        account_charge := s2a_private.gateway_charge_account(p_lease_id,base_cost,now_at);
        IF account_charge->>'applied' <> 'true' THEN RAISE EXCEPTION 'account_completion_conflict' USING ERRCODE = '23505'; END IF;
        actual_cost := (user_charge->>'actual_cost')::numeric;
        account_cost := (account_charge->>'account_cost')::numeric;
        INSERT INTO public.usage_logs(user_id,api_key_id,account_id,request_id,model,requested_model,upstream_model,
            group_id,subscription_id,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,
            input_cost,output_cost,cache_creation_cost,cache_read_cost,total_cost,actual_cost,
            rate_multiplier,account_rate_multiplier,account_stats_cost,billing_type,billing_mode,stream,request_type,
            duration_ms,first_token_ms,created_at,s2a_gateway_details)
        VALUES(r.user_id,r.api_key_id,lease.account_id,r.request_id::text,model,model,coalesce(lease.policy->>'upstream_model',model),
            r.group_id,(r.policy->>'subscription_id')::bigint,coalesce((usage->>'input')::integer,0),coalesce((usage->>'output')::integer,0),
            coalesce((usage->>'cacheCreation')::integer,0),coalesce((usage->>'cacheRead')::integer,0),
            (costs->>'input')::numeric,(costs->>'output')::numeric,(costs->>'cacheCreation')::numeric,(costs->>'cacheRead')::numeric,base_cost,actual_cost,
            coalesce(r.policy->>'token_rate_multiplier',r.policy->>'rate_multiplier')::numeric,(lease.policy->>'account_rate_multiplier')::numeric,
            coalesce((costs->>'accountStats')::numeric,account_cost),CASE WHEN r.policy->>'subscription_type'='subscription' THEN 1 ELSE 0 END,'token',
            (usage->>'stream')::boolean,CASE WHEN (usage->>'stream')::boolean THEN 2 ELSE 1 END,duration,(usage->>'firstTokenMs')::integer,now_at,
            jsonb_build_object('lease_id',p_lease_id::text,'status',p_status,'outcome',p_outcome,'usage',usage,'costs',costs))
        RETURNING id INTO usage_id;
        INSERT INTO public.billing_usage_entries(usage_log_id,user_id,api_key_id,subscription_id,billing_type,delta_usd)
        VALUES(usage_id,r.user_id,r.api_key_id,(r.policy->>'subscription_id')::bigint,
            CASE WHEN r.policy->>'subscription_type'='subscription' THEN 1 ELSE 0 END,actual_cost);
    END IF;
    IF p_cooldown_seconds > 0 THEN
        cooldown_until := now_at + make_interval(secs=>p_cooldown_seconds);
        UPDATE s2a_private.accounts SET
            rate_limited_at = CASE WHEN p_status=429 THEN now_at ELSE rate_limited_at END,
            rate_limit_reset_at = CASE WHEN p_status=429 THEN greatest(rate_limit_reset_at,cooldown_until) ELSE rate_limit_reset_at END,
            overload_until = CASE WHEN p_status=529 THEN greatest(overload_until,cooldown_until) ELSE overload_until END,
            temp_unschedulable_until = CASE WHEN p_status NOT IN (429,529) THEN greatest(temp_unschedulable_until,cooldown_until) ELSE temp_unschedulable_until END,
            temp_unschedulable_reason = CASE WHEN p_status NOT IN (429,529) THEN 'cloud_upstream_'||p_status::text ELSE temp_unschedulable_reason END
        WHERE id=lease.account_id AND deleted_at IS NULL AND s2a_credential_version=version;
    END IF;
    IF model <> '__models__' THEN
        INSERT INTO s2a_private.gateway_account_stats AS stats(account_id,error_rate,ttft_ms,samples,updated_at)
        VALUES(lease.account_id,CASE WHEN p_outcome='completed' THEN 0.0 ELSE 0.2 END,
            nullif((usage->>'firstTokenMs')::double precision,0),1,now_at)
        ON CONFLICT(account_id) DO UPDATE SET
            error_rate=0.8*stats.error_rate+excluded.error_rate,
            ttft_ms=CASE WHEN excluded.ttft_ms IS NULL THEN stats.ttft_ms
                WHEN stats.ttft_ms IS NULL THEN excluded.ttft_ms
                ELSE 0.2*excluded.ttft_ms+0.8*stats.ttft_ms END,
            samples=stats.samples+1,updated_at=excluded.updated_at;
    END IF;
    result := jsonb_build_object('applied',true,'usage_log_id',usage_id::text,'actual_cost',actual_cost::text,'account_cost',account_cost::text,'final',p_final);
    UPDATE s2a_private.gateway_account_leases SET released_at=coalesce(released_at,now_at),finish_fingerprint=fingerprint,finish_result=result,
        completion=jsonb_build_object('status',p_status,'outcome',p_outcome,'usage',usage,'costs',costs,'final',p_final)
    WHERE lease_id=p_lease_id;
    IF p_final THEN UPDATE s2a_private.gateway_requests SET finished_at=coalesce(finished_at,now_at) WHERE request_id=r.request_id; END IF;
    PERFORM set_config('TimeZone',previous_timezone,true);
    RETURN result;
END $$;
ALTER FUNCTION public.s2a_gateway_finish(uuid,integer,text,jsonb,jsonb,boolean,integer,bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_finish(uuid,integer,text,jsonb,jsonb,boolean,integer,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_finish(uuid,integer,text,jsonb,jsonb,boolean,integer,bigint) TO service_role;
COMMIT;
