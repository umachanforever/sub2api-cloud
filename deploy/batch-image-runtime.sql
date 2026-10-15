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
ALTER TABLE s2a_private.batch_image_runtime OWNER TO s2a_management;
ALTER TABLE s2a_private.batch_image_runtime ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.batch_image_runtime FROM PUBLIC,anon,authenticated,service_role;
CREATE INDEX IF NOT EXISTS batch_image_runtime_due ON s2a_private.batch_image_runtime(due_at) WHERE stage IN ('upload','create','poll','index');
CREATE OR REPLACE FUNCTION public.s2a_batch_image_runtime_claim()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE task s2a_private.batch_image_runtime%ROWTYPE;
BEGIN
    SELECT * INTO task FROM s2a_private.batch_image_runtime
        WHERE stage IN ('upload','create','poll','index') AND due_at<=clock_timestamp()
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
DO $$ DECLARE fn regprocedure; BEGIN
    FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('s2a_batch_image_runtime_claim','s2a_batch_image_runtime_checkpoint','s2a_batch_image_runtime_dispatch','s2a_batch_image_runtime_created') LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO s2a_management',fn);
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn);
    END LOOP;
END $$;
COMMIT;
