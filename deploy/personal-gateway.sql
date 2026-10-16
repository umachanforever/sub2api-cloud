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
ALTER TABLE s2a_private.personal_gateway_leases ADD COLUMN IF NOT EXISTS inbound_endpoint varchar(128);
ALTER TABLE s2a_private.personal_gateway_leases ADD COLUMN IF NOT EXISTS client_ip varchar(45);
ALTER TABLE s2a_private.personal_gateway_leases ADD COLUMN IF NOT EXISTS responses_websocket boolean NOT NULL DEFAULT false;
ALTER TABLE s2a_private.personal_gateway_leases ADD COLUMN IF NOT EXISTS composite_route jsonb;
ALTER TABLE s2a_private.personal_gateway_leases OWNER TO s2a_management;
ALTER TABLE s2a_private.personal_gateway_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.personal_gateway_leases FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS personal_gateway_account_slots ON s2a_private.personal_gateway_leases(account_id,expires_at) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS personal_gateway_user_slots ON s2a_private.personal_gateway_leases(user_id,expires_at) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS personal_gateway_user_recent ON s2a_private.personal_gateway_leases(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS personal_gateway_request ON s2a_private.personal_gateway_leases(request_id);
ALTER FUNCTION public.invalidate_group_usage_rollup_state() SET search_path=pg_catalog,public,pg_temp;
ALTER FUNCTION public.invalidate_group_usage_rollup_state_after_insert() SET search_path=pg_catalog,public,pg_temp;
ALTER TABLE public.usage_logs ALTER COLUMN model TYPE varchar(200);
ALTER TABLE public.usage_logs ALTER COLUMN requested_model TYPE varchar(200);
ALTER TABLE public.usage_logs ALTER COLUMN upstream_model TYPE varchar(200);
ALTER TABLE public.usage_logs ADD COLUMN IF NOT EXISTS s2a_personal_details jsonb;

-- Match the account-level Responses WebSocket mode precedence used by the gateway.
CREATE OR REPLACE FUNCTION s2a_private.responses_websocket_mode(platform text,account_type text,extra jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE prefix text; mode text; flag text;
BEGIN
 IF platform='grok' THEN RETURN 'http_bridge'; END IF;
 IF platform IS DISTINCT FROM 'openai' THEN RETURN 'off'; END IF;
 prefix:=CASE WHEN account_type='apikey' THEN 'openai_apikey' ELSE 'openai_oauth' END;
 IF jsonb_typeof(extra->(prefix||'_responses_websockets_v2_mode'))='string' THEN
  mode:=lower(btrim(extra->>(prefix||'_responses_websockets_v2_mode')));
  IF mode IN ('off','ctx_pool','shared','dedicated','passthrough','http_bridge') THEN RETURN mode; END IF;
 END IF;
 FOREACH flag IN ARRAY ARRAY[prefix||'_responses_websockets_v2_enabled','responses_websockets_v2_enabled','openai_ws_enabled'] LOOP
  IF jsonb_typeof(extra->flag)='boolean' THEN RETURN CASE WHEN (extra->>flag)::boolean THEN 'ctx_pool' ELSE 'off' END; END IF;
 END LOOP;
 RETURN 'ctx_pool';
END $$;
ALTER FUNCTION s2a_private.responses_websocket_mode(text,text,jsonb) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.responses_websocket_mode(text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Expose only public mapping names for eligible mixed Antigravity catalogs.
CREATE OR REPLACE FUNCTION s2a_private.gemini_catalog_sources(p_group bigint) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 WITH eligible AS (
  SELECT a.id,a.extra FROM s2a_private.accounts a JOIN public.account_groups ag ON ag.account_id=a.id
  WHERE ag.group_id=p_group AND a.platform='antigravity' AND a.deleted_at IS NULL AND a.status='active' AND a.schedulable
   AND NOT coalesce(a.auto_pause_on_expired AND a.expires_at<=now(),false)
   AND coalesce(a.overload_until,'-infinity')<=now() AND coalesce(a.rate_limit_reset_at,'-infinity')<=now()
   AND coalesce(a.temp_unschedulable_until,'-infinity')<=now()
 ) SELECT jsonb_build_object('has_antigravity',EXISTS(SELECT 1 FROM eligible),
  'sources',coalesce((SELECT jsonb_agg(coalesce((SELECT jsonb_object_agg(m.key,m.value)
   FROM jsonb_each(CASE WHEN jsonb_typeof(s2a_private.account_credentials(e.id)->'model_mapping')='object'
    THEN s2a_private.account_credentials(e.id)->'model_mapping' ELSE '{}'::jsonb END) m
   WHERE jsonb_typeof(m.value)='string'),'{}'::jsonb) ORDER BY e.id)
   FROM eligible e WHERE e.extra->'mixed_scheduling'='true'::jsonb),'[]'::jsonb));
$$;
ALTER FUNCTION s2a_private.gemini_catalog_sources(bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.gemini_catalog_sources(bigint) FROM PUBLIC,anon,authenticated,service_role;

DROP FUNCTION IF EXISTS s2a_private.account_mapping_accepts(text,jsonb,jsonb,text);
CREATE OR REPLACE FUNCTION s2a_private.anthropic_catalog_models(p_group bigint) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(model ORDER BY model COLLATE "C"),'[]'::jsonb) FROM (
  SELECT DISTINCT m.key AS model FROM s2a_private.accounts a JOIN public.account_groups ag ON ag.account_id=a.id
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(s2a_private.account_credentials(a.id)->'model_mapping')='object'
    THEN s2a_private.account_credentials(a.id)->'model_mapping' ELSE '{}'::jsonb END) m
  WHERE ag.group_id=p_group AND a.platform='anthropic' AND a.deleted_at IS NULL AND a.status='active' AND a.schedulable
   AND NOT coalesce(a.auto_pause_on_expired AND a.expires_at<=now(),false)
   AND coalesce(a.overload_until,'-infinity')<=now() AND coalesce(a.rate_limit_reset_at,'-infinity')<=now()
   AND coalesce(a.temp_unschedulable_until,'-infinity')<=now() AND jsonb_typeof(m.value)='string'
 ) models;
$$;
ALTER FUNCTION s2a_private.anthropic_catalog_models(bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.anthropic_catalog_models(bigint) FROM PUBLIC,anon,authenticated,service_role;

-- Explicit account mappings also define the scheduler's model allowlist.
CREATE OR REPLACE FUNCTION s2a_private.account_mapping_accepts(platform text,account_type text,extra jsonb,mapping jsonb,model text)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE normalized text; pattern text;
BEGIN
 IF model='__models__' THEN RETURN true; END IF;
 IF platform='openai' AND (CASE
     WHEN jsonb_typeof(extra->'openai_passthrough')='boolean' THEN (extra->>'openai_passthrough')::boolean
     WHEN jsonb_typeof(extra->'openai_oauth_passthrough')='boolean' THEN (extra->>'openai_oauth_passthrough')::boolean
     ELSE false END) THEN RETURN true; END IF;
 IF jsonb_typeof(mapping) IS DISTINCT FROM 'object' THEN mapping:='{}'::jsonb; END IF;
 IF NOT EXISTS(SELECT 1 FROM jsonb_each(mapping) WHERE jsonb_typeof(value)='string') THEN
  IF platform='openai' AND account_type='oauth' THEN
   normalized:=lower(btrim(regexp_replace(btrim(model),'^.*/','')));
   IF normalized IN ('k3','k3-256k') THEN RETURN false; END IF;
   FOREACH pattern IN ARRAY ARRAY['deepseek-','glm-','kimi-','moonshot-','qwen-','qwen2-','qwen3-','qwen4-','qwq-','minimax-','gemini-','gemma-','grok-','doubao-','hunyuan-','llama-','llama2-','llama3-','meta-llama','mistral-','mixtral-','baichuan-','ernie-','step-','seed-','yi-'] LOOP
    IF starts_with(normalized,pattern) THEN RETURN false; END IF;
   END LOOP;
  ELSIF platform='deepseek' THEN
   normalized:=lower(btrim(model));
   WHILE length(normalized)>4 AND right(normalized,4)='[1m]' LOOP normalized:=left(normalized,-4); END LOOP;
   RETURN normalized='' OR normalized IN ('deepseek-flash','deepseek-v4-pro','deepseek-v4-flash','deepseek-v4-flash-vision-exp','deepseek-v4-pro-0813');
  END IF;
  RETURN true;
 END IF;
 normalized:=btrim(model);
 IF platform IN ('gemini','antigravity') AND normalized='gemini-3.1-pro-preview-customtools' THEN normalized:='gemini-3.1-pro-preview'; END IF;
 FOR pattern IN SELECT key FROM jsonb_each(mapping) WHERE jsonb_typeof(value)='string' LOOP
     IF model=pattern OR normalized=pattern OR (right(pattern,1)='*' AND
         (starts_with(model,left(pattern,-1)) OR starts_with(normalized,left(pattern,-1)))) THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;
ALTER FUNCTION s2a_private.account_mapping_accepts(text,text,jsonb,jsonb,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.account_mapping_accepts(text,text,jsonb,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;

-- Group routing prioritizes eligible accounts; it never bypasses admission or
-- prevents fallback when every preferred account is unavailable.
CREATE OR REPLACE FUNCTION s2a_private.group_routing_accounts(p_config jsonb,p_enabled boolean,p_model text)
RETURNS bigint[] LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE selected jsonb; entry record; ids bigint[];
BEGIN
 IF NOT coalesce(p_enabled,false) OR p_model IS NULL OR p_model='__models__' OR jsonb_typeof(p_config) IS DISTINCT FROM 'object' THEN RETURN '{}'::bigint[]; END IF;
 selected:=p_config->p_model;
 IF jsonb_typeof(selected) IS DISTINCT FROM 'array' THEN selected:=NULL;
 ELSIF jsonb_array_length(selected)=0 THEN selected:=NULL; END IF;
 IF selected IS NULL THEN
  FOR entry IN SELECT key,value FROM jsonb_each(p_config) LOOP
   IF right(entry.key,1)='*' AND starts_with(p_model,left(entry.key,-1)) AND jsonb_typeof(entry.value)='array' THEN
    IF jsonb_array_length(entry.value)>0 THEN selected:=entry.value; EXIT; END IF;
   END IF;
  END LOOP;
 END IF;
 IF selected IS NULL THEN RETURN '{}'::bigint[]; END IF;
 SELECT coalesce(array_agg(id ORDER BY position) FILTER(WHERE id IS NOT NULL),'{}'::bigint[]) INTO ids FROM (
  SELECT ordinality AS position,CASE WHEN jsonb_typeof(value)='number' AND value::text ~ '^[1-9][0-9]{0,18}$'
   THEN CASE WHEN value::text::numeric<=9223372036854775807 THEN value::text::bigint END END AS id
  FROM jsonb_array_elements(selected) WITH ORDINALITY
 ) candidates;
 RETURN ids;
END $$;
ALTER FUNCTION s2a_private.group_routing_accounts(jsonb,boolean,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.group_routing_accounts(jsonb,boolean,text) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.s2a_personal_acquire(
    p_key_hash text,p_model text,p_request_id uuid,p_excluded bigint[] DEFAULT '{}',
    p_count_request boolean DEFAULT true,p_client_ip text DEFAULT NULL,p_billing_context jsonb DEFAULT '{}'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE identity jsonb; k public.api_keys; g public.groups; a s2a_private.accounts;
    group_rpm integer; user_rpm integer; route jsonb; target_platform text; routed_model text; route_mapping jsonb; route_target text; normalized_model text;
    lease s2a_private.personal_gateway_leases; address inet; network text; pattern text;
    allowed boolean; fingerprint text; now_at timestamptz; account jsonb; cache_binding jsonb; video_binding jsonb; image_binding jsonb; bound_account_id bigint;
    native_gemini_catalog boolean; gemini_sources jsonb; routing_accounts bigint[]:='{}';
BEGIN
    IF p_request_id IS NULL OR p_model IS NULL OR length(p_model) NOT BETWEEN 1 AND 200
        OR p_model ~ '[[:cntrl:]]' OR cardinality(p_excluded)>3 OR array_position(p_excluded,NULL) IS NOT NULL
        OR jsonb_typeof(p_billing_context)<>'object' THEN RETURN jsonb_build_object('error','invalid_request','status',400); END IF;
    IF p_billing_context ? 'inbound_endpoint' AND (jsonb_typeof(p_billing_context->'inbound_endpoint')<>'string'
        OR length(p_billing_context->>'inbound_endpoint') NOT BETWEEN 1 AND 128
        OR p_billing_context->>'inbound_endpoint' !~ '^/[a-zA-Z0-9_/:.%-]+$') THEN RETURN jsonb_build_object('error','invalid_endpoint','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',CASE WHEN identity->>'error'='invalid_api_key' THEN 401 ELSE 403 END); END IF;
    PERFORM 1 FROM public.users WHERE id=(identity->>'user_id')::bigint FOR UPDATE;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',CASE WHEN identity->>'error'='invalid_api_key' THEN 401 ELSE 403 END); END IF;
    SELECT * INTO k FROM public.api_keys WHERE id=(identity->>'key_id')::bigint;
    SELECT * INTO g FROM public.groups WHERE id=k.group_id;
    native_gemini_catalog:=p_model='__models__' AND coalesce(p_billing_context->>'inbound_endpoint','') ~ '^/v1beta/models(/[^/]+)?$';
    target_platform:=g.platform; routed_model:=p_model;
    IF native_gemini_catalog AND g.platform='composite' THEN target_platform:='gemini'; END IF;
    IF g.platform='composite' AND p_model<>'__models__' THEN
        SELECT l.composite_route INTO route FROM s2a_private.personal_gateway_leases l
            WHERE l.request_id=p_request_id AND l.key_id=k.id ORDER BY l.created_at DESC LIMIT 1;
        IF route IS NULL THEN
        route:=s2a_private.composite_resolve(g.id,p_model,CASE
            WHEN p_billing_context->>'inbound_endpoint' ~ '/messages/count_tokens$' THEN 'count_tokens'
            WHEN p_billing_context->>'inbound_endpoint' ~ '/messages$' THEN 'messages'
            WHEN p_billing_context->>'inbound_endpoint' ~ '/chat/completions$' THEN 'chat_completions'
            WHEN p_billing_context->>'inbound_endpoint' ~ '/embeddings$' THEN 'embeddings'
            WHEN p_billing_context->>'inbound_endpoint' ~ '/images/(generations|edits)$' THEN 'images'
            WHEN p_billing_context->>'inbound_endpoint' ~ '^/v1beta/' THEN 'gemini'
            WHEN p_billing_context->>'inbound_endpoint'='/v1/systemone' THEN 'any'
            ELSE 'responses' END);
        END IF;
        IF route ? 'error' THEN RETURN route; END IF;
        target_platform:=route->>'platform'; routed_model:=route->>'upstream_model';
    END IF;
    IF target_platform IN ('openai','anthropic') AND g.platform IN (target_platform,'composite') THEN
        routing_accounts:=s2a_private.group_routing_accounts(g.model_routing,g.model_routing_enabled,p_model);
    END IF;
    IF NOT coalesce(g.allow_image_generation,false) AND (coalesce((CASE WHEN target_platform='grok' THEN p_billing_context->>'grok_image_generation' ELSE p_billing_context->>'image_generation' END)::boolean,false) OR lower(p_model) ~ '^(gpt-image-|grok-imagine(?:$|-edit$|-image))')
        AND NOT coalesce((p_billing_context->>'count_only')::boolean,false)
        THEN RETURN jsonb_build_object('error','image_generation_forbidden','status',403); END IF;
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
    IF p_model='__models__' AND g.platform='openai' AND g.codex_models_manifest_config->'enabled'='true'::jsonb
        AND NOT (coalesce(p_billing_context->'pinned_models_fallback'='true'::jsonb,false)
            AND coalesce(g.codex_models_manifest_config->'fallback_to_scheduler'='true'::jsonb,false)) THEN
        RETURN jsonb_build_object('pinned_catalog',s2a_private.pinned_model_sources(g.id));
    END IF;
    IF native_gemini_catalog AND g.platform IN ('gemini','composite') THEN gemini_sources:=s2a_private.gemini_catalog_sources(g.id); END IF;
    IF p_model='__models__' AND g.platform='anthropic' AND coalesce(p_billing_context->>'inbound_endpoint','') ~ '^(/v1/models(/[^/]+)?|/backend-api/codex/models)$' THEN
        RETURN jsonb_build_object('anthropic_catalog',s2a_private.anthropic_catalog_models(g.id),'model_allowlist',g.model_allowlist,'anthropic_capabilities',s2a_private.composite_capability_sources(g.id),'anthropic_model_routing',CASE WHEN g.model_routing_enabled THEN g.model_routing ELSE '{}'::jsonb END);
    END IF;
    IF p_model='__models__' AND g.platform='composite' AND NOT native_gemini_catalog THEN
        IF coalesce(p_billing_context->>'inbound_endpoint','') !~ '^(/v1/models(/[^/]+)?|/backend-api/codex/models)$'
            THEN RETURN jsonb_build_object('error','composite_catalog_unavailable','status',503); END IF;
        RETURN jsonb_build_object('composite_catalog',s2a_private.composite_catalog_sources(g.id),'model_allowlist',g.model_allowlist);
    END IF;
    IF p_model <> '__models__' AND coalesce((g.model_allowlist->>'enabled')::boolean, false) THEN
        allowed := false;
        FOR pattern IN SELECT jsonb_array_elements_text(coalesce(g.model_allowlist->'models', '[]'::jsonb)) LOOP
            IF lower(p_model) = lower(pattern) OR (right(pattern, 1) = '*' AND starts_with(lower(p_model), lower(left(pattern, -1)))) THEN allowed := true; END IF;
        END LOOP;
        IF NOT allowed THEN RETURN jsonb_build_object('error', 'model_not_allowed', 'status', 403); END IF;
    END IF;
    IF p_billing_context ? 'websocket_account' THEN
        IF coalesce(p_billing_context->>'websocket_account','') !~ '^[1-9][0-9]{0,17}$' THEN RETURN jsonb_build_object('error','invalid_websocket_account','status',400); END IF;
        bound_account_id:=(p_billing_context->>'websocket_account')::bigint;
    END IF;
    IF p_billing_context ? 'cached_content' THEN
        cache_binding:=public.s2a_personal_cache_resolve(p_key_hash,p_billing_context->>'cached_content',p_model,p_client_ip);
        IF cache_binding ? 'error' THEN RETURN cache_binding; END IF;
        bound_account_id:=(cache_binding->>'account_id')::bigint;
    END IF;
    IF p_billing_context ? 'video_task' THEN
        video_binding:=public.s2a_personal_video_resolve(p_key_hash,p_billing_context->>'video_task',p_client_ip);
        IF video_binding ? 'error' THEN RETURN video_binding; END IF;
        IF video_binding->>'state'<>'submitted' THEN RETURN jsonb_build_object('error','video_task_not_submitted','status',409); END IF;
        IF p_model IS DISTINCT FROM video_binding->>'model' THEN RETURN jsonb_build_object('error','video_task_model_mismatch','status',400); END IF;
        IF bound_account_id IS NOT NULL AND bound_account_id<>(video_binding->>'account_id')::bigint THEN RETURN jsonb_build_object('error','resource_account_mismatch','status',400); END IF;
        bound_account_id:=(video_binding->>'account_id')::bigint;
    END IF;
    IF p_billing_context ? 'image_task' THEN
        image_binding:=public.s2a_personal_image_job_admit(p_billing_context->>'image_task',(p_billing_context->>'image_job_lease')::uuid,p_key_hash,p_model,p_client_ip);
        IF image_binding ? 'error' THEN RETURN image_binding; END IF;
        IF image_binding->>'user_id' IS DISTINCT FROM k.user_id::text OR image_binding->>'key_id' IS DISTINCT FROM k.id::text OR image_binding->>'group_id' IS DISTINCT FROM g.id::text
            THEN RETURN jsonb_build_object('error','image_task_key_unavailable','status',403); END IF;
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
    -- Retries and idempotent replays share one RPM admission across provider accounts.
    IF lease.id IS NULL THEN
        now_at:=clock_timestamp();
        SELECT coalesce(r.rpm_override,g.rpm_limit) INTO group_rpm
            FROM (SELECT 1) seed LEFT JOIN public.user_group_rate_multipliers r ON r.user_id=k.user_id AND r.group_id=g.id;
        IF group_rpm>0 AND (SELECT count(DISTINCT request_id) FROM s2a_private.personal_gateway_leases
            WHERE user_id=k.user_id AND group_id=g.id AND created_at>=date_trunc('minute',now_at))>=group_rpm
            THEN RETURN jsonb_build_object('error','group_rate_limit_exceeded','status',429); END IF;
        SELECT rpm_limit INTO user_rpm FROM public.users WHERE id=k.user_id;
        IF user_rpm>0 AND (SELECT count(DISTINCT request_id) FROM s2a_private.personal_gateway_leases
            WHERE user_id=k.user_id AND created_at>=date_trunc('minute',now_at))>=user_rpm
            THEN RETURN jsonb_build_object('error','rate_limit_exceeded','status',429); END IF;
    END IF;
    IF lease.id IS NULL OR lease.finished_at IS NOT NULL THEN
        -- The user row lock serializes admissions across every key and account.
        IF EXISTS (SELECT 1 FROM public.users u WHERE u.id=k.user_id AND u.concurrency>0
            AND (SELECT count(*) FROM s2a_private.personal_gateway_leases l
                WHERE l.user_id=k.user_id AND l.finished_at IS NULL AND l.expires_at>clock_timestamp())>=u.concurrency)
            THEN RETURN jsonb_build_object('error','user_concurrency_exceeded','status',429); END IF;
        lease:=NULL;
        FOR a IN SELECT accounts.* FROM s2a_private.accounts accounts
            JOIN public.account_groups ag ON ag.account_id=accounts.id AND ag.group_id=g.id
            WHERE accounts.deleted_at IS NULL AND accounts.status='active' AND accounts.schedulable
                AND accounts.platform=target_platform AND NOT(accounts.id=ANY(coalesce(p_excluded,'{}')))
                AND (bound_account_id IS NULL OR accounts.id=bound_account_id)
                AND (NOT coalesce((p_billing_context->>'responses_websocket')::boolean,false) OR s2a_private.responses_websocket_mode(accounts.platform,accounts.type,accounts.extra)<>'off')
                AND (NOT coalesce((p_billing_context->>'cache_create')::boolean,false) OR (target_platform='gemini' AND accounts.type='apikey'))
                AND NOT coalesce(accounts.auto_pause_on_expired AND accounts.expires_at<=clock_timestamp(),false)
                AND coalesce(accounts.overload_until,'-infinity')<=clock_timestamp()
                AND coalesce(accounts.rate_limit_reset_at,'-infinity')<=clock_timestamp()
                AND coalesce(accounts.temp_unschedulable_until,'-infinity')<=clock_timestamp()
                AND (NOT g.require_oauth_only OR accounts.type<>'apikey')
                AND (NOT g.require_privacy_set OR (accounts.platform<>'openai' OR accounts.extra->>'privacy_mode'='training_off'))
            ORDER BY CASE WHEN accounts.id=ANY(routing_accounts) THEN 0 ELSE 1 END,
                CASE WHEN native_gemini_catalog THEN CASE
                WHEN accounts.type='apikey' AND btrim(coalesce(s2a_private.account_credentials(accounts.id)->>'api_key',''))<>'' THEN 0
                WHEN accounts.type='apikey' THEN 9
                WHEN accounts.type='oauth' AND btrim(coalesce(s2a_private.account_credentials(accounts.id)->>'project_id',''))='' THEN 1
                WHEN accounts.type='oauth' AND btrim(coalesce(s2a_private.account_credentials(accounts.id)->>'oauth_type',''))='ai_studio' THEN 2
                WHEN accounts.type='oauth' THEN 3
                WHEN accounts.type='service_account' AND btrim(coalesce(s2a_private.account_credentials(accounts.id)->>'auth_mode',''))='apikey' THEN 12
                WHEN accounts.type='service_account' THEN 11 ELSE 10 END ELSE 0 END,
                accounts.priority,accounts.last_used_at NULLS FIRST,accounts.id
            FOR UPDATE OF accounts LOOP
            IF NOT s2a_private.account_mapping_accepts(a.platform,a.type,a.extra,s2a_private.account_credentials(a.id)->'model_mapping',routed_model) THEN CONTINUE; END IF;
            now_at:=clock_timestamp();
            IF (SELECT count(*) FROM s2a_private.personal_gateway_leases WHERE account_id=a.id AND finished_at IS NULL AND expires_at>now_at)>=greatest(a.concurrency,1) THEN CONTINUE; END IF;
            INSERT INTO s2a_private.personal_gateway_leases(request_id,user_id,key_id,group_id,account_id,credential_version,model,stream,fingerprint,expires_at,count_only,web_search,search_operation,inbound_endpoint,client_ip,responses_websocket,composite_route)
                VALUES(p_request_id,k.user_id,k.id,g.id,a.id,a.s2a_credential_version,p_model,coalesce((p_billing_context->>'native_stream')::boolean,false),fingerprint,now_at+interval '150 seconds',coalesce((p_billing_context->>'count_only')::boolean,false),coalesce((p_billing_context->>'web_search')::boolean,false),CASE WHEN p_billing_context->>'search_operation' IN ('web_search','x_search') THEN p_billing_context->>'search_operation' ELSE 'alpha_search' END,p_billing_context->>'inbound_endpoint',host(address),coalesce((p_billing_context->>'responses_websocket')::boolean,false),route) RETURNING * INTO lease;
            UPDATE s2a_private.accounts SET last_used_at=now_at WHERE id=a.id;
            EXIT;
        END LOOP;
        IF lease.id IS NULL THEN
            IF native_gemini_catalog AND gemini_sources->>'has_antigravity'='true' THEN
                RETURN jsonb_build_object('gemini_catalog_only',true,'gemini_catalog_sources',gemini_sources,'model_allowlist',g.model_allowlist);
            END IF;
            RETURN jsonb_build_object('error','no_available_account','status',503);
        END IF;
    END IF;
    account:=public.s2a_gateway_account_snapshot(lease.account_id);
    IF account ? 'error' THEN RETURN account || jsonb_build_object('status',503); END IF;
    IF (account->>'credential_version')::bigint<>lease.credential_version THEN RETURN jsonb_build_object('error','account_credentials_changed','status',409); END IF;
    SELECT * INTO a FROM s2a_private.accounts WHERE id=lease.account_id;
    IF route IS NOT NULL THEN
        route_mapping:=account->'credentials'->'model_mapping';
        normalized_model:=btrim(routed_model);
        IF a.platform IN ('gemini','antigravity') AND normalized_model='gemini-3.1-pro-preview-customtools'
            THEN normalized_model:='gemini-3.1-pro-preview'; END IF;
        IF jsonb_typeof(route_mapping)='object' THEN
            SELECT m.value#>>'{}' INTO route_target FROM jsonb_each(route_mapping) m
            CROSS JOIN (VALUES(routed_model,0),(normalized_model,1)) candidate(model,rank)
            WHERE jsonb_typeof(m.value)='string' AND (m.key=candidate.model OR (right(m.key,1)='*' AND starts_with(candidate.model,left(m.key,-1))))
            ORDER BY candidate.rank,(m.key=candidate.model) DESC,octet_length(m.key) DESC,m.key COLLATE "C" LIMIT 1;
        END IF;
    END IF;
    RETURN jsonb_build_object('lease_id',lease.id::text,'account',account || jsonb_build_object('proxy_id',a.proxy_id::text,'model_passthrough',
        CASE WHEN jsonb_typeof(a.extra->'openai_passthrough')='boolean' THEN (a.extra->>'openai_passthrough')::boolean
            WHEN jsonb_typeof(a.extra->'openai_oauth_passthrough')='boolean' THEN (a.extra->>'openai_oauth_passthrough')::boolean ELSE false END)
        || CASE WHEN p_model='__models__' THEN jsonb_build_object('model_metadata',a.extra->'upstream_model_metadata') ELSE '{}'::jsonb END,
        'allow_image_generation',g.allow_image_generation,'model_allowlist',g.model_allowlist,'model_sources',jsonb_build_object('mapping',CASE WHEN native_gemini_catalog THEN '{}'::jsonb ELSE coalesce(account->'credentials'->'model_mapping','{}') END,'include_upstream',true))
        || CASE WHEN p_model='__models__' AND g.platform='openai' AND g.codex_models_manifest_config->'enabled' IS DISTINCT FROM 'true'::jsonb THEN jsonb_build_object('configured_model_sources',s2a_private.composite_catalog_sources(g.id)) ELSE '{}'::jsonb END
        || CASE WHEN gemini_sources IS NOT NULL THEN jsonb_build_object('gemini_catalog_sources',gemini_sources) ELSE '{}'::jsonb END
        || CASE WHEN video_binding IS NOT NULL THEN jsonb_build_object('upstream_model',video_binding->>'upstream_model') WHEN route IS NOT NULL THEN jsonb_build_object('upstream_model',coalesce(route_target,routed_model),'composite_route',route) ELSE '{}'::jsonb END;
END $$;
ALTER FUNCTION public.s2a_personal_acquire(text,text,uuid,bigint[],boolean,text,jsonb) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_acquire(text,text,uuid,bigint[],boolean,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_acquire(text,text,uuid,bigint[],boolean,text,jsonb) TO service_role;
-- Keep provider token counts above the PostgreSQL integer range exact.
ALTER TABLE public.usage_logs
 ALTER COLUMN input_tokens TYPE bigint,
 ALTER COLUMN output_tokens TYPE bigint,
 ALTER COLUMN cache_creation_tokens TYPE bigint,
 ALTER COLUMN cache_read_tokens TYPE bigint;
-- Remove the old signature so PostgREST sees one unambiguous RPC.
DROP FUNCTION IF EXISTS public.s2a_personal_finish(uuid,integer,text,integer,integer,integer,integer,integer,bigint,integer,text);
DROP FUNCTION IF EXISTS public.s2a_personal_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint,integer,text);
DROP FUNCTION IF EXISTS public.s2a_personal_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint,integer,text,integer);
CREATE OR REPLACE FUNCTION public.s2a_personal_finish(
    p_lease_id uuid,p_status integer,p_outcome text,p_input_tokens bigint,p_output_tokens bigint,
    p_cache_creation_tokens bigint,p_cache_read_tokens bigint,p_cooldown_seconds integer,
    p_credential_version bigint,p_first_token_ms integer DEFAULT NULL,p_upstream_model text DEFAULT NULL,
    p_duration_ms integer DEFAULT NULL,p_upstream_endpoint text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE lease s2a_private.personal_gateway_leases; payload jsonb; digest text; usage_id bigint; now_at timestamptz;
BEGIN
    IF p_lease_id IS NULL OR p_status IS NULL OR p_status NOT BETWEEN 100 AND 599
        OR p_outcome IS NULL OR p_outcome NOT IN ('completed','failed','cancelled','interrupted')
        OR coalesce(p_input_tokens,0)<0 OR coalesce(p_output_tokens,0)<0
        OR coalesce(p_cache_creation_tokens,0)<0 OR coalesce(p_cache_read_tokens,0)<0
        OR (p_upstream_endpoint IS NOT NULL AND (length(p_upstream_endpoint) NOT BETWEEN 1 AND 128 OR p_upstream_endpoint !~ '^/[a-zA-Z0-9_/:.%-]+$'))
        OR coalesce(p_duration_ms,0)<0 OR (p_duration_ms IS NOT NULL AND p_first_token_ms>p_duration_ms)
        OR coalesce(p_first_token_ms,0)<0 OR p_cooldown_seconds IS NULL OR p_cooldown_seconds NOT BETWEEN 0 AND 3600
        OR (p_upstream_model IS NOT NULL AND (length(p_upstream_model) NOT BETWEEN 1 AND 200 OR p_upstream_model ~ '[[:cntrl:]]')) THEN
        RETURN jsonb_build_object('error','invalid_usage','status',400);
    END IF;
    payload:=jsonb_build_object('status',p_status,'outcome',p_outcome,'input',p_input_tokens,'output',p_output_tokens,
        'cacheCreation',p_cache_creation_tokens,'cacheRead',p_cache_read_tokens,'firstTokenMs',p_first_token_ms,
        'cooldown',p_cooldown_seconds,'credentialVersion',p_credential_version,'upstreamModel',p_upstream_model,'durationMs',p_duration_ms,'upstreamEndpoint',p_upstream_endpoint);
    digest:=encode(sha256(convert_to(payload::text,'UTF8')),'hex');
    SELECT * INTO lease FROM s2a_private.personal_gateway_leases WHERE id=p_lease_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','lease_not_found','status',404); END IF;
    IF lease.finished_at IS NOT NULL THEN
        IF lease.completion_hash<>digest THEN RETURN jsonb_build_object('error','completion_conflict','status',409); END IF;
        RETURN jsonb_build_object('applied',false);
    END IF;
    now_at:=clock_timestamp();
    IF NOT lease.count_only AND lease.model<>'__models__' AND (p_outcome='completed' OR greatest(coalesce(p_input_tokens,0),coalesce(p_output_tokens,0),coalesce(p_cache_creation_tokens,0),coalesce(p_cache_read_tokens,0))>0) THEN
        INSERT INTO public.usage_logs(user_id,api_key_id,account_id,group_id,request_id,model,requested_model,upstream_model,
            input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,stream,request_type,duration_ms,first_token_ms,
            billing_mode,s2a_personal_details,inbound_endpoint,ip_address,upstream_endpoint)
        VALUES(lease.user_id,lease.key_id,lease.account_id,lease.group_id,lease.request_id::text,lease.model,lease.model,
            coalesce(p_upstream_model,lease.model),coalesce(p_input_tokens,0),coalesce(p_output_tokens,0),
            coalesce(p_cache_creation_tokens,0),coalesce(p_cache_read_tokens,0),lease.stream,CASE WHEN lease.responses_websocket THEN 3 WHEN lease.stream THEN 2 ELSE 1 END,
            coalesce(p_duration_ms,least(2147483647,greatest(coalesce(p_first_token_ms,0),floor(extract(epoch FROM now_at-lease.created_at)*1000)))::integer),p_first_token_ms,
            'token',payload || CASE WHEN lease.web_search THEN jsonb_build_object('web_search_calls',1,'operation',coalesce(lease.search_operation,'alpha_search')) ELSE '{}'::jsonb END,lease.inbound_endpoint,lease.client_ip,p_upstream_endpoint) RETURNING id INTO usage_id;
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
ALTER FUNCTION public.s2a_personal_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint,integer,text,integer,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint,integer,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer,bigint,integer,text,integer,text) TO service_role;

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
DECLARE identity jsonb; address inet; network text; allowed boolean; image_allowed boolean; batch_allowed boolean;
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
    SELECT allow_image_generation,allow_batch_image_generation INTO image_allowed,batch_allowed FROM public.groups WHERE id=(identity->>'group_id')::bigint;
    RETURN jsonb_build_object('platform',identity->'platform','model_allowlist',identity->'model_allowlist','allow_image_generation',coalesce(image_allowed,false),'allow_batch_image_generation',coalesce(batch_allowed,false));
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
-- Persist mutation ownership across interrupted Edge invocations.
ALTER TABLE public.gemini_cached_contents ADD COLUMN IF NOT EXISTS mutation_lease uuid;
ALTER TABLE public.gemini_cached_contents ADD COLUMN IF NOT EXISTS mutation_until timestamptz;
CREATE OR REPLACE FUNCTION public.s2a_personal_cache_mutation(p_key_hash text,p_name text,p_lease_id uuid,p_action text,p_expire_time timestamptz DEFAULT NULL,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; lease s2a_private.personal_gateway_leases%ROWTYPE; item public.gemini_cached_contents%ROWTYPE; recovering boolean;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform' IS DISTINCT FROM 'gemini' THEN RETURN jsonb_build_object('error','gemini_cache_requires_gemini_group','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',403); END IF;
    IF p_name IS NULL OR p_name !~ '^cachedContents/[a-zA-Z0-9_-]{1,64}$' THEN RETURN jsonb_build_object('error','invalid_cached_content','status',400); END IF;
    SELECT * INTO lease FROM s2a_private.personal_gateway_leases WHERE id=p_lease_id FOR UPDATE;
    IF NOT FOUND OR lease.finished_at IS NOT NULL OR lease.expires_at<=clock_timestamp()
        OR lease.user_id<>(identity->>'user_id')::bigint OR lease.key_id<>(identity->>'key_id')::bigint
        OR lease.group_id<>(identity->>'group_id')::bigint OR NOT lease.count_only THEN
        RETURN jsonb_build_object('error','invalid_cache_reservation','status',409);
    END IF;
    SELECT * INTO item FROM public.gemini_cached_contents WHERE public_id=substring(p_name FROM 16)
        AND user_id=lease.user_id AND api_key_id=lease.key_id AND group_id=lease.group_id
        AND account_id=lease.account_id AND model=lease.model FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','cached_content_not_found','status',403); END IF;
    IF p_action='claim' THEN
        IF item.deleted_at IS NOT NULL OR item.expire_time<=clock_timestamp() THEN RETURN jsonb_build_object('error','cached_content_not_found','status',403); END IF;
        IF item.mutation_lease IS NOT NULL AND item.mutation_lease<>p_lease_id AND item.mutation_until>clock_timestamp() THEN
            RETURN jsonb_build_object('error','cache_mutation_in_progress','status',409);
        END IF;
        recovering:=item.mutation_lease IS NOT NULL AND item.mutation_lease<>p_lease_id;
        UPDATE public.gemini_cached_contents SET mutation_lease=p_lease_id,mutation_until=lease.expires_at+interval '30 seconds' WHERE id=item.id;
        RETURN jsonb_build_object('claimed',true,'recover',recovering,'rollback_expire_time',item.expire_time);
    END IF;
    IF item.mutation_lease IS DISTINCT FROM p_lease_id THEN RETURN jsonb_build_object('error','cache_mutation_conflict','status',409); END IF;
    IF p_action='apply' THEN
        IF item.deleted_at IS NOT NULL OR p_expire_time IS NULL OR NOT isfinite(p_expire_time) OR p_expire_time<=clock_timestamp() OR p_expire_time>clock_timestamp()+interval '24 hours 5 seconds' THEN
            RETURN jsonb_build_object('error','invalid_cache_expiry','status',400);
        END IF;
        UPDATE public.gemini_cached_contents SET expire_time=p_expire_time,updated_at=clock_timestamp() WHERE id=item.id;
        RETURN jsonb_build_object('updated',true);
    ELSIF p_action='release' THEN
        UPDATE public.gemini_cached_contents SET mutation_lease=NULL,mutation_until=NULL WHERE id=item.id;
        RETURN jsonb_build_object('released',true);
    END IF;
    RETURN jsonb_build_object('error','invalid_cache_mutation','status',400);
END $$;
ALTER FUNCTION public.s2a_personal_cache_mutation(text,text,uuid,text,timestamptz,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_cache_mutation(text,text,uuid,text,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_cache_mutation(text,text,uuid,text,timestamptz,text) TO service_role;
-- Complete deletion only under the active owning account reservation.
CREATE OR REPLACE FUNCTION public.s2a_personal_cache_deleted(p_key_hash text,p_name text,p_lease_id uuid,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; lease s2a_private.personal_gateway_leases%ROWTYPE; item public.gemini_cached_contents%ROWTYPE;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform' IS DISTINCT FROM 'gemini' THEN RETURN jsonb_build_object('error','gemini_cache_requires_gemini_group','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',403); END IF;
    IF p_name IS NULL OR p_name !~ '^cachedContents/[a-zA-Z0-9_-]{1,64}$' THEN RETURN jsonb_build_object('error','invalid_cached_content','status',400); END IF;
    SELECT * INTO lease FROM s2a_private.personal_gateway_leases WHERE id=p_lease_id FOR UPDATE;
    IF NOT FOUND OR lease.finished_at IS NOT NULL OR lease.expires_at<=clock_timestamp()
        OR lease.user_id<>(identity->>'user_id')::bigint OR lease.key_id<>(identity->>'key_id')::bigint
        OR lease.group_id<>(identity->>'group_id')::bigint OR NOT lease.count_only THEN
        RETURN jsonb_build_object('error','invalid_cache_reservation','status',409);
    END IF;
    SELECT * INTO item FROM public.gemini_cached_contents WHERE public_id=substring(p_name FROM 16)
        AND user_id=lease.user_id AND api_key_id=lease.key_id AND group_id=lease.group_id
        AND account_id=lease.account_id AND model=lease.model FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','cached_content_not_found','status',403); END IF;
    IF item.mutation_lease IS DISTINCT FROM p_lease_id THEN RETURN jsonb_build_object('error','cache_mutation_conflict','status',409); END IF;
    UPDATE public.gemini_cached_contents SET deleted_at=coalesce(deleted_at,clock_timestamp()),updated_at=clock_timestamp() WHERE id=item.id;
    RETURN jsonb_build_object('deleted',true);
END $$;
ALTER FUNCTION public.s2a_personal_cache_deleted(text,text,uuid,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_cache_deleted(text,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_cache_deleted(text,text,uuid,text) TO service_role;
-- Retain creation intents before network dispatch so interrupted resources remain traceable.
CREATE TABLE IF NOT EXISTS s2a_private.cache_creation_intents (
    public_id text PRIMARY KEY,lease_id uuid NOT NULL,user_id bigint NOT NULL,key_id bigint NOT NULL,
    group_id bigint NOT NULL,account_id bigint NOT NULL,model text NOT NULL,upstream_model text NOT NULL,
    display_name text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz
);
ALTER TABLE s2a_private.cache_creation_intents ADD COLUMN IF NOT EXISTS abandoned_at timestamptz;
ALTER TABLE s2a_private.cache_creation_intents OWNER TO s2a_management;
ALTER TABLE s2a_private.cache_creation_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.cache_creation_intents FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.s2a_personal_cache_create(p_key_hash text,p_public_id text,p_lease_id uuid,p_upstream_model text,p_display_name text,p_action text,p_upstream_name text DEFAULT NULL,p_expire_time timestamptz DEFAULT NULL,p_token_count bigint DEFAULT NULL,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; lease s2a_private.personal_gateway_leases%ROWTYPE; intent s2a_private.cache_creation_intents%ROWTYPE;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform' IS DISTINCT FROM 'gemini' THEN RETURN jsonb_build_object('error','gemini_cache_requires_gemini_group','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',403); END IF;
    IF p_public_id IS NULL OR p_public_id !~ '^[a-f0-9]{40}$' OR p_upstream_model IS NULL OR p_upstream_model !~ '^[a-zA-Z0-9._-]{1,200}$'
        OR p_display_name IS NULL OR length(p_display_name)>128 THEN RETURN jsonb_build_object('error','invalid_cache_creation','status',400); END IF;
    SELECT * INTO lease FROM s2a_private.personal_gateway_leases WHERE id=p_lease_id FOR UPDATE;
    IF NOT FOUND OR lease.finished_at IS NOT NULL OR lease.expires_at<=clock_timestamp() OR NOT lease.count_only
        OR lease.user_id<>(identity->>'user_id')::bigint OR lease.key_id<>(identity->>'key_id')::bigint OR lease.group_id<>(identity->>'group_id')::bigint
        THEN RETURN jsonb_build_object('error','invalid_cache_reservation','status',409); END IF;
    IF p_action='prepare' THEN
        INSERT INTO s2a_private.cache_creation_intents(public_id,lease_id,user_id,key_id,group_id,account_id,model,upstream_model,display_name)
            VALUES(p_public_id,lease.id,lease.user_id,lease.key_id,lease.group_id,lease.account_id,lease.model,p_upstream_model,p_display_name)
            ON CONFLICT(public_id) DO NOTHING;
    END IF;
    SELECT * INTO intent FROM s2a_private.cache_creation_intents WHERE public_id=p_public_id FOR UPDATE;
    IF NOT FOUND OR intent.lease_id<>lease.id OR intent.upstream_model<>p_upstream_model OR intent.display_name<>p_display_name THEN
        RETURN jsonb_build_object('error','cache_creation_conflict','status',409);
    END IF;
    IF p_action='abandon' THEN
        IF intent.completed_at IS NOT NULL THEN RETURN jsonb_build_object('error','cache_creation_conflict','status',409); END IF;
        UPDATE s2a_private.cache_creation_intents SET abandoned_at=coalesce(abandoned_at,clock_timestamp()) WHERE public_id=p_public_id;
        RETURN jsonb_build_object('abandoned',true);
    END IF;
    IF intent.abandoned_at IS NOT NULL THEN RETURN jsonb_build_object('error','cache_creation_conflict','status',409); END IF;
    IF p_action='prepare' THEN RETURN jsonb_build_object('prepared',true); END IF;
    IF p_action<>'complete' OR p_action IS NULL OR p_upstream_name IS NULL OR (length(p_upstream_name)>495 OR p_upstream_name !~ '^cachedContents/[a-zA-Z0-9_-]+$')
        OR p_expire_time IS NULL OR NOT isfinite(p_expire_time) OR p_expire_time<=clock_timestamp() OR p_expire_time>clock_timestamp()+interval '24 hours 5 seconds'
        OR p_token_count IS NULL OR p_token_count<=0 THEN RETURN jsonb_build_object('error','invalid_cache_upstream_response','status',400); END IF;
    IF intent.completed_at IS NOT NULL THEN
        IF NOT EXISTS(SELECT 1 FROM public.gemini_cached_contents WHERE public_id=p_public_id AND upstream_name=p_upstream_name
            AND expire_time=p_expire_time AND total_token_count=p_token_count) THEN RETURN jsonb_build_object('error','cache_creation_conflict','status',409); END IF;
        RETURN jsonb_build_object('created',true);
    END IF;
    INSERT INTO public.gemini_cached_contents(public_id,user_id,api_key_id,group_id,account_id,upstream_name,model,upstream_model,display_name,total_token_count,expire_time)
        VALUES(intent.public_id,intent.user_id,intent.key_id,intent.group_id,intent.account_id,p_upstream_name,intent.model,intent.upstream_model,intent.display_name,p_token_count,p_expire_time);
    UPDATE s2a_private.cache_creation_intents SET completed_at=clock_timestamp() WHERE public_id=p_public_id;
    RETURN jsonb_build_object('created',true);
END $$;
ALTER FUNCTION public.s2a_personal_cache_create(text,text,uuid,text,text,text,text,timestamptz,bigint,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_cache_create(text,text,uuid,text,text,text,text,timestamptz,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_cache_create(text,text,uuid,text,text,text,text,timestamptz,bigint,text) TO service_role;
-- Scheduled recovery does not depend on a still-enabled client key or local management.
CREATE OR REPLACE FUNCTION public.s2a_personal_cache_jobs_claim()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item public.gemini_cached_contents%ROWTYPE; a s2a_private.accounts%ROWTYPE; snapshot jsonb; token uuid; result jsonb:='[]'::jsonb;
BEGIN
    FOR item IN SELECT * FROM public.gemini_cached_contents WHERE deleted_at IS NULL
        AND mutation_lease IS NOT NULL AND mutation_until<=clock_timestamp()
        ORDER BY mutation_until,id LIMIT 3 FOR UPDATE SKIP LOCKED LOOP
        SELECT * INTO a FROM s2a_private.accounts WHERE id=item.account_id AND deleted_at IS NULL;
        IF NOT FOUND THEN
            UPDATE public.gemini_cached_contents SET deleted_at=clock_timestamp(),mutation_lease=NULL,mutation_until=NULL WHERE id=item.id;
            CONTINUE;
        END IF;
        token:=gen_random_uuid();
        UPDATE public.gemini_cached_contents SET mutation_lease=token,mutation_until=clock_timestamp()+interval '180 seconds' WHERE id=item.id;
        snapshot:=public.s2a_gateway_account_snapshot(a.id);
        IF snapshot ? 'error' THEN CONTINUE; END IF;
        result:=result||jsonb_build_array(jsonb_build_object('id',item.id::text,'lease_id',token::text,
            'upstream_name',item.upstream_name,'expire_time',item.expire_time,
            'account',snapshot||jsonb_build_object('platform',a.platform,'type',a.type,'proxy_id',a.proxy_id::text)));
    END LOOP;
    RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_cache_jobs_finish(p_id bigint,p_lease_id uuid,p_success boolean,p_deleted boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF p_success IS DISTINCT FROM true THEN RETURN false; END IF;
    UPDATE public.gemini_cached_contents SET mutation_lease=NULL,mutation_until=NULL,
        deleted_at=CASE WHEN p_deleted THEN clock_timestamp() ELSE deleted_at END
        WHERE id=p_id AND mutation_lease=p_lease_id AND mutation_until>clock_timestamp() AND deleted_at IS NULL;
    RETURN FOUND;
END $$;
ALTER FUNCTION public.s2a_personal_cache_jobs_claim() OWNER TO s2a_management;
ALTER FUNCTION public.s2a_personal_cache_jobs_finish(bigint,uuid,boolean,boolean) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_cache_jobs_claim() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.s2a_personal_cache_jobs_finish(bigint,uuid,boolean,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_cache_jobs_claim() TO service_role;
GRANT EXECUTE ON FUNCTION public.s2a_personal_cache_jobs_finish(bigint,uuid,boolean,boolean) TO service_role;
CREATE INDEX IF NOT EXISTS cache_creation_pending ON s2a_private.cache_creation_intents(created_at,public_id) WHERE completed_at IS NULL AND abandoned_at IS NULL;
ALTER TABLE s2a_private.cache_creation_intents ADD COLUMN IF NOT EXISTS recovery_lease uuid;
ALTER TABLE s2a_private.cache_creation_intents ADD COLUMN IF NOT EXISTS recovery_until timestamptz;
ALTER TABLE s2a_private.cache_creation_intents ADD COLUMN IF NOT EXISTS recovery_page_token text;
CREATE OR REPLACE FUNCTION public.s2a_personal_cache_creations_claim()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE intent s2a_private.cache_creation_intents%ROWTYPE; a s2a_private.accounts%ROWTYPE; snapshot jsonb; token uuid; result jsonb:='[]'::jsonb;
BEGIN
    FOR intent IN SELECT c.* FROM s2a_private.cache_creation_intents c
        WHERE c.completed_at IS NULL AND c.abandoned_at IS NULL AND c.created_at<clock_timestamp()-interval '180 seconds'
        AND (c.recovery_until IS NULL OR c.recovery_until<=clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM s2a_private.personal_gateway_leases l WHERE l.id=c.lease_id AND l.expires_at+interval '30 seconds'>clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM public.gemini_cached_contents b WHERE b.public_id=c.public_id)
        ORDER BY coalesce(c.recovery_until,c.created_at+interval '180 seconds'),c.public_id LIMIT 2 FOR UPDATE OF c SKIP LOCKED LOOP
        SELECT * INTO a FROM s2a_private.accounts WHERE id=intent.account_id AND deleted_at IS NULL;
        IF NOT FOUND THEN
            UPDATE s2a_private.cache_creation_intents SET abandoned_at=clock_timestamp() WHERE public_id=intent.public_id;
            CONTINUE;
        END IF;
        token:=gen_random_uuid();
        UPDATE s2a_private.cache_creation_intents SET recovery_lease=token,recovery_until=clock_timestamp()+interval '180 seconds' WHERE public_id=intent.public_id;
        snapshot:=public.s2a_gateway_account_snapshot(a.id);
        IF snapshot ? 'error' THEN CONTINUE; END IF;
        result:=result||jsonb_build_array(jsonb_build_object('public_id',intent.public_id,'lease_id',token::text,
            'upstream_model',intent.upstream_model,'page_token',intent.recovery_page_token,
            'account',snapshot||jsonb_build_object('platform',a.platform,'type',a.type,'proxy_id',a.proxy_id::text)));
    END LOOP;
    RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_cache_creations_finish(p_public_id text,p_lease_id uuid,p_complete boolean,p_page_token text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF p_complete IS NULL OR length(p_page_token)>2048 THEN RETURN false; END IF;
    UPDATE s2a_private.cache_creation_intents SET recovery_lease=NULL,
        recovery_until=clock_timestamp()+interval '60 seconds',recovery_page_token=CASE WHEN p_complete THEN NULL ELSE p_page_token END,
        abandoned_at=CASE WHEN p_complete THEN clock_timestamp() ELSE abandoned_at END
        WHERE public_id=p_public_id AND recovery_lease=p_lease_id AND recovery_until>clock_timestamp()
        AND completed_at IS NULL AND abandoned_at IS NULL;
    RETURN FOUND;
END $$;
ALTER FUNCTION public.s2a_personal_cache_creations_claim() OWNER TO s2a_management;
ALTER FUNCTION public.s2a_personal_cache_creations_finish(text,uuid,boolean,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_cache_creations_claim() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.s2a_personal_cache_creations_finish(text,uuid,boolean,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_cache_creations_claim() TO service_role;
GRANT EXECUTE ON FUNCTION public.s2a_personal_cache_creations_finish(text,uuid,boolean,text) TO service_role;
-- Bind asynchronous provider tasks to the key and account that created them.
CREATE TABLE IF NOT EXISTS s2a_private.video_tasks (
    public_id text PRIMARY KEY,lease_id uuid NOT NULL,user_id bigint NOT NULL,key_id bigint NOT NULL,
    group_id bigint NOT NULL,account_id bigint NOT NULL,model text NOT NULL,upstream_model text NOT NULL,
    operation text NOT NULL CHECK(operation IN ('generations','edits','extensions')),
    upstream_id text,state text NOT NULL DEFAULT 'creating' CHECK(state IN ('creating','submitted','rejected')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(account_id,upstream_id)
);
ALTER TABLE s2a_private.video_tasks OWNER TO s2a_management;
ALTER TABLE s2a_private.video_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.video_tasks FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS video_tasks_owner ON s2a_private.video_tasks(key_id,created_at DESC);
CREATE OR REPLACE FUNCTION public.s2a_personal_video_create(p_key_hash text,p_public_id text,p_lease_id uuid,p_upstream_model text,p_operation text,p_action text,p_upstream_id text DEFAULT NULL,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; lease s2a_private.personal_gateway_leases%ROWTYPE; task s2a_private.video_tasks%ROWTYPE;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform' IS DISTINCT FROM 'grok' THEN RETURN jsonb_build_object('error','grok_video_requires_grok_group','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',403); END IF;
    IF p_public_id IS NULL OR p_public_id !~ '^video_[a-f0-9]{40}$' OR p_upstream_model IS NULL OR p_upstream_model !~ '^[a-zA-Z0-9._-]{1,200}$'
        OR p_operation IS NULL OR p_operation NOT IN ('generations','edits','extensions') THEN RETURN jsonb_build_object('error','invalid_video_task','status',400); END IF;
    SELECT * INTO lease FROM s2a_private.personal_gateway_leases WHERE id=p_lease_id FOR UPDATE;
    IF NOT FOUND OR lease.finished_at IS NOT NULL OR lease.expires_at<=clock_timestamp()
        OR lease.user_id<>(identity->>'user_id')::bigint OR lease.key_id<>(identity->>'key_id')::bigint OR lease.group_id<>(identity->>'group_id')::bigint
        THEN RETURN jsonb_build_object('error','invalid_video_reservation','status',409); END IF;
    IF NOT EXISTS(SELECT 1 FROM s2a_private.accounts WHERE id=lease.account_id AND platform='grok' AND deleted_at IS NULL) THEN RETURN jsonb_build_object('error','invalid_video_reservation','status',409); END IF;
    IF p_action='prepare' THEN
        INSERT INTO s2a_private.video_tasks(public_id,lease_id,user_id,key_id,group_id,account_id,model,upstream_model,operation)
            VALUES(p_public_id,lease.id,lease.user_id,lease.key_id,lease.group_id,lease.account_id,lease.model,p_upstream_model,p_operation)
            ON CONFLICT(public_id) DO NOTHING;
    END IF;
    SELECT * INTO task FROM s2a_private.video_tasks WHERE public_id=p_public_id FOR UPDATE;
    IF NOT FOUND OR task.lease_id<>lease.id OR task.upstream_model<>p_upstream_model OR task.operation<>p_operation THEN
        RETURN jsonb_build_object('error','video_task_conflict','status',409);
    END IF;
    IF p_action='prepare' AND task.state='creating' THEN RETURN jsonb_build_object('prepared',true); END IF;
    IF p_action='reject' AND task.state IN ('creating','rejected') THEN
        UPDATE s2a_private.video_tasks SET state='rejected',updated_at=clock_timestamp() WHERE public_id=p_public_id;
        RETURN jsonb_build_object('rejected',true);
    END IF;
    IF p_action IS DISTINCT FROM 'bind' OR p_upstream_id IS NULL OR p_upstream_id !~ '^[a-zA-Z0-9_-]{1,200}$'
        THEN RETURN jsonb_build_object('error','invalid_video_upstream_response','status',400); END IF;
    IF task.state='submitted' AND task.upstream_id=p_upstream_id THEN RETURN jsonb_build_object('bound',true); END IF;
    IF task.state<>'creating' OR EXISTS(SELECT 1 FROM s2a_private.video_tasks WHERE account_id=task.account_id AND upstream_id=p_upstream_id AND public_id<>p_public_id)
        THEN RETURN jsonb_build_object('error','video_task_conflict','status',409); END IF;
    BEGIN
        UPDATE s2a_private.video_tasks SET upstream_id=p_upstream_id,state='submitted',updated_at=clock_timestamp() WHERE public_id=p_public_id;
    EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('error','video_task_conflict','status',409);
    END;
    RETURN jsonb_build_object('bound',true);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_video_resolve(p_key_hash text,p_public_id text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; task s2a_private.video_tasks%ROWTYPE;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform' IS DISTINCT FROM 'grok' THEN RETURN jsonb_build_object('error','grok_video_requires_grok_group','status',400); END IF;
    IF p_public_id IS NULL OR p_public_id !~ '^video_[a-f0-9]{40}$' THEN RETURN jsonb_build_object('error','invalid_video_task','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity || jsonb_build_object('status',403); END IF;
    SELECT * INTO task FROM s2a_private.video_tasks WHERE public_id=p_public_id
        AND user_id=(identity->>'user_id')::bigint AND key_id=(identity->>'key_id')::bigint AND group_id=(identity->>'group_id')::bigint;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','video_task_not_found','status',404); END IF;
    RETURN jsonb_build_object('public_id',task.public_id,'account_id',task.account_id::text,'model',task.model,'upstream_model',task.upstream_model,
        'operation',task.operation,'upstream_id',task.upstream_id,'state',task.state,'created_at',task.created_at);
END $$;
ALTER FUNCTION public.s2a_personal_video_create(text,text,uuid,text,text,text,text,text) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_personal_video_resolve(text,text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_video_create(text,text,uuid,text,text,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.s2a_personal_video_resolve(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_video_create(text,text,uuid,text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.s2a_personal_video_resolve(text,text,text) TO service_role;
NOTIFY pgrst, 'reload schema';
-- Keep a 30-day replay window while bounding transient request storage.
CREATE INDEX IF NOT EXISTS personal_gateway_retention ON s2a_private.personal_gateway_leases(created_at);
CREATE OR REPLACE FUNCTION s2a_private.prune_personal_gateway_leases() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE removed integer; cutoff timestamptz:=clock_timestamp()-interval '30 days';
BEGIN
 WITH expired AS (
  SELECT l.id FROM s2a_private.personal_gateway_leases l
  WHERE l.created_at<cutoff AND l.expires_at<cutoff AND coalesce(l.finished_at,l.created_at)<cutoff
   AND NOT EXISTS(SELECT 1 FROM s2a_private.cache_creation_intents c WHERE c.lease_id=l.id)
   AND NOT EXISTS(SELECT 1 FROM s2a_private.video_tasks v WHERE v.lease_id=l.id)
  ORDER BY l.created_at LIMIT 1000 FOR UPDATE OF l SKIP LOCKED
 ) DELETE FROM s2a_private.personal_gateway_leases l USING expired e WHERE l.id=e.id;
 GET DIAGNOSTICS removed=ROW_COUNT;
 RETURN removed;
END $$;
ALTER FUNCTION s2a_private.prune_personal_gateway_leases() OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.prune_personal_gateway_leases() FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
