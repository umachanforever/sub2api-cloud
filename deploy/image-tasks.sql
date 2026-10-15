BEGIN;
CREATE TABLE IF NOT EXISTS s2a_private.image_tasks (
    id text PRIMARY KEY,user_id bigint NOT NULL,key_id bigint NOT NULL,group_id bigint NOT NULL,
    key_hash text NOT NULL,client_ip text,platform text NOT NULL CHECK(platform IN ('openai','grok')),
    model text NOT NULL,operation text NOT NULL CHECK(operation IN ('generations','edits')),
    content_type text NOT NULL,body_hash text NOT NULL,body_size bigint NOT NULL,
    state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','queued','running','recovering','completed','failed')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
    lease_id uuid,lease_until timestamptz,dispatched_at timestamptz,completed_at timestamptz,
    http_status integer,result_hash text,error_code text,completion_hash text
);
ALTER TABLE s2a_private.image_tasks ADD COLUMN IF NOT EXISTS cleanup_lease_id uuid;
ALTER TABLE s2a_private.image_tasks ADD COLUMN IF NOT EXISTS cleanup_lease_until timestamptz;
ALTER TABLE s2a_private.image_tasks OWNER TO s2a_management;
ALTER TABLE s2a_private.image_tasks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.image_tasks FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS image_tasks_pending ON s2a_private.image_tasks(state,created_at) WHERE state IN ('uploading','queued','running','recovering');
CREATE INDEX IF NOT EXISTS image_tasks_owner ON s2a_private.image_tasks(key_id,created_at DESC);
CREATE OR REPLACE FUNCTION s2a_private.image_task_view(task s2a_private.image_tasks)
RETURNS jsonb LANGUAGE sql STABLE SET search_path='' AS $$
    SELECT jsonb_strip_nulls(jsonb_build_object('id',task.id,'task_id',task.id,'object','image.generation.task',
        'status',CASE WHEN task.state IN ('completed','failed') THEN task.state ELSE 'processing' END,
        'created_at',floor(extract(epoch FROM task.created_at))::bigint,'expires_at',floor(extract(epoch FROM task.expires_at))::bigint,
        'completed_at',floor(extract(epoch FROM task.completed_at))::bigint,'http_status',task.http_status,
        'result_path',CASE WHEN task.state='completed' THEN 'images/'||task.id||'/result.json' END,'result_hash',task.result_hash,
        'error',CASE WHEN task.error_code IS NOT NULL THEN jsonb_build_object('type','api_error','message',task.error_code,'code',task.error_code) END));
$$;
ALTER FUNCTION s2a_private.image_task_view(s2a_private.image_tasks) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.image_task_view(s2a_private.image_tasks) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.s2a_personal_image_task_prepare(p_key_hash text,p_id text,p_model text,p_operation text,p_content_type text,p_body_hash text,p_body_size bigint,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; task s2a_private.image_tasks%ROWTYPE; pattern text; allowed boolean:=false; routing_model text;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF NOT coalesce((policy->>'allow_image_generation')::boolean,false) THEN RETURN jsonb_build_object('error','image_generation_forbidden','status',403); END IF;
    IF coalesce(policy->>'platform','') NOT IN ('openai','grok') THEN RETURN jsonb_build_object('error','image_platform_unsupported','status',400); END IF;
    IF p_id IS NULL OR p_id !~ '^imgtask_[a-f0-9]{32}$' OR p_model IS NULL OR p_model !~ '^[a-zA-Z0-9._:-]{1,200}$'
        OR p_operation IS NULL OR p_operation NOT IN ('generations','edits') OR p_content_type IS NULL OR length(p_content_type) NOT BETWEEN 1 AND 512
        OR p_content_type ~ '[[:cntrl:]]' OR p_body_hash IS NULL OR p_body_hash !~ '^[a-f0-9]{64}$' OR p_body_size IS NULL OR p_body_size NOT BETWEEN 1 AND 268435456
        THEN RETURN jsonb_build_object('error','invalid_image_task','status',400); END IF;
    routing_model:=CASE WHEN policy->>'platform'='grok' AND p_model='grok-imagine' THEN 'grok-imagine-image-quality' ELSE p_model END;
    IF coalesce((policy->'model_allowlist'->>'enabled')::boolean,false) THEN
        FOR pattern IN SELECT jsonb_array_elements_text(coalesce(policy->'model_allowlist'->'models','[]'::jsonb)) LOOP
            IF lower(routing_model)=lower(pattern) OR (right(pattern,1)='*' AND starts_with(lower(routing_model),lower(left(pattern,-1)))) THEN allowed:=true; END IF;
        END LOOP;
        IF NOT allowed THEN RETURN jsonb_build_object('error','model_not_allowed','status',403); END IF;
    END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity||jsonb_build_object('status',403); END IF;
    PERFORM 1 FROM public.users WHERE id=(identity->>'user_id')::bigint FOR UPDATE;
    SELECT * INTO task FROM s2a_private.image_tasks WHERE id=p_id;
    IF FOUND THEN
        IF task.expires_at<=clock_timestamp() OR task.key_hash<>p_key_hash OR task.user_id<>(identity->>'user_id')::bigint OR task.group_id<>(identity->>'group_id')::bigint
            OR task.model<>p_model OR task.operation<>p_operation OR task.body_hash<>p_body_hash OR task.body_size<>p_body_size OR task.content_type<>p_content_type
            OR task.client_ip IS DISTINCT FROM p_client_ip THEN RETURN jsonb_build_object('error','image_task_conflict','status',409); END IF;
        RETURN s2a_private.image_task_view(task);
    END IF;
    IF (SELECT count(*) FROM s2a_private.image_tasks WHERE key_id=(identity->>'key_id')::bigint AND state IN ('uploading','queued','running','recovering') AND expires_at>clock_timestamp())>=4
        OR (SELECT count(*) FROM s2a_private.image_tasks WHERE user_id=(identity->>'user_id')::bigint AND state IN ('uploading','queued','running','recovering') AND expires_at>clock_timestamp())>=16
        THEN RETURN jsonb_build_object('error','image_task_queue_full','status',429); END IF;
    INSERT INTO s2a_private.image_tasks(id,user_id,key_id,group_id,key_hash,client_ip,platform,model,operation,content_type,body_hash,body_size)
        VALUES(p_id,(identity->>'user_id')::bigint,(identity->>'key_id')::bigint,(identity->>'group_id')::bigint,p_key_hash,p_client_ip,policy->>'platform',p_model,p_operation,p_content_type,p_body_hash,p_body_size)
        RETURNING * INTO task;
    RETURN s2a_private.image_task_view(task);
EXCEPTION WHEN unique_violation THEN RETURN jsonb_build_object('error','image_task_conflict','status',409);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_image_task_read(p_key_hash text,p_id text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE policy jsonb; identity jsonb; task s2a_private.image_tasks%ROWTYPE;
BEGIN
    policy:=public.s2a_personal_key_policy(p_key_hash,p_client_ip);
    IF policy ? 'error' THEN RETURN policy; END IF;
    IF p_id IS NULL OR p_id !~ '^imgtask_[a-f0-9]{32}$' THEN RETURN jsonb_build_object('error','invalid_image_task','status',400); END IF;
    identity:=public.s2a_gateway_key_lookup(p_key_hash);
    IF identity ? 'error' THEN RETURN identity||jsonb_build_object('status',403); END IF;
    SELECT * INTO task FROM s2a_private.image_tasks WHERE id=p_id AND expires_at>clock_timestamp();
    IF NOT FOUND THEN RETURN jsonb_build_object('error','image_task_not_found','status',404); END IF;
    IF task.user_id<>(identity->>'user_id')::bigint OR task.key_id<>(identity->>'key_id')::bigint OR task.group_id<>(identity->>'group_id')::bigint
        THEN RETURN jsonb_build_object('error','image_task_forbidden','status',403); END IF;
    RETURN s2a_private.image_task_view(task);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_image_task_ready(p_key_hash text,p_id text,p_client_ip text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE snapshot jsonb; task s2a_private.image_tasks%ROWTYPE;
BEGIN
    snapshot:=public.s2a_personal_image_task_read(p_key_hash,p_id,p_client_ip);
    IF snapshot->>'id' IS NULL THEN RETURN snapshot; END IF;
    SELECT * INTO task FROM s2a_private.image_tasks WHERE id=p_id FOR UPDATE;
    IF task.state='uploading' THEN UPDATE s2a_private.image_tasks SET state='queued' WHERE id=p_id RETURNING * INTO task;
    ELSIF task.state='failed' THEN RETURN jsonb_build_object('error','image_task_conflict','status',409); END IF;
    RETURN s2a_private.image_task_view(task);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_image_jobs_claim()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.image_tasks%ROWTYPE;
BEGIN
    UPDATE s2a_private.image_tasks SET state='failed',http_status=504,error_code='image_task_expired',completed_at=clock_timestamp()
        WHERE expires_at<=clock_timestamp() AND state IN ('uploading','queued','running','recovering');
    UPDATE s2a_private.image_tasks SET state='failed',http_status=504,error_code='image_task_upload_timeout',completed_at=clock_timestamp()
        WHERE state='uploading' AND created_at<clock_timestamp()-interval '5 minutes';
    SELECT * INTO task FROM s2a_private.image_tasks
        WHERE expires_at>clock_timestamp() AND (state='queued' OR (state IN ('running','recovering') AND lease_until<clock_timestamp()))
        ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
    UPDATE s2a_private.image_tasks SET state=CASE WHEN dispatched_at IS NULL THEN 'running' ELSE 'recovering' END,
        lease_id=gen_random_uuid(),lease_until=clock_timestamp()+interval '180 seconds' WHERE id=task.id RETURNING * INTO task;
    RETURN jsonb_build_array(jsonb_build_object('id',task.id,'lease_id',task.lease_id,'recover',task.state='recovering',
        'key_hash',task.key_hash,'client_ip',task.client_ip,'platform',task.platform,'model',task.model,'operation',task.operation,
        'content_type',task.content_type,'body_hash',task.body_hash,'body_size',task.body_size,
        'request_path','images/'||task.id||'/request.bin','result_path','images/'||task.id||'/result.json'));
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_image_job_start(p_id text,p_lease_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.image_tasks%ROWTYPE; identity jsonb; policy jsonb;
BEGIN
    SELECT * INTO task FROM s2a_private.image_tasks WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR task.state<>'running' OR task.lease_id IS DISTINCT FROM p_lease_id OR task.lease_until<=clock_timestamp() OR task.expires_at<=clock_timestamp()
        THEN RETURN jsonb_build_object('error','image_task_lease_lost','status',409); END IF;
    policy:=public.s2a_personal_key_policy(task.key_hash,task.client_ip);
    identity:=public.s2a_gateway_key_lookup(task.key_hash);
    IF policy ? 'error' OR identity ? 'error' OR NOT coalesce((policy->>'allow_image_generation')::boolean,false) OR (identity->>'user_id')::bigint IS DISTINCT FROM task.user_id
        OR (identity->>'key_id')::bigint IS DISTINCT FROM task.key_id OR (identity->>'group_id')::bigint IS DISTINCT FROM task.group_id OR policy->>'platform' IS DISTINCT FROM task.platform THEN
        UPDATE s2a_private.image_tasks SET state='failed',http_status=403,error_code='image_task_key_unavailable',completed_at=clock_timestamp() WHERE id=p_id;
        RETURN jsonb_build_object('error','image_task_key_unavailable','status',403);
    END IF;
    UPDATE s2a_private.image_tasks SET dispatched_at=coalesce(dispatched_at,clock_timestamp()) WHERE id=p_id;
    RETURN jsonb_build_object('started',true);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_image_job_finish(p_id text,p_lease_id uuid,p_http_status integer,p_error_code text DEFAULT NULL,p_result_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.image_tasks%ROWTYPE; digest text;
BEGIN
    IF p_http_status IS NULL OR NOT (p_http_status BETWEEN 200 AND 299 OR p_http_status BETWEEN 400 AND 599)
        OR (p_http_status<300 AND (p_error_code IS NOT NULL OR p_result_hash IS NULL OR p_result_hash !~ '^[a-f0-9]{64}$'))
        OR (p_http_status>=400 AND (p_result_hash IS NOT NULL OR p_error_code IS NULL OR p_error_code NOT IN ('image_task_failed','image_task_timeout','image_task_execution_unknown','image_task_invalid_input','image_task_storage_failed','image_task_key_unavailable')))
        THEN RETURN jsonb_build_object('error','invalid_image_task_completion','status',400); END IF;
    digest:=encode(sha256(convert_to(jsonb_build_array(p_http_status,p_error_code,p_result_hash)::text,'UTF8')),'hex');
    SELECT * INTO task FROM s2a_private.image_tasks WHERE id=p_id FOR UPDATE;
    IF NOT FOUND OR task.lease_id IS DISTINCT FROM p_lease_id THEN RETURN jsonb_build_object('error','image_task_lease_lost','status',409); END IF;
    IF task.completion_hash IS NOT NULL THEN
        IF task.completion_hash<>digest THEN RETURN jsonb_build_object('error','image_task_completion_conflict','status',409); END IF;
        RETURN jsonb_build_object('applied',false);
    END IF;
    IF task.state NOT IN ('running','recovering') OR task.lease_until<=clock_timestamp() OR task.expires_at<=clock_timestamp() OR (p_http_status<300 AND task.dispatched_at IS NULL)
        THEN RETURN jsonb_build_object('error','image_task_lease_lost','status',409); END IF;
    UPDATE s2a_private.image_tasks SET state=CASE WHEN p_http_status<300 THEN 'completed' ELSE 'failed' END,
        completed_at=clock_timestamp(),http_status=p_http_status,result_hash=p_result_hash,error_code=p_error_code,completion_hash=digest WHERE id=p_id;
    RETURN jsonb_build_object('applied',true);
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_image_job_admit(p_id text,p_lease_id uuid,p_key_hash text,p_model text,p_client_ip text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.image_tasks%ROWTYPE; routing_model text;
BEGIN
    SELECT * INTO task FROM s2a_private.image_tasks WHERE id=p_id;
    IF NOT FOUND OR task.state<>'running' OR task.lease_id IS DISTINCT FROM p_lease_id OR task.lease_until<=clock_timestamp()
        OR task.expires_at<=clock_timestamp() OR task.dispatched_at IS NULL OR task.key_hash IS DISTINCT FROM p_key_hash OR task.client_ip IS DISTINCT FROM p_client_ip
        THEN RETURN jsonb_build_object('error','image_task_lease_lost','status',409); END IF;
    routing_model:=CASE WHEN task.platform='grok' AND task.model='grok-imagine' THEN 'grok-imagine-image-quality' ELSE task.model END;
    IF p_model IS DISTINCT FROM routing_model THEN RETURN jsonb_build_object('error','image_task_model_mismatch','status',400); END IF;
    RETURN jsonb_build_object('user_id',task.user_id::text,'key_id',task.key_id::text,'group_id',task.group_id::text);
END $$;
ALTER FUNCTION public.s2a_personal_image_job_admit(text,uuid,text,text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_image_job_admit(text,uuid,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_image_job_admit(text,uuid,text,text,text) TO service_role;
ALTER FUNCTION public.s2a_personal_image_task_prepare(text,text,text,text,text,text,bigint,text) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_personal_image_task_read(text,text,text) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_personal_image_task_ready(text,text,text) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_personal_image_jobs_claim() OWNER TO s2a_management;
ALTER FUNCTION public.s2a_personal_image_job_start(text,uuid) OWNER TO s2a_management;
ALTER FUNCTION public.s2a_personal_image_job_finish(text,uuid,integer,text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_image_task_prepare(text,text,text,text,text,text,bigint,text),public.s2a_personal_image_task_read(text,text,text),public.s2a_personal_image_task_ready(text,text,text),public.s2a_personal_image_jobs_claim(),public.s2a_personal_image_job_start(text,uuid),public.s2a_personal_image_job_finish(text,uuid,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_image_task_prepare(text,text,text,text,text,text,bigint,text),public.s2a_personal_image_task_read(text,text,text),public.s2a_personal_image_task_ready(text,text,text),public.s2a_personal_image_jobs_claim(),public.s2a_personal_image_job_start(text,uuid),public.s2a_personal_image_job_finish(text,uuid,integer,text,text) TO service_role;
CREATE OR REPLACE FUNCTION public.s2a_personal_image_cleanup_claim()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE tasks jsonb;
BEGIN
    WITH candidates AS (
        SELECT id FROM s2a_private.image_tasks WHERE expires_at<clock_timestamp()-interval '5 minutes'
            AND (cleanup_lease_until IS NULL OR cleanup_lease_until<clock_timestamp())
        ORDER BY expires_at,id LIMIT 2 FOR UPDATE SKIP LOCKED
    ), claimed AS (
        UPDATE s2a_private.image_tasks t SET cleanup_lease_id=gen_random_uuid(),cleanup_lease_until=clock_timestamp()+interval '180 seconds'
        FROM candidates c WHERE t.id=c.id RETURNING t.id,t.cleanup_lease_id
    ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'lease_id',cleanup_lease_id)),'[]'::jsonb) INTO tasks FROM claimed;
    RETURN tasks;
END $$;
CREATE OR REPLACE FUNCTION public.s2a_personal_image_cleanup_finish(p_id text,p_lease_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    DELETE FROM s2a_private.image_tasks WHERE id=p_id AND cleanup_lease_id=p_lease_id
        AND cleanup_lease_until>clock_timestamp() AND expires_at<clock_timestamp()-interval '5 minutes';
    RETURN FOUND;
END $$;
ALTER FUNCTION public.s2a_personal_image_cleanup_claim() OWNER TO s2a_management;
ALTER FUNCTION public.s2a_personal_image_cleanup_finish(text,uuid) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_image_cleanup_claim(),public.s2a_personal_image_cleanup_finish(text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_image_cleanup_claim(),public.s2a_personal_image_cleanup_finish(text,uuid) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
