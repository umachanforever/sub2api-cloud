-- Install after native business migrations and account-vault.sql.
BEGIN;
CREATE TABLE IF NOT EXISTS s2a_private.personal_gateway_leases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id uuid NOT NULL,
    user_id bigint NOT NULL, key_id bigint NOT NULL, group_id bigint NOT NULL,
    account_id bigint NOT NULL, credential_version bigint NOT NULL,
    model text NOT NULL, stream boolean NOT NULL, fingerprint text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL, finished_at timestamptz,
    completion_hash text, completion jsonb
);
ALTER TABLE s2a_private.personal_gateway_leases ADD COLUMN IF NOT EXISTS count_only boolean NOT NULL DEFAULT false;
ALTER TABLE s2a_private.personal_gateway_leases ADD COLUMN IF NOT EXISTS web_search boolean NOT NULL DEFAULT false;
ALTER TABLE s2a_private.personal_gateway_leases ADD COLUMN IF NOT EXISTS search_operation text;
ALTER TABLE s2a_private.personal_gateway_leases OWNER TO s2a_management;
ALTER TABLE s2a_private.personal_gateway_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.personal_gateway_leases FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS personal_gateway_account_slots ON s2a_private.personal_gateway_leases(account_id,expires_at) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS personal_gateway_request ON s2a_private.personal_gateway_leases(request_id);
ALTER FUNCTION public.invalidate_group_usage_rollup_state() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.invalidate_group_usage_rollup_state_after_insert() SET search_path=pg_catalog,public,pg_temp;
ALTER TABLE public.usage_logs ALTER COLUMN model TYPE varchar(200);
ALTER TABLE public.usage_logs ALTER COLUMN requested_model TYPE varchar(200);
ALTER TABLE public.usage_logs ALTER COLUMN upstream_model TYPE varchar(200);
ALTER TABLE public.usage_logs ADD COLUMN IF NOT EXISTS s2a_personal_details jsonb;

CREATE OR REPLACE FUNCTION public.s2a_personal_acquire(
    p_key_hash text,p_model text,p_request_id uuid,p_excluded bigint[] DEFAULT '{}',
    p_count_request boolean DEFAULT true,p_client_ip text DEFAULT NULL,p_billing_context jsonb DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE identity jsonb; k public.api_keys; g public.groups; a s2a_private.accounts;
    lease s2a_private.personal_gateway_leases; address inet; network text; pattern text;
    allowed boolean; fingerprint text; now_at timestamptz; account jsonb; cache_binding jsonb; bound_account_id bigint;
BEGIN
    IF p_request_id IS NULL OR p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 200
        OR p_model ~ '[[:cntrl:]]' OR cardinality(p_excluded)>3 OR array_position(p_excluded,NULL) IS NOT NULL
        OR jsonb_typeof(p_billing_context)<>'object' THEN RETURN jsonb_build_object('error','invalid_request','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',CASE WHEN identity->>'error'='invalid_api_key' THEN 401 ELSE 403 END); END IF;
    PERFORM 1 FROM public.users WHERE id=(identity->>'user_id')::bigint FOR UPDATE;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',CASE WHEN identity->>'error'='invalid_api_key' THEN 401 ELSE 403 END); END IF;
    SELECT * INTO k FROM public.api_keys WHERE id=(identity->>'key_id')::bigint;
    SELECT * INTO g FROM public.groups WHERE id=k.group_id;
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
    IF p_billing_context ? 'cached_content' THEN
        cache_binding:=public.s2a_personal_cache_resolve(p_key_hash,p_billing_context->>'cached_content',p_model,p_client_ip);
        IF cache_binding ? 'error' THEN RETURN cache_binding; END IF;
        bound_account_id:=(cache_binding->>'account_id')::bigint;
    END IF;
    fingerprint:=encode(sha256(convert_to(jsonb_build_array(p_key_hash,p_model,p_client_ip,p_billing_context)::text,'UTF8')),'hex');
    SELECT * INTO lease FROM s2a_private.personal_gateway_leases WHERE request_id=p_request_id ORDER BY created_at DESC LIMIT 1;
    IF FOUND THEN
        IF lease.fingerprint<>fingerprint THEN RETURN jsonb_build_object('error','request_conflict','status',409); END IF;
        IF lease.finished_at IS NOT NULL AND NOT (lease.account_id=ANY(coalesce(p_excluded,'{}')) AND lease.completion->>'outcome'='failed') THEN
            RETURN jsonb_build_object('error','request_finished','status',409);
        END IF;
        IF lease.finished_at IS NULL AND lease.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('error','request_expired','status',409); END IF;
    END IF;
    IF lease.id IS NULL OR lease.finished_at IS NOT NULL THEN
        lease:=NULL;
        FOR a IN SELECT accounts.* FROM s2a_private.accounts accounts
            JOIN public.account_groups ag ON ag.account_id=accounts.id AND ag.group_id=g.id
            WHERE accounts.deleted_at IS NULL AND accounts.status='active' AND accounts.schedulable
                AND accounts.platform=g.platform AND NOT(accounts.id=ANY(coalesce(p_excluded,'{}')))
                AND (bound_account_id IS NULL OR accounts.id=bound_account_id)
                AND NOT coalesce(accounts.auto_pause_on_expired AND accounts.expires_at<=clock_timestamp(),false)
                AND coalesce(accounts.overload_until,'-infinity')<=clock_timestamp()
                AND coalesce(accounts.rate_limit_reset_at,'-infinity')<=clock_timestamp()
                AND coalesce(accounts.temp_unschedulable_until,'-infinity')<=clock_timestamp()
                AND (NOT g.require_oauth_only OR accounts.type<>'apikey')
                AND (NOT g.require_privacy_set OR (accounts.platform<>'openai' OR accounts.extra->>'privacy_mode'='training_off'))
            ORDER BY accounts.priority,accounts.last_used_at NULLS FIRST,accounts.id
            FOR UPDATE OF accounts LOOP
            now_at:=clock_timestamp();
            IF (SELECT count(*) FROM s2a_private.personal_gateway_leases WHERE account_id=a.id AND finished_at IS NULL AND expires_at>now_at)>=greatest(a.concurrency,1) THEN CONTINUE; END IF;
            INSERT INTO s2a_private.personal_gateway_leases(request_id,user_id,key_id,group_id,account_id,credential_version,model,stream,fingerprint,expires_at,count_only,web_search,search_operation)
                VALUES(p_request_id,k.user_id,k.id,g.id,a.id,a.s2a_credential_version,p_model,coalesce((p_billing_context->>'native_stream')::boolean,false),fingerprint,now_at+interval '150 seconds',coalesce((p_billing_context->>'count_only')::boolean,false),coalesce((p_billing_context->>'web_search')::boolean,false),CASE WHEN p_billing_context->>'search_operation' IN ('web_search','x_search') THEN p_billing_context->>'search_operation' ELSE 'alpha_search' END) RETURNING * INTO lease;
            UPDATE s2a_private.accounts SET last_used_at=now_at WHERE id=a.id;
            EXIT;
        END LOOP;
        IF lease.id IS NULL THEN RETURN jsonb_build_object('error','no_available_account','status',503); END IF;
    END IF;
    account:=public.s2a_gateway_account_snapshot(lease.account_id);
    IF account ? 'error' THEN RETURN account || jsonb_build_object('status',503); END IF;
    IF (account->>'credential_version')::bigint<>lease.credential_version THEN RETURN jsonb_build_object('error','account_credentials_changed','status',409); END IF;
    SELECT * INTO a FROM s2a_private.accounts WHERE id=lease.account_id;
    RETURN jsonb_build_object('lease_id',lease.id::text,'account',account || jsonb_build_object('proxy_id',a.proxy_id::text),
        'model_allowlist',g.model_allowlist,'model_sources',jsonb_build_object('mapping',coalesce(account->'credentials'->'model_mapping','{}'),'include_upstream',true));
END $$;
ALTER FUNCTION public.s2a_personal_acquire(text,text,uuid,bigint[],boolean,text,jsonb) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_acquire(text,text,uuid,bigint[],boolean,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_acquire(text,text,uuid,bigint[],boolean,text,jsonb) TO service_role;
CREATE OR REPLACE FUNCTION public.s2a_personal_finish(
    p_lease_id uuid,p_status integer,p_outcome text,p_input_tokens integer,p_output_tokens integer,
    p_cache_creation_tokens integer,p_cache_read_tokens integer,p_cooldown_seconds integer,
    p_credential_version bigint,p_first_token_ms integer DEFAULT NULL,p_upstream_model text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE lease s2a_private.personal_gateway_leases; payload jsonb; digest text; usage_id bigint; now_at timestamptz;
BEGIN
    IF p_lease_id IS NULL OR p_status IS NULL OR p_status NOT BETWEEN 100 AND 599
        OR p_outcome IS NULL OR p_outcome NOT IN ('completed','failed','cancelled','interrupted')
        OR coalesce(p_input_tokens,0)<0 OR coalesce(p_output_tokens,0)<0
        OR coalesce(p_cache_creation_tokens,0)<0 OR coalesce(p_cache_read_tokens,0)<0
        OR coalesce(p_first_token_ms,0)<0 OR p_cooldown_seconds IS NULL OR p_cooldown_seconds NOT BETWEEN 0 AND 3600
        OR (p_upstream_model IS NOT NULL AND (length(p_upstream_model) NOT BETWEEN 1 AND 200 OR p_upstream_model ~ '[[:cntrl:]]')) THEN
        RETURN jsonb_build_object('error','invalid_usage','status',400);
    END IF;
    payload:=jsonb_build_object('status',p_status,'outcome',p_outcome,'input',p_input_tokens,'output',p_output_tokens,
        'cacheCreation',p_cache_creation_tokens,'cacheRead',p_cache_read_tokens,'firstTokenMs',p_first_token_ms,
        'cooldown',p_cooldown_seconds,'credentialVersion',p_credential_version,'upstreamModel',p_upstream_model);
    digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
    SELECT * INTO lease FROM s2a_private.personal_gateway_leases WHERE id=p_lease_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','lease_not_found','status',404); END IF;
    IF lease.finished_at IS NOT NULL THEN
        IF lease.completion_hash<>digest THEN RETURN jsonb_build_object('error','completion_conflict','status',409); END IF;
        RETURN jsonb_build_object('applied',false);
    END IF;
    now_at:=clock_timestamp();
    IF NOT lease.count_only AND lease.model<>'__models__' AND (p_outcome='completed' OR coalesce(p_input_tokens,0)+coalesce(p_output_tokens,0)::bigint+coalesce(p_cache_creation_tokens,0)::bigint+coalesce(p_cache_read_tokens,0)::bigint>0) THEN
        INSERT INTO public.usage_logs(user_id,api_key_id,account_id,group_id,request_id,model,requested_model,upstream_model,
            input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,stream,request_type,duration_ms,first_token_ms,
            billing_mode,s2a_personal_details)
        VALUES(lease.user_id,lease.key_id,lease.account_id,lease.group_id,lease.request_id::text,lease.model,lease.model,
            coalesce(p_upstream_model,lease.model),coalesce(p_input_tokens,0),coalesce(p_output_tokens,0),
            coalesce(p_cache_creation_tokens,0),coalesce(p_cache_read_tokens,0),lease.stream,CASE WHEN lease.stream THEN 2 ELSE 1 END,
            least(2147483647,greatest(0,floor(extract(epoch FROM now_at-lease.created_at)*1000)))::integer,p_first_token_ms,
            'token',payload || CASE WHEN lease.web_search THEN jsonb_build_object('web_search_calls',1,'operation',coalesce(lease.search_operation,'alpha_search')) ELSE '{}'::jsonb END) RETURNING id INTO usage_id;
    END IF;
    IF p_cooldown_seconds>0 THEN
        UPDATE s2a_private.accounts SET temp_unschedulable_until=greatest(temp_unschedulable_until,now_at+make_interval(secs=>p_cooldown_seconds)),
            temp_unschedulable_reason='cloud_upstream_'||p_status::text
            WHERE id=lease.account_id AND s2a_credential_version=p_credential_version;
    END IF;
    UPDATE s2a_private.personal_gateway_leases SET finished_at=now_at,completion_hash=digest,completion=payload
        WHERE id=p_lease_id;
    RETURN jsonb_build_object('applied',true,'usage_log_id',usage_id::text);
END $$;
ALTER FUNCTION public.s2a_personal_finish(uuid,integer,text,integer,integer,integer,integer,integer,bigint,integer,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_finish(uuid,integer,text,integer,integer,integer,integer,integer,bigint,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_finish(uuid,integer,text,integer,integer,integer,integer,integer,bigint,integer,text) TO service_role;

-- Preserve provider quota headers for the original account console.
CREATE OR REPLACE FUNCTION public.s2a_personal_windows_save(
    p_account_id bigint,p_version bigint,p_fetched_at bigint,p_windows jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF jsonb_typeof(p_windows)<>'object' OR octet_length(p_windows::text)>8192
        OR p_fetched_at<0 OR p_fetched_at>extract(epoch FROM now())+60
        OR EXISTS(SELECT FROM jsonb_object_keys(p_windows) k WHERE k !~ '^codex_(usage_updated_at|(5h|7d)_(used_percent|window_minutes|reset_after_seconds|reset_at))$')
        THEN RETURN false; END IF;
    UPDATE s2a_private.accounts SET extra=coalesce(extra,'{}'::jsonb)||p_windows||
        jsonb_build_object('s2a_quota_fetched_at',p_fetched_at),updated_at=now()
        WHERE id=p_account_id AND s2a_credential_version=p_version AND deleted_at IS NULL
        AND coalesce((extra->>'s2a_quota_fetched_at')::bigint,0)<=p_fetched_at;
    RETURN FOUND;
END $$;
ALTER FUNCTION public.s2a_personal_windows_save(bigint,bigint,bigint,jsonb) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_windows_save(bigint,bigint,bigint,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_windows_save(bigint,bigint,bigint,jsonb) TO service_role;

-- Store classified errors without request bodies, headers, or provider secrets.
CREATE OR REPLACE FUNCTION public.s2a_personal_ops_error_record(p_event jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE k public.api_keys; a bigint;
BEGIN
    IF jsonb_typeof(p_event)<>'object' OR octet_length(p_event::text)>16384 THEN RETURN; END IF;
    SELECT * INTO k FROM public.api_keys WHERE s2a_key_hash=p_event->>'key_hash' AND deleted_at IS NULL;
    IF p_event->>'account_id' ~ '^[0-9]{1,18}$' THEN
        SELECT id INTO a FROM s2a_private.accounts WHERE id=(p_event->>'account_id')::bigint;
    END IF;
    INSERT INTO public.ops_error_logs(request_id,client_request_id,user_id,api_key_id,account_id,group_id,
        platform,model,request_path,stream,error_phase,error_type,status_code,is_business_limited,
        error_message,error_source,error_owner,duration_ms)
    VALUES(left(p_event->>'request_id',64),left(p_event->>'event_id',64),k.user_id,k.id,a,k.group_id,
        left(p_event->>'platform',32),left(p_event->>'model',100),left(p_event->>'endpoint',256),
        coalesce((p_event->>'stream')::boolean,false),left(p_event->>'phase',32),left(p_event->>'type',64),
        (p_event->>'status_code')::integer,coalesce((p_event->>'limited')::boolean,false),
        left(p_event->>'code',128),left(p_event->>'source',64),left(p_event->>'owner',32),
        greatest(0,(p_event->>'duration_ms')::integer));
END $$;
ALTER FUNCTION public.s2a_personal_ops_error_record(jsonb) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_ops_error_record(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_ops_error_record(jsonb) TO service_role;
-- Retire jobs that operate on the previous gateway tables.
DO $$
DECLARE job record;
BEGIN
    IF EXISTS(SELECT FROM pg_extension WHERE extname='pg_cron') THEN
        FOR job IN SELECT jobid FROM cron.job WHERE jobname=ANY(ARRAY[
            's2a-privacy-jobs','s2a-openai-auto-reset','s2a-log-retention',
            's2a-ops-retention','s2a-ops-aggregation','s2a-ops-alert-evaluation',
            's2a-ops-daily_summary','s2a-ops-weekly_summary','s2a-ops-error_digest',
            's2a-ops-account_health','s2a-ops-mail-delivery','s2a-proxy-expiry']) LOOP
            PERFORM cron.unschedule(job.jobid);
        END LOOP;
    END IF;
END $$;

-- Read-only gateway discovery validates key and network policy without account slots.
CREATE OR REPLACE FUNCTION public.s2a_personal_key_policy(p_key_hash text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE identity jsonb; address inet; network text; allowed boolean;
BEGIN
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',CASE WHEN identity->>'error'='invalid_api_key' THEN 401 ELSE 403 END); END IF;
    IF p_client_ip IS NOT NULL THEN
        BEGIN
            IF strpos(p_client_ip,'/')>0 THEN RAISE invalid_text_representation; END IF;
            address:=p_client_ip::inet;
        EXCEPTION WHEN invalid_text_representation THEN RETURN jsonb_build_object('error','invalid_client_ip','status',400);
        END;
    END IF;
    IF jsonb_array_length(coalesce(nullif(identity->'ip_whitelist','null'::jsonb),'[]'::jsonb))>0 THEN
        allowed:=false;
        FOR network IN SELECT jsonb_array_elements_text(identity->'ip_whitelist') LOOP
            IF address IS NOT NULL AND address <<= network::inet THEN allowed:=true; END IF;
        END LOOP;
        IF NOT allowed THEN RETURN jsonb_build_object('error','ip_forbidden','status',403); END IF;
    END IF;
    IF jsonb_array_length(coalesce(nullif(identity->'ip_blacklist','null'::jsonb),'[]'::jsonb))>0 THEN
        IF address IS NULL THEN RETURN jsonb_build_object('error','client_ip_required','status',403); END IF;
        FOR network IN SELECT jsonb_array_elements_text(identity->'ip_blacklist') LOOP
            IF address <<= network::inet THEN RETURN jsonb_build_object('error','ip_forbidden','status',403); END IF;
        END LOOP;
    END IF;
    RETURN jsonb_build_object('platform',identity->'platform','model_allowlist',identity->'model_allowlist');
END $$;
ALTER FUNCTION public.s2a_personal_key_policy(text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_key_policy(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_key_policy(text,text) TO service_role;

-- Read configured token billing multipliers without consuming a request lease.
CREATE OR REPLACE FUNCTION public.s2a_personal_key_billing(p_key_hash text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; g public.groups%ROWTYPE; user_rate numeric;
    resolved numeric; peak numeric:=1; observed timestamptz:=clock_timestamp(); result jsonb;
    start_minute integer; end_minute integer; current_minute integer; local_at timestamp;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',403); END IF;
    SELECT * INTO g FROM public.groups WHERE id=(identity->>'group_id')::bigint;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','group_unavailable','status',403); END IF;
    SELECT rate_multiplier INTO user_rate FROM public.user_group_rate_multipliers
        WHERE user_id=(identity->>'user_id')::bigint AND group_id=g.id;
    resolved:=coalesce(user_rate,g.rate_multiplier);
    -- The personal gateway installs independently from the native billing gateway.
    IF g.subscription_type='subscription' AND g.peak_rate_enabled
        AND g.peak_start ~ '^([0-9]|[01][0-9]|2[0-3]):[0-5][0-9]$'
        AND g.peak_end ~ '^([0-9]|[01][0-9]|2[0-3]):[0-5][0-9]$' THEN
        start_minute:=split_part(g.peak_start,':',1)::integer*60+split_part(g.peak_start,':',2)::integer;
        end_minute:=split_part(g.peak_end,':',1)::integer*60+split_part(g.peak_end,':',2)::integer;
        local_at:=observed AT TIME ZONE 'Asia/Shanghai';
        current_minute:=extract(hour FROM local_at)::integer*60+extract(minute FROM local_at)::integer;
        IF start_minute<end_minute AND current_minute>=start_minute AND current_minute<end_minute THEN peak:=g.peak_rate_multiplier; END IF;
    END IF;
    result:=jsonb_build_object('object','sub2api.key_billing','schema_version',1,'billing_scope','token',
        'group_rate_multiplier',g.rate_multiplier,'resolved_rate_multiplier',resolved,
        'peak_rate_enabled',g.peak_rate_enabled,'effective_rate_multiplier',resolved*peak,'observed_at',observed);
    IF resolved IS DISTINCT FROM g.rate_multiplier THEN result:=result || jsonb_build_object('user_rate_multiplier',resolved); END IF;
    IF g.peak_rate_enabled THEN result:=result || jsonb_build_object('peak_start',g.peak_start,'peak_end',g.peak_end,
        'peak_rate_multiplier',g.peak_rate_multiplier,'applied_peak_multiplier',peak,'timezone','Asia/Shanghai'); END IF;
    RETURN result;
END $$;
ALTER FUNCTION public.s2a_personal_key_billing(text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_key_billing(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_key_billing(text,text) TO service_role;

-- Keep the native cache binding schema private from direct client REST access.
CREATE TABLE IF NOT EXISTS public.gemini_cached_contents (
    id BIGSERIAL PRIMARY KEY,public_id VARCHAR(64) NOT NULL,user_id BIGINT NOT NULL,api_key_id BIGINT NOT NULL,
    group_id BIGINT NOT NULL,account_id BIGINT NOT NULL,upstream_name VARCHAR(512) NOT NULL,
    model VARCHAR(255) NOT NULL,upstream_model VARCHAR(512) NOT NULL,display_name VARCHAR(512) NOT NULL DEFAULT '',
    total_token_count BIGINT NOT NULL DEFAULT 0,expire_time TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),deleted_at TIMESTAMPTZ NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gemini_cached_contents_public_id ON public.gemini_cached_contents(public_id);
CREATE INDEX IF NOT EXISTS idx_gemini_cached_contents_api_key_active ON public.gemini_cached_contents(api_key_id,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gemini_cached_contents_account ON public.gemini_cached_contents(account_id);
ALTER TABLE public.gemini_cached_contents OWNER TO s2a_management;
ALTER TABLE public.gemini_cached_contents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gemini_cached_contents FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON SEQUENCE public.gemini_cached_contents_id_seq FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.s2a_personal_cache_resolve(p_key_hash text,p_name text,p_model text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; binding public.gemini_cached_contents%ROWTYPE;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform' IS DISTINCT FROM 'gemini' THEN RETURN jsonb_build_object('error','gemini_cache_requires_gemini_group','status',400); END IF;
    IF p_name IS NULL OR p_name !~ '^cachedContents/[a-zA-Z0-9_-]{1,64}$' THEN RETURN jsonb_build_object('error','invalid_cached_content','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',403); END IF;
    SELECT * INTO binding FROM public.gemini_cached_contents
        WHERE public_id=substring(p_name FROM 16) AND user_id=(identity->>'user_id')::bigint
        AND api_key_id=(identity->>'key_id')::bigint AND group_id=(identity->>'group_id')::bigint
        AND deleted_at IS NULL AND expire_time>clock_timestamp();
    IF NOT FOUND THEN RETURN jsonb_build_object('error','cached_content_not_found','status',404); END IF;
    IF binding.model IS DISTINCT FROM regexp_replace(p_model,'^models/','') THEN RETURN jsonb_build_object('error','cached_content_model_mismatch','status',400); END IF;
    RETURN jsonb_build_object('account_id',binding.account_id::text,'upstream_name',binding.upstream_name,'upstream_model',binding.upstream_model);
END $$;
ALTER FUNCTION public.s2a_personal_cache_resolve(text,text,text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_cache_resolve(text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_cache_resolve(text,text,text,text) TO service_role;
-- Expose only tenant-owned cache views, never provider-wide cache listings.
CREATE OR REPLACE FUNCTION public.s2a_personal_cache_read(p_key_hash text,p_name text DEFAULT NULL,p_page_size integer DEFAULT 50,p_before bigint DEFAULT NULL,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; item public.gemini_cached_contents%ROWTYPE;
    entries jsonb:='[]'::jsonb; view jsonb; result jsonb; count integer:=0; last_id bigint;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform' IS DISTINCT FROM 'gemini' THEN RETURN jsonb_build_object('error','gemini_cache_requires_gemini_group','status',400); END IF;
    IF p_page_size IS NULL OR p_page_size<1 OR p_page_size>1000 OR p_before<=0 THEN RETURN jsonb_build_object('error','invalid_cache_pagination','status',400); END IF;
    IF p_name IS NOT NULL AND p_name !~ '^cachedContents/[a-zA-Z0-9_-]{1,64}$' THEN RETURN jsonb_build_object('error','invalid_cached_content','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',403); END IF;
    FOR item IN SELECT * FROM public.gemini_cached_contents
        WHERE user_id=(identity->>'user_id')::bigint AND api_key_id=(identity->>'key_id')::bigint
        AND group_id=(identity->>'group_id')::bigint AND deleted_at IS NULL AND expire_time>clock_timestamp()
        AND (p_name IS NULL OR public_id=substring(p_name FROM 16))
        AND (p_name IS NOT NULL OR p_before IS NULL OR id<p_before)
        ORDER BY id DESC LIMIT p_page_size+1 LOOP
        count:=count+1;
        IF count>p_page_size THEN EXIT; END IF;
        view:=jsonb_build_object('name','cachedContents/'||item.public_id,'model','models/'||item.model,
            'usageMetadata',jsonb_build_object('totalTokenCount',item.total_token_count),
            'createTime',to_char(item.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'updateTime',to_char(item.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'expireTime',to_char(item.expire_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
        IF item.display_name<>'' THEN view:=view||jsonb_build_object('displayName',item.display_name); END IF;
        IF p_name IS NOT NULL THEN RETURN view; END IF;
        entries:=entries||jsonb_build_array(view); last_id:=item.id;
    END LOOP;
    IF p_name IS NOT NULL THEN RETURN jsonb_build_object('error','cached_content_not_found','status',403); END IF;
    result:='{}'::jsonb;
    IF count>0 THEN result:=jsonb_build_object('cachedContents',entries); END IF;
    IF count>p_page_size THEN result:=result||jsonb_build_object('nextPageToken',rtrim(translate(encode(convert_to(last_id::text,'UTF8'),'base64'),'+/','-_'),'=')); END IF;
    RETURN result;
END $$;
ALTER FUNCTION public.s2a_personal_cache_read(text,text,integer,bigint,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_cache_read(text,text,integer,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_cache_read(text,text,integer,bigint,text) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
