BEGIN;
CREATE TABLE IF NOT EXISTS s2a_private.batch_image_runtime (
    batch_id text PRIMARY KEY REFERENCES public.batch_image_jobs(batch_id) ON DELETE CASCADE,
    user_id bigint NOT NULL,key_id bigint NOT NULL,group_id bigint NOT NULL,account_id bigint NOT NULL,
    key_hash text NOT NULL,request_hash text NOT NULL,
    stage text NOT NULL DEFAULT 'upload' CHECK(stage IN ('upload','create','poll','index','completed','failed')),
    input_ref text,output_ref text,provider_job_name text,
    create_dispatched_at timestamptz,lease_id uuid,lease_until timestamptz,
    due_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    error_code text,
    CHECK(request_hash ~ '^[a-f0-9]{64}$'),
    CHECK(stage NOT IN ('poll','index','completed') OR provider_job_name IS NOT NULL),
    CHECK(stage='upload' OR stage='failed' OR input_ref IS NOT NULL)
);
ALTER TABLE s2a_private.batch_image_runtime ADD COLUMN IF NOT EXISTS cleanup_requested boolean NOT NULL DEFAULT false;
ALTER TABLE s2a_private.batch_image_runtime ADD COLUMN IF NOT EXISTS cleanup_lease uuid;
ALTER TABLE s2a_private.batch_image_runtime ADD COLUMN IF NOT EXISTS cleanup_until timestamptz;
ALTER TABLE s2a_private.batch_image_runtime ADD COLUMN IF NOT EXISTS cleaned_at timestamptz;
ALTER TABLE s2a_private.batch_image_runtime ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE s2a_private.batch_image_runtime ADD COLUMN IF NOT EXISTS credential_version bigint;
ALTER TABLE s2a_private.batch_image_runtime ADD COLUMN IF NOT EXISTS client_ip text;
ALTER TABLE s2a_private.batch_image_runtime ADD COLUMN IF NOT EXISTS ready boolean NOT NULL DEFAULT true;
ALTER TABLE s2a_private.batch_image_runtime OWNER TO s2a_management;
ALTER TABLE s2a_private.batch_image_runtime ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.batch_image_runtime FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS batch_image_runtime_due ON s2a_private.batch_image_runtime(due_at) WHERE stage IN ('upload','create','poll','index');
CREATE OR REPLACE FUNCTION public.s2a_batch_image_runtime_claim()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    WITH abandoned AS (
        UPDATE s2a_private.batch_image_runtime SET stage='failed',error_code='BATCH_UPLOAD_TIMEOUT',updated_at=clock_timestamp()
        WHERE NOT ready AND stage='upload' AND updated_at<clock_timestamp()-interval '10 minutes' RETURNING batch_id
    ) UPDATE public.batch_image_jobs SET status='failed',last_error_code='BATCH_UPLOAD_TIMEOUT',finished_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE batch_id IN (SELECT batch_id FROM abandoned);
    SELECT * INTO task FROM s2a_private.batch_image_runtime
        WHERE ready AND stage IN ('upload','create','poll','index') AND due_at<=clock_timestamp()
        AND (lease_until IS NULL OR lease_until<=clock_timestamp())
        ORDER BY due_at,batch_id FOR UPDATE SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
    UPDATE s2a_private.batch_image_runtime SET lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '180 seconds',updated_at=clock_timestamp()
        WHERE batch_id=task.batch_id RETURNING * INTO task;
    RETURN jsonb_build_array(to_jsonb(task)||jsonb_build_object('recover_create',task.stage='create' AND task.create_dispatched_at IS NOT NULL));
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_runtime_checkpoint(p_id text,p_lease uuid,p_input text,p_output text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF NOT FOUND OR task.lease_id IS DISTINCT FROM p_lease OR task.lease_until<=clock_timestamp() OR task.lease_until IS NULL
        THEN RETURN jsonb_build_object('error','batch_image_lease_lost','status',409); END IF;
    IF p_input IS NULL OR length(p_input) NOT BETWEEN 1 AND 1024 OR p_output IS NULL OR length(p_output) NOT BETWEEN 1 AND 1024
        OR p_input ~ '[[:cntrl:]]' OR p_output ~ '[[:cntrl:]]' THEN RETURN jsonb_build_object('error','invalid_batch_image_checkpoint','status',400); END IF;
    IF task.stage='create' AND task.input_ref=p_input AND task.output_ref=p_output THEN RETURN jsonb_build_object('applied',false); END IF;
    IF task.stage<>'upload' THEN RETURN jsonb_build_object('error','batch_image_stage_conflict','status',409); END IF;
    UPDATE s2a_private.batch_image_runtime SET stage='create',input_ref=p_input,output_ref=p_output,updated_at=clock_timestamp() WHERE batch_id=p_id;
    RETURN jsonb_build_object('applied',true);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_runtime_dispatch(p_id text,p_lease uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF NOT FOUND OR task.lease_id IS DISTINCT FROM p_lease OR task.lease_until IS NULL OR task.lease_until<=clock_timestamp()
        THEN RETURN jsonb_build_object('error','batch_image_lease_lost','status',409); END IF;
    IF task.stage<>'create' OR task.create_dispatched_at IS NOT NULL THEN RETURN jsonb_build_object('error','batch_image_create_already_dispatched','status',409); END IF;
    UPDATE s2a_private.batch_image_runtime SET create_dispatched_at=clock_timestamp(),updated_at=clock_timestamp() WHERE batch_id=p_id;
    RETURN jsonb_build_object('dispatched',true);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_runtime_created(p_id text,p_lease uuid,p_name text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF NOT FOUND OR task.lease_id IS DISTINCT FROM p_lease OR task.lease_until IS NULL OR task.lease_until<=clock_timestamp()
        THEN RETURN jsonb_build_object('error','batch_image_lease_lost','status',409); END IF;
    IF p_name IS NULL OR length(p_name) NOT BETWEEN 1 AND 512 OR p_name ~ '[[:cntrl:]]' THEN RETURN jsonb_build_object('error','invalid_batch_image_provider_job','status',400); END IF;
    IF task.stage='poll' AND task.provider_job_name=p_name THEN RETURN jsonb_build_object('applied',false); END IF;
    IF task.stage<>'create' OR task.create_dispatched_at IS NULL THEN RETURN jsonb_build_object('error','batch_image_stage_conflict','status',409); END IF;
    UPDATE s2a_private.batch_image_runtime SET stage='poll',provider_job_name=p_name,due_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp() WHERE batch_id=p_id;
    UPDATE public.batch_image_jobs SET provider_job_name=p_name,status='submitted',submitted_at=coalesce(submitted_at,clock_timestamp()),updated_at=clock_timestamp() WHERE batch_id=p_id;
    RETURN jsonb_build_object('applied',true);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_runtime_observed(p_id text,p_lease uuid,p_state text,p_output text DEFAULT NULL,p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE; next_stage text; native_status text;
BEGIN
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF NOT FOUND OR task.lease_id IS DISTINCT FROM p_lease OR task.lease_until IS NULL OR task.lease_until<=clock_timestamp()
        THEN RETURN jsonb_build_object('error','batch_image_lease_lost','status',409); END IF;
    IF task.stage<>'poll' THEN RETURN jsonb_build_object('error','batch_image_stage_conflict','status',409); END IF;
    IF p_state IS NULL OR p_state NOT IN ('queued','running','succeeded','failed','cancelled','expired')
        OR (p_error IS NOT NULL AND p_error !~ '^[A-Z][A-Z0-9_]{0,99}$')
        OR (p_output IS NOT NULL AND (length(p_output) NOT BETWEEN 1 AND 1024 OR p_output ~ '[[:cntrl:]]'))
        THEN RETURN jsonb_build_object('error','invalid_batch_image_observation','status',400); END IF;
    IF p_state='succeeded' AND p_output IS NULL THEN RETURN jsonb_build_object('error','batch_image_result_missing','status',400); END IF;
    next_stage:=CASE WHEN p_state='succeeded' THEN 'index' WHEN p_state IN ('failed','cancelled','expired') THEN 'failed' ELSE 'poll' END;
    native_status:=CASE WHEN p_state='succeeded' THEN 'indexing' WHEN p_state='queued' THEN 'submitted' ELSE p_state END;
    UPDATE s2a_private.batch_image_runtime SET stage=next_stage,output_ref=coalesce(p_output,output_ref),error_code=p_error,
        due_at=clock_timestamp()+CASE WHEN next_stage='poll' THEN interval '30 seconds' ELSE interval '0 seconds' END,
        lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE batch_id=p_id;
    UPDATE public.batch_image_jobs SET status=native_status,last_error_code=p_error,last_error_message=NULL,
        started_at=CASE WHEN p_state='running' THEN coalesce(started_at,clock_timestamp()) ELSE started_at END,
        cancelled_count=CASE WHEN p_state='cancelled' THEN item_count ELSE cancelled_count END,
        finished_at=CASE WHEN next_stage='failed' THEN coalesce(finished_at,clock_timestamp()) ELSE finished_at END,
        updated_at=clock_timestamp() WHERE batch_id=p_id;
    RETURN jsonb_build_object('applied',true,'stage',next_stage);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_runtime_fail(p_id text,p_lease uuid,p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF NOT FOUND OR task.lease_id IS DISTINCT FROM p_lease OR task.lease_until IS NULL OR task.lease_until<=clock_timestamp()
        THEN RETURN jsonb_build_object('error','batch_image_lease_lost','status',409); END IF;
    IF task.stage IN ('completed','failed') THEN RETURN jsonb_build_object('error','batch_image_stage_conflict','status',409); END IF;
    IF p_error IS NULL OR p_error !~ '^[A-Z][A-Z0-9_]{0,99}$' THEN RETURN jsonb_build_object('error','invalid_batch_image_error','status',400); END IF;
    UPDATE s2a_private.batch_image_runtime SET stage='failed',error_code=p_error,lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE batch_id=p_id;
    UPDATE public.batch_image_jobs SET status='failed',last_error_code=p_error,last_error_message=NULL,finished_at=coalesce(finished_at,clock_timestamp()),updated_at=clock_timestamp() WHERE batch_id=p_id;
    RETURN jsonb_build_object('applied',true);
END $$;
CREATE OR REPLACE FUNCTION s2a_private.batch_model_supported(mapping jsonb,model text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path='' AS $$
    SELECT CASE WHEN mapping IS NULL OR mapping='{}'::jsonb THEN true
        WHEN jsonb_typeof(mapping)<>'object' THEN false
        ELSE EXISTS(SELECT 1 FROM jsonb_object_keys(mapping) pattern
            WHERE model=pattern OR right(pattern,1)='*' AND starts_with(model,left(pattern,-1))) END
$$;
ALTER FUNCTION s2a_private.batch_model_supported(jsonb,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.batch_model_supported(jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
DROP FUNCTION IF EXISTS public.s2a_batch_image_prepare(text,text,text,text,text,integer,text,text);
DROP FUNCTION IF EXISTS public.s2a_batch_image_prepare(text,text,text,text,text,integer,text,text,boolean);
CREATE OR REPLACE FUNCTION public.s2a_batch_image_prepare(p_key_hash text,p_id text,p_hash text,p_model text,p_provider text,p_count integer,p_name text,p_client_ip text DEFAULT NULL,p_vertex_enabled boolean DEFAULT false,p_parent text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; task s2a_private.batch_image_runtime%ROWTYPE; a s2a_private.accounts%ROWTYPE; pattern text; allowed boolean:=false; parent_id text; parent_snapshot jsonb;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform'<>'gemini' OR NOT coalesce((policy->>'allow_batch_image_generation')::boolean,false) THEN RETURN jsonb_build_object('error','batch_image_generation_forbidden','status',403); END IF;
    IF p_id IS NULL OR p_id !~ '^imgbatch_[a-f0-9]{32}$' OR p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$'
        OR p_model IS NULL OR p_model !~ '^[A-Za-z0-9._-]{1,128}$' OR p_provider IS NULL OR p_provider NOT IN ('','gemini_api','vertex')
        OR p_count IS NULL OR p_count NOT BETWEEN 1 AND 200 OR p_name IS NULL OR octet_length(p_name)>255 OR p_name ~ '[[:cntrl:]]'
        THEN RETURN jsonb_build_object('error','invalid_batch_image_request','status',400); END IF;
    IF coalesce((policy->'model_allowlist'->>'enabled')::boolean,false) THEN
        FOR pattern IN SELECT jsonb_array_elements_text(coalesce(policy->'model_allowlist'->'models','[]'::jsonb)) LOOP
            IF lower(p_model)=lower(pattern) OR (right(pattern,1)='*' AND starts_with(lower(p_model),lower(left(pattern,-1)))) THEN allowed:=true; END IF;
        END LOOP;
        IF NOT allowed THEN RETURN jsonb_build_object('error','model_not_allowed','status',403); END IF;
    END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity||jsonb_build_object('status',403); END IF;
    parent_id:=nullif(p_parent,'');
    IF parent_id IS NOT NULL THEN
        IF parent_id=p_id OR parent_id !~ '^imgbatch_[a-f0-9]{32}$' THEN RETURN jsonb_build_object('error','invalid_parent_batch','status',400); END IF;
        parent_snapshot:=public.s2a_batch_image_read(p_key_hash,parent_id,p_client_ip);
        IF parent_snapshot ? 'error' THEN RETURN parent_snapshot; END IF;
        parent_id:=coalesce(parent_snapshot->>'parent_batch_id',parent_id);
    END IF;
    PERFORM 1 FROM public.users WHERE id=(identity->>'user_id')::bigint FOR UPDATE;
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id;
    IF FOUND THEN
        IF task.user_id<>(identity->>'user_id')::bigint OR task.key_id<>(identity->>'key_id')::bigint OR task.group_id<>(identity->>'group_id')::bigint OR task.key_hash<>p_key_hash OR task.request_hash<>p_hash
            OR NOT EXISTS(SELECT 1 FROM public.batch_image_jobs WHERE batch_id=p_id AND (p_provider='' OR provider=p_provider) AND model=p_model AND item_count=p_count AND task_name=p_name)
            THEN RETURN jsonb_build_object('error','batch_image_conflict','status',409); END IF;
        RETURN jsonb_build_object('id',p_id,'ready',task.ready);
    END IF;
    IF p_provider='vertex' AND NOT coalesce(p_vertex_enabled,false) THEN RETURN jsonb_build_object('error','vertex_managed_bucket_required','status',503); END IF;
    SELECT accounts.* INTO a FROM s2a_private.accounts accounts JOIN public.account_groups ag ON ag.account_id=accounts.id
        JOIN public.groups g ON g.id=ag.group_id WHERE g.id=(identity->>'group_id')::bigint AND accounts.platform='gemini'
        AND accounts.type IN ('apikey','service_account') AND (accounts.type<>'service_account' OR coalesce(p_vertex_enabled,false)) AND (p_provider='' OR accounts.type=CASE WHEN p_provider='vertex' THEN 'service_account' ELSE 'apikey' END)
        AND accounts.deleted_at IS NULL AND accounts.status='active' AND accounts.schedulable
        AND s2a_private.batch_model_supported(s2a_private.account_credentials(accounts.id)->'model_mapping',p_model)
        AND NOT coalesce(accounts.auto_pause_on_expired AND accounts.expires_at<=clock_timestamp(),false)
        AND coalesce(accounts.overload_until,'-infinity')<=clock_timestamp() AND coalesce(accounts.rate_limit_reset_at,'-infinity')<=clock_timestamp()
        AND coalesce(accounts.temp_unschedulable_until,'-infinity')<=clock_timestamp() AND (NOT g.require_oauth_only OR accounts.type<>'apikey')
        ORDER BY accounts.priority,accounts.last_used_at NULLS FIRST,accounts.id LIMIT 1 FOR UPDATE OF accounts;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','no_available_batch_account','status',503); END IF;
    INSERT INTO public.batch_image_jobs(batch_id,user_id,api_key_id,account_id,provider,model,item_count,task_name,request_hash,parent_batch_id)
        VALUES(p_id,(identity->>'user_id')::bigint,(identity->>'key_id')::bigint,a.id,CASE WHEN a.type='service_account' THEN 'vertex' ELSE 'gemini_api' END,p_model,p_count,p_name,p_hash,parent_id);
    INSERT INTO s2a_private.batch_image_runtime(batch_id,user_id,key_id,group_id,account_id,key_hash,request_hash,ready,credential_version,client_ip)
        VALUES(p_id,(identity->>'user_id')::bigint,(identity->>'key_id')::bigint,(identity->>'group_id')::bigint,a.id,p_key_hash,p_hash,false,a.s2a_credential_version,p_client_ip);
    RETURN jsonb_build_object('id',p_id,'ready',false);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('error','batch_image_conflict','status',409);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_model_sources(p_key_hash text,p_client_ip text DEFAULT NULL,p_vertex_enabled boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; sources jsonb;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform'<>'gemini' OR NOT coalesce((policy->>'allow_batch_image_generation')::boolean,false) THEN RETURN jsonb_build_object('error','batch_image_generation_forbidden','status',403); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity||jsonb_build_object('status',403); END IF;
    SELECT coalesce(jsonb_agg(jsonb_build_object('provider',CASE WHEN a.type='service_account' THEN 'vertex' ELSE 'gemini_api' END,
        'mapping',coalesce(s2a_private.account_credentials(a.id)->'model_mapping','{}'::jsonb))),'[]'::jsonb) INTO sources
        FROM s2a_private.accounts a JOIN public.account_groups ag ON ag.account_id=a.id JOIN public.groups g ON g.id=ag.group_id
        WHERE g.id=(identity->>'group_id')::bigint AND a.platform='gemini' AND a.type IN ('apikey','service_account')
        AND (a.type<>'service_account' OR coalesce(p_vertex_enabled,false)) AND (NOT g.require_oauth_only OR a.type<>'apikey')
        AND a.deleted_at IS NULL AND a.status='active' AND a.schedulable
        AND NOT coalesce(a.auto_pause_on_expired AND a.expires_at<=clock_timestamp(),false)
        AND coalesce(a.overload_until,'-infinity')<=clock_timestamp() AND coalesce(a.rate_limit_reset_at,'-infinity')<=clock_timestamp()
        AND coalesce(a.temp_unschedulable_until,'-infinity')<=clock_timestamp();
    RETURN jsonb_build_object('sources',sources,'model_allowlist',policy->'model_allowlist');
END $$;
DROP FUNCTION IF EXISTS public.s2a_batch_image_ready(text,text,text,text);
CREATE OR REPLACE FUNCTION public.s2a_batch_image_ready(p_key_hash text,p_id text,p_hash text,p_client_ip text DEFAULT NULL,p_items jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF policy->>'platform'<>'gemini' OR NOT coalesce((policy->>'allow_batch_image_generation')::boolean,false) THEN RETURN jsonb_build_object('error','batch_image_generation_forbidden','status',403); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity||jsonb_build_object('status',403); END IF;
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','batch_image_not_found','status',404); END IF;
    IF task.key_hash IS DISTINCT FROM p_key_hash OR task.request_hash IS DISTINCT FROM p_hash OR task.user_id<>(identity->>'user_id')::bigint OR task.key_id<>(identity->>'key_id')::bigint OR task.group_id<>(identity->>'group_id')::bigint
        THEN RETURN jsonb_build_object('error','batch_image_conflict','status',409); END IF;
    IF NOT task.ready AND task.stage<>'upload' THEN RETURN jsonb_build_object('error','batch_image_stage_conflict','status',409); END IF;
    IF NOT task.ready THEN
        IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' THEN RETURN jsonb_build_object('error','invalid_batch_pending_items','status',400); END IF;
        IF jsonb_array_length(p_items)<>(SELECT item_count FROM public.batch_image_jobs WHERE batch_id=p_id)
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_items) v WHERE jsonb_typeof(v)<>'object' OR jsonb_typeof(v->'custom_id') IS DISTINCT FROM 'string'
                OR octet_length(v->>'custom_id') NOT BETWEEN 1 AND 255 OR v->>'custom_id' ~ '[[:cntrl:]]'
                OR jsonb_typeof(v->'prompt_preview') IS DISTINCT FROM 'string' OR octet_length(v->>'prompt_preview')>8000)
            OR (SELECT count(DISTINCT v->>'custom_id') FROM jsonb_array_elements(p_items) v)<>jsonb_array_length(p_items)
            THEN RETURN jsonb_build_object('error','invalid_batch_pending_items','status',400); END IF;
        INSERT INTO public.batch_image_items(job_id,custom_id,status,image_count,prompt_preview,request_hash)
            SELECT p_id,v->>'custom_id','pending',0,v->>'prompt_preview',p_hash FROM jsonb_array_elements(p_items) v;
    END IF;
    UPDATE s2a_private.batch_image_runtime SET ready=true,updated_at=clock_timestamp() WHERE batch_id=p_id;
    RETURN jsonb_build_object('id',p_id,'ready',true);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_runtime_admit(p_id text,p_lease uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE; native public.batch_image_jobs%ROWTYPE; identity jsonb; policy jsonb; a s2a_private.accounts%ROWTYPE; pattern text; allowed boolean:=false; snapshot jsonb;
BEGIN
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF NOT FOUND OR task.lease_id IS DISTINCT FROM p_lease OR task.lease_until IS NULL OR task.lease_until<=clock_timestamp()
        THEN RETURN jsonb_build_object('error','batch_image_lease_lost','status',409); END IF;
    IF task.stage NOT IN ('upload','create','poll','index') OR NOT task.ready THEN RETURN jsonb_build_object('error','batch_image_stage_conflict','status',409); END IF;
    SELECT * INTO native FROM public.batch_image_jobs WHERE batch_id=p_id;
    IF NOT FOUND OR native.user_id<>task.user_id OR native.api_key_id IS DISTINCT FROM task.key_id OR native.account_id IS DISTINCT FROM task.account_id
        THEN RETURN jsonb_build_object('error','batch_image_binding_changed','status',409); END IF;
    SELECT * INTO a FROM s2a_private.accounts WHERE id=task.account_id AND deleted_at IS NULL AND status='active' AND platform='gemini'
        AND type=CASE WHEN native.provider='vertex' THEN 'service_account' WHEN native.provider='gemini_api' THEN 'apikey' ELSE '' END;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','batch_image_account_unavailable','status',503); END IF;
    IF task.stage IN ('upload','create') AND task.create_dispatched_at IS NULL THEN
        policy:=public.s2a_personal_key_policy(task.key_hash,task.client_ip);
        IF policy ? 'error' THEN RETURN policy; END IF;
        identity:=public.s2a_gateway_key_lookup(task.key_hash);
        IF identity ? 'error' OR (identity->>'user_id')::bigint IS DISTINCT FROM task.user_id OR (identity->>'key_id')::bigint IS DISTINCT FROM task.key_id OR (identity->>'group_id')::bigint IS DISTINCT FROM task.group_id
            OR policy->>'platform'<>'gemini' OR NOT coalesce((policy->>'allow_batch_image_generation')::boolean,false)
            THEN RETURN jsonb_build_object('error','batch_image_identity_changed','status',403); END IF;
        IF NOT a.schedulable OR coalesce(a.auto_pause_on_expired AND a.expires_at<=clock_timestamp(),false)
            OR coalesce(a.overload_until,'-infinity')>clock_timestamp() OR coalesce(a.rate_limit_reset_at,'-infinity')>clock_timestamp()
            OR coalesce(a.temp_unschedulable_until,'-infinity')>clock_timestamp()
            OR NOT EXISTS(SELECT 1 FROM public.account_groups WHERE account_id=a.id AND group_id=task.group_id)
            OR EXISTS(SELECT 1 FROM public.groups WHERE id=task.group_id AND require_oauth_only AND a.type='apikey')
            OR a.s2a_credential_version IS DISTINCT FROM task.credential_version
            OR NOT s2a_private.batch_model_supported(s2a_private.account_credentials(a.id)->'model_mapping',native.model)
            THEN RETURN jsonb_build_object('error','batch_image_account_changed','status',409); END IF;
        IF coalesce((policy->'model_allowlist'->>'enabled')::boolean,false) THEN
            FOR pattern IN SELECT jsonb_array_elements_text(coalesce(policy->'model_allowlist'->'models','[]'::jsonb)) LOOP
                IF lower(native.model)=lower(pattern) OR (right(pattern,1)='*' AND starts_with(lower(native.model),lower(left(pattern,-1)))) THEN allowed:=true; END IF;
            END LOOP;
            IF NOT allowed THEN RETURN jsonb_build_object('error','model_not_allowed','status',403); END IF;
        END IF;
    END IF;
    snapshot:=public.s2a_gateway_account_snapshot(a.id);
    IF snapshot ? 'error' THEN RETURN snapshot||jsonb_build_object('status',503); END IF;
    RETURN jsonb_build_object('account',snapshot||jsonb_build_object('proxy_id',a.proxy_id::text),'provider',native.provider,'model',native.model,'request_hash',task.request_hash);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_runtime_indexed(p_id text,p_lease uuid,p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE; native public.batch_image_jobs%ROWTYPE; item jsonb; token_field text; previews jsonb; successes integer:=0; failures integer:=0;
BEGIN
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF NOT FOUND OR task.lease_id IS DISTINCT FROM p_lease OR task.lease_until IS NULL OR task.lease_until<=clock_timestamp()
        THEN RETURN jsonb_build_object('error','batch_image_lease_lost','status',409); END IF;
    IF task.stage<>'index' THEN RETURN jsonb_build_object('error','batch_image_stage_conflict','status',409); END IF;
    SELECT * INTO native FROM public.batch_image_jobs WHERE batch_id=p_id FOR UPDATE;
    IF p_items IS NULL OR jsonb_typeof(p_items)<>'array' THEN RETURN jsonb_build_object('error','invalid_batch_image_index','status',400); END IF;
    IF jsonb_array_length(p_items)<>native.item_count OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 200
        OR (SELECT count(DISTINCT value->>'custom_id') FROM jsonb_array_elements(p_items))<>jsonb_array_length(p_items)
        THEN RETURN jsonb_build_object('error','invalid_batch_image_index','status',400); END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
        IF jsonb_typeof(item)<>'object' OR jsonb_typeof(item->'custom_id') IS DISTINCT FROM 'string' OR octet_length(item->>'custom_id') NOT BETWEEN 1 AND 255
            OR item->>'custom_id' ~ '[[:cntrl:]]' OR coalesce(item->>'status','') NOT IN ('success','failed')
            OR coalesce(item->>'image_count','') !~ '^[0-9]{1,6}$'
            OR (item ? 'error_code' AND coalesce(item->>'error_code','') !~ '^[A-Z][A-Z0-9_]{0,99}$')
            THEN RETURN jsonb_build_object('error','invalid_batch_image_index','status',400); END IF;
        IF item ? 'usage' THEN
            IF jsonb_typeof(item->'usage')<>'object' OR (item->'usage')-ARRAY['input_tokens','output_tokens','cache_read_tokens']<>'{}'::jsonb THEN RETURN jsonb_build_object('error','invalid_batch_image_usage','status',400); END IF;
            FOREACH token_field IN ARRAY ARRAY['input_tokens','output_tokens','cache_read_tokens'] LOOP
                IF item->'usage' ? token_field THEN
                    IF jsonb_typeof(item->'usage'->token_field)<>'number' OR coalesce(item->'usage'->>token_field,'') !~ '^[0-9]{1,10}$' THEN RETURN jsonb_build_object('error','invalid_batch_image_usage','status',400); END IF;
                    IF (item->'usage'->>token_field)::bigint>2147483647 THEN RETURN jsonb_build_object('error','invalid_batch_image_usage','status',400); END IF;
                END IF;
            END LOOP;
        END IF;
        IF item->>'status'='success' THEN
            IF (item->>'image_count')::integer<1 OR coalesce(item->>'provider_source_object','') !~ ('^batches/'||p_id||'/item-([1-9]|[1-9][0-9]|1[0-9]{2}|200)[.]json$')
                OR coalesce(item->>'mime_type','') !~ '^image/[A-Za-z0-9.+_-]{1,100}$'
                THEN RETURN jsonb_build_object('error','invalid_batch_image_index','status',400); END IF;
            successes:=successes+1;
        ELSE
            IF (item->>'image_count')::integer<>0 THEN RETURN jsonb_build_object('error','invalid_batch_image_index','status',400); END IF;
            failures:=failures+1;
        END IF;
        IF (item ? 'source_line_number' AND coalesce(item->>'source_line_number','') !~ '^[0-9]{1,9}$')
            OR (item ? 'source_byte_offset' AND coalesce(item->>'source_byte_offset','') !~ '^[0-9]{1,15}$')
            OR (item ? 'source_byte_length' AND coalesce(item->>'source_byte_length','') !~ '^[0-9]{1,9}$')
            THEN RETURN jsonb_build_object('error','invalid_batch_image_index','status',400); END IF;
    END LOOP;
    SELECT jsonb_object_agg(custom_id,prompt_preview) INTO previews FROM public.batch_image_items WHERE job_id=p_id;
    DELETE FROM public.batch_image_items WHERE job_id=p_id;
    INSERT INTO public.batch_image_items(job_id,custom_id,status,image_count,provider_source_object,source_line_number,source_byte_offset,source_byte_length,mime_type,file_extension,error_code,indexed_at,billed_amount,prompt_preview)
        SELECT p_id,value->>'custom_id',value->>'status',(value->>'image_count')::integer,value->>'provider_source_object',
            (value->>'source_line_number')::integer,(value->>'source_byte_offset')::bigint,(value->>'source_byte_length')::bigint,
            value->>'mime_type',value->>'file_extension',value->>'error_code',clock_timestamp(),0,previews->>(value->>'custom_id') FROM jsonb_array_elements(p_items);
    INSERT INTO public.usage_logs(user_id,api_key_id,account_id,group_id,request_id,model,requested_model,
        input_tokens,output_tokens,cache_read_tokens,stream,request_type,billing_mode,s2a_personal_details)
        SELECT task.user_id,task.key_id,task.account_id,task.group_id,
            encode(sha256(convert_to('batch:'||p_id||':'||(value->>'custom_id'),'UTF8')),'hex'),left(native.model,100),left(native.model,100),
            coalesce((value->'usage'->>'input_tokens')::integer,0),coalesce((value->'usage'->>'output_tokens')::integer,0),
            coalesce((value->'usage'->>'cache_read_tokens')::integer,0),false,1,'token',
            jsonb_build_object('operation','image_batch','batch_id',p_id,'custom_id',value->>'custom_id','usage',value->'usage')
        FROM jsonb_array_elements(p_items) WHERE value ? 'usage' AND value->'usage'<>'{}'::jsonb;
    UPDATE public.batch_image_jobs SET status='completed',success_count=successes,fail_count=failures,cancelled_count=0,actual_cost=0,
        finished_at=clock_timestamp(),settled_at=clock_timestamp(),output_expires_at=clock_timestamp()+interval '24 hours',updated_at=clock_timestamp() WHERE batch_id=p_id;
    UPDATE s2a_private.batch_image_runtime SET stage='completed',lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE batch_id=p_id;
    RETURN jsonb_build_object('applied',true);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_read(p_key_hash text,p_id text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; task s2a_private.batch_image_runtime%ROWTYPE; native public.batch_image_jobs%ROWTYPE; items jsonb;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity||jsonb_build_object('status',403); END IF;
    IF p_id IS NULL OR p_id !~ '^imgbatch_[a-f0-9]{32}$' THEN RETURN jsonb_build_object('error','invalid_batch_id','status',400); END IF;
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','batch_image_not_found','status',404); END IF;
    IF task.user_id IS DISTINCT FROM (identity->>'user_id')::bigint OR task.key_id IS DISTINCT FROM (identity->>'key_id')::bigint OR task.group_id IS DISTINCT FROM (identity->>'group_id')::bigint
        THEN RETURN jsonb_build_object('error','batch_image_forbidden','status',403); END IF;
    SELECT * INTO native FROM public.batch_image_jobs WHERE batch_id=p_id AND user_deleted_at IS NULL;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','batch_image_not_found','status',404); END IF;
    SELECT coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object('custom_id',custom_id,'status',status,'image_count',image_count,
        'prompt_preview',prompt_preview,'mime_type',mime_type,'file_extension',file_extension,'error_code',error_code)) ORDER BY id),'[]'::jsonb) INTO items FROM public.batch_image_items WHERE job_id=p_id;
    RETURN jsonb_strip_nulls(jsonb_build_object('id',native.batch_id,'batch_id',native.batch_id,'object','image.batch','status',native.status,
        'parent_batch_id',native.parent_batch_id,'provider',native.provider,'model',native.model,'task_name',native.task_name,'item_count',native.item_count,'success_count',native.success_count,
        'fail_count',native.fail_count,'cancelled_count',native.cancelled_count,'created_at',native.created_at,'finished_at',native.finished_at,
        'estimated_cost',native.estimated_cost,'hold_amount',native.hold_amount,'actual_cost',native.actual_cost,
        'submitted_at',native.submitted_at,'settled_at',native.settled_at,'output_deleted_at',native.output_deleted_at,
        'output_expires_at',native.output_expires_at,'downloaded_at',native.downloaded_at,'output_deletion_pending',task.cleanup_requested AND task.cleaned_at IS NULL,'error_code',native.last_error_code,'items',items));
END $$;
DROP FUNCTION IF EXISTS public.s2a_batch_image_list(text,integer,integer,text);
CREATE OR REPLACE FUNCTION public.s2a_batch_image_list(p_key_hash text,p_limit integer DEFAULT 20,p_offset integer DEFAULT 0,p_client_ip text DEFAULT NULL,p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; entries jsonb; total bigint;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity||jsonb_build_object('status',403); END IF;
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 1000000 THEN RETURN jsonb_build_object('error','invalid_batch_pagination','status',400); END IF;
    SELECT count(*) INTO total FROM s2a_private.batch_image_runtime r JOIN public.batch_image_jobs j ON j.batch_id=r.batch_id
        WHERE r.user_id=(identity->>'user_id')::bigint AND r.key_id=(identity->>'key_id')::bigint AND r.group_id=(identity->>'group_id')::bigint AND j.user_deleted_at IS NULL
            AND (coalesce(p_filters->>'status','') IN ('','all') OR j.status=CASE p_filters->>'status' WHEN 'queued' THEN 'submitted' WHEN 'processing_results' THEN 'indexing' ELSE p_filters->>'status' END)
            AND (coalesce(p_filters->>'task_name','')='' OR position(lower(p_filters->>'task_name') IN lower(coalesce(j.task_name,'')))>0)
            AND (NOT p_filters ? 'downloaded' OR (j.downloaded_at IS NOT NULL)=(p_filters->>'downloaded')::boolean)
            AND (NOT p_filters ? 'from' OR j.created_at>=(p_filters->>'from')::timestamptz)
            AND (NOT p_filters ? 'to' OR j.created_at<=(p_filters->>'to')::timestamptz);
    SELECT coalesce(jsonb_agg(public.s2a_batch_image_read(p_key_hash,q.batch_id,p_client_ip)-'items' ORDER BY q.created_at DESC,q.batch_id DESC),'[]'::jsonb) INTO entries
        FROM (SELECT r.batch_id,j.created_at FROM s2a_private.batch_image_runtime r JOIN public.batch_image_jobs j ON j.batch_id=r.batch_id
            WHERE r.user_id=(identity->>'user_id')::bigint AND r.key_id=(identity->>'key_id')::bigint AND r.group_id=(identity->>'group_id')::bigint AND j.user_deleted_at IS NULL
            AND (coalesce(p_filters->>'status','') IN ('','all') OR j.status=CASE p_filters->>'status' WHEN 'queued' THEN 'submitted' WHEN 'processing_results' THEN 'indexing' ELSE p_filters->>'status' END)
            AND (coalesce(p_filters->>'task_name','')='' OR position(lower(p_filters->>'task_name') IN lower(coalesce(j.task_name,'')))>0)
            AND (NOT p_filters ? 'downloaded' OR (j.downloaded_at IS NOT NULL)=(p_filters->>'downloaded')::boolean)
            AND (NOT p_filters ? 'from' OR j.created_at>=(p_filters->>'from')::timestamptz)
            AND (NOT p_filters ? 'to' OR j.created_at<=(p_filters->>'to')::timestamptz)
            ORDER BY j.created_at DESC,r.batch_id DESC LIMIT p_limit OFFSET p_offset) q;
    RETURN jsonb_build_object('object','list','data',entries,'has_more',p_offset+jsonb_array_length(entries)<total,'items',entries,'total',total,'limit',p_limit,'offset',p_offset);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_mark_downloaded(p_key_hash text,p_id text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE snapshot jsonb;
BEGIN
    snapshot:=public.s2a_batch_image_read(p_key_hash,p_id,p_client_ip);
    IF snapshot ? 'error' THEN RETURN snapshot; END IF;
    UPDATE public.batch_image_jobs SET downloaded_at=coalesce(downloaded_at,clock_timestamp()),updated_at=clock_timestamp()
        WHERE batch_id=p_id AND status='completed' AND user_deleted_at IS NULL;
    RETURN jsonb_build_object('applied',FOUND);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_content_resolve(p_key_hash text,p_id text,p_custom_id text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE snapshot jsonb; job public.batch_image_jobs%ROWTYPE; item public.batch_image_items%ROWTYPE;
BEGIN
    snapshot:=public.s2a_batch_image_read(p_key_hash,p_id,p_client_ip);
    IF snapshot ? 'error' THEN RETURN snapshot; END IF;
    SELECT * INTO job FROM public.batch_image_jobs WHERE batch_id=p_id;
    IF coalesce((snapshot->>'output_deletion_pending')::boolean,false) OR job.output_deleted_at IS NOT NULL OR job.output_expires_at IS NOT NULL AND job.output_expires_at<=clock_timestamp()
        THEN RETURN jsonb_build_object('error','batch_image_output_expired','status',410); END IF;
    IF job.status<>'completed' THEN RETURN jsonb_build_object('error','batch_image_not_completed','status',409); END IF;
    SELECT * INTO item FROM public.batch_image_items WHERE job_id=p_id AND custom_id=p_custom_id;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','batch_image_item_not_found','status',404); END IF;
    IF item.status<>'success' OR item.provider_source_object IS NULL THEN RETURN jsonb_build_object('error','batch_image_item_failed','status',409); END IF;
    RETURN jsonb_build_object('custom_id',item.custom_id,'path',item.provider_source_object,'image_count',item.image_count);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_cancel(p_key_hash text,p_id text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE snapshot jsonb; task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    snapshot:=public.s2a_batch_image_read(p_key_hash,p_id,p_client_ip);
    IF snapshot ? 'error' THEN RETURN snapshot; END IF;
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF task.stage IN ('completed','failed') THEN RETURN snapshot; END IF;
    IF task.stage IN ('upload','create') AND task.create_dispatched_at IS NULL THEN
        UPDATE s2a_private.batch_image_runtime SET stage='failed',cancel_requested=true,error_code='BATCH_CANCELLED',lease_id=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE batch_id=p_id;
        UPDATE public.batch_image_jobs SET status='cancelled',cancelled_count=item_count,finished_at=clock_timestamp(),updated_at=clock_timestamp() WHERE batch_id=p_id;
    ELSE
        UPDATE s2a_private.batch_image_runtime SET cancel_requested=true,due_at=clock_timestamp(),updated_at=clock_timestamp() WHERE batch_id=p_id;
    END IF;
    RETURN public.s2a_batch_image_read(p_key_hash,p_id,p_client_ip);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_delete(p_key_hash text,p_id text,p_hide boolean DEFAULT false,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE snapshot jsonb; task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    snapshot:=public.s2a_batch_image_read(p_key_hash,p_id,p_client_ip);
    IF snapshot ? 'error' THEN RETURN snapshot; END IF;
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF task.stage NOT IN ('completed','failed') THEN RETURN jsonb_build_object('error','batch_image_not_terminal','status',409); END IF;
    UPDATE s2a_private.batch_image_runtime SET cleanup_requested=true,updated_at=clock_timestamp() WHERE batch_id=p_id;
    IF p_hide THEN UPDATE public.batch_image_jobs SET user_deleted_at=coalesce(user_deleted_at,clock_timestamp()),updated_at=clock_timestamp() WHERE batch_id=p_id; END IF;
    RETURN jsonb_build_object('id',p_id,'deleted',coalesce(p_hide,false),'output_deletion_pending',task.cleaned_at IS NULL);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_cleanup_claim()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE; provider text;
BEGIN
    SELECT r.* INTO task FROM s2a_private.batch_image_runtime r JOIN public.batch_image_jobs j ON j.batch_id=r.batch_id
        WHERE r.stage IN ('completed','failed') AND r.cleaned_at IS NULL AND (r.cleanup_until IS NULL OR r.cleanup_until<=clock_timestamp())
        AND (r.cleanup_requested OR coalesce(j.output_expires_at,j.finished_at+interval '24 hours',r.updated_at+interval '24 hours')<=clock_timestamp())
        ORDER BY r.updated_at,r.batch_id FOR UPDATE OF r SKIP LOCKED LIMIT 1;
    IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
    UPDATE s2a_private.batch_image_runtime SET cleanup_requested=true,cleanup_lease=gen_random_uuid(),cleanup_until=clock_timestamp()+interval '180 seconds' WHERE batch_id=task.batch_id RETURNING * INTO task;
    SELECT j.provider INTO provider FROM public.batch_image_jobs j WHERE j.batch_id=task.batch_id;
    RETURN jsonb_build_array(to_jsonb(task)||jsonb_build_object('provider',provider));
END $$;
CREATE OR REPLACE FUNCTION public.s2a_batch_image_cleanup_finish(p_id text,p_lease uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    SELECT * INTO task FROM s2a_private.batch_image_runtime WHERE batch_id=p_id FOR UPDATE;
    IF NOT FOUND OR task.cleanup_lease IS DISTINCT FROM p_lease OR task.cleanup_until IS NULL OR task.cleanup_until<=clock_timestamp()
        THEN RETURN jsonb_build_object('error','batch_image_cleanup_lease_lost','status',409); END IF;
    IF task.stage NOT IN ('completed','failed') THEN RETURN jsonb_build_object('error','batch_image_not_terminal','status',409); END IF;
    UPDATE s2a_private.batch_image_runtime SET cleaned_at=clock_timestamp(),cleanup_lease=NULL,cleanup_until=NULL WHERE batch_id=p_id;
    UPDATE public.batch_image_jobs SET output_deleted_at=coalesce(output_deleted_at,clock_timestamp()),input_deleted_at=coalesce(input_deleted_at,clock_timestamp()),
        status=CASE WHEN status='completed' THEN 'output_deleted' ELSE status END,updated_at=clock_timestamp() WHERE batch_id=p_id;
    RETURN jsonb_build_object('applied',true);
END $$;
DO $$ DECLARE fn regprocedure; BEGIN
    FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('s2a_batch_image_runtime_claim','s2a_batch_image_runtime_checkpoint','s2a_batch_image_runtime_dispatch','s2a_batch_image_runtime_created','s2a_batch_image_runtime_observed','s2a_batch_image_runtime_fail','s2a_batch_image_prepare','s2a_batch_image_model_sources','s2a_batch_image_ready','s2a_batch_image_runtime_admit','s2a_batch_image_runtime_indexed','s2a_batch_image_read','s2a_batch_image_list','s2a_batch_image_content_resolve','s2a_batch_image_mark_downloaded','s2a_batch_image_cancel','s2a_batch_image_delete','s2a_batch_image_cleanup_claim','s2a_batch_image_cleanup_finish') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO s2a_management',fn);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn);
    END LOOP;
END $$;
COMMIT;
