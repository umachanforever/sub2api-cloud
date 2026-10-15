-- Install after account-vault.sql and the native group migrations.
BEGIN;
CREATE OR REPLACE FUNCTION s2a_private.pinned_model_sources(p_group bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE g public.groups; cfg jsonb; sources jsonb;
BEGIN
 SELECT * INTO g FROM public.groups WHERE id=p_group AND deleted_at IS NULL;
 IF NOT FOUND OR g.platform<>'openai' THEN RETURN NULL; END IF;
 cfg:=g.codex_models_manifest_config;
 IF cfg->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RETURN NULL; END IF;
 IF jsonb_typeof(cfg->'account_ids') IS DISTINCT FROM 'array' THEN
  RETURN jsonb_build_object('error','invalid_pinned_model_config','status',503);
 END IF;
 IF jsonb_array_length(cfg->'account_ids') NOT BETWEEN 1 AND 10 THEN
  RETURN jsonb_build_object('error','invalid_pinned_model_config','status',503);
 END IF;
 IF EXISTS(SELECT FROM jsonb_array_elements(cfg->'account_ids') v
  WHERE jsonb_typeof(v)<>'number' OR v::text !~ '^[1-9][0-9]{0,17}$') THEN
  RETURN jsonb_build_object('error','invalid_pinned_model_config','status',503);
 END IF;
 -- Pinned discovery ignores transient scheduler windows and concurrency load.
 -- Membership and persistent eligibility still apply, in configuration order.
 WITH configured AS (
  SELECT (v.value::text)::bigint AS id,min(v.ordinality) AS position
  FROM jsonb_array_elements(cfg->'account_ids') WITH ORDINALITY v(value,ordinality)
  GROUP BY v.value
 ), eligible AS (
  SELECT a.id,a.proxy_id,c.position FROM configured c
  JOIN s2a_private.accounts a ON a.id=c.id
  JOIN public.account_groups ag ON ag.account_id=a.id AND ag.group_id=g.id
  WHERE a.deleted_at IS NULL AND a.platform='openai' AND a.status='active' AND a.schedulable
   AND NOT coalesce(a.auto_pause_on_expired AND a.expires_at<=statement_timestamp(),false)
 ) SELECT coalesce(jsonb_agg(public.s2a_gateway_account_snapshot(id)
    ||jsonb_build_object('proxy_id',proxy_id::text) ORDER BY position),'[]'::jsonb)
 INTO sources FROM eligible;
 RETURN jsonb_build_object('accounts',sources,'fallback_to_scheduler',coalesce(cfg->'fallback_to_scheduler'='true'::jsonb,false),
  'model_allowlist',g.model_allowlist);
END $$;
ALTER FUNCTION s2a_private.pinned_model_sources(bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.pinned_model_sources(bigint) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
