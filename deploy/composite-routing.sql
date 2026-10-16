-- Install after account-vault.sql and the native Composite route migrations.
BEGIN;
CREATE OR REPLACE FUNCTION s2a_private.composite_detect_platform(p_model text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE model text:=lower(btrim(p_model)); provider text; rest text;
BEGIN
 IF starts_with(model,'models/') THEN model:=substr(model,8); END IF;
 IF strpos(model,'/')>1 THEN
  provider:=btrim(split_part(model,'/',1)); rest:=btrim(substr(model,strpos(model,'/')+1));
  CASE provider
   WHEN 'anthropic','claude' THEN RETURN 'anthropic';
   WHEN 'openai','chatgpt' THEN RETURN 'openai';
   WHEN 'google','google-ai-studio','gemini' THEN RETURN 'gemini';
   WHEN 'xai','x-ai','grok' THEN RETURN 'grok';
   WHEN 'kimi','moonshot' THEN RETURN 'kimi';
   WHEN 'zhipu','glm','bigmodel' THEN RETURN 'zhipu';
   WHEN 'deepseek' THEN RETURN 'deepseek';
   WHEN 'minimax' THEN RETURN 'minimax';
   WHEN 'typesafe','jev' THEN RETURN 'typesafe';
   ELSE NULL;
  END CASE;
  IF rest<>'' THEN model:=CASE WHEN starts_with(rest,'models/') THEN substr(rest,8) ELSE rest END; END IF;
 END IF;
 IF model ~ '^(anthropic\.claude-|claude-)' THEN RETURN 'anthropic'; END IF;
 IF model ~ '^(gpt-|chatgpt-|codex-|text-embedding-|text-moderation-|omni-moderation-|dall-e-|tts-|whisper-|o[1345]($|-))' THEN RETURN 'openai'; END IF;
 IF model ~ '^(gemini-|learnlm-)' THEN RETURN 'gemini'; END IF;
 IF model='grok' OR starts_with(model,'grok-') THEN RETURN 'grok'; END IF;
 IF model IN ('k3','k3-256k') OR model ~ '^(kimi-|moonshot-)' THEN RETURN 'kimi'; END IF;
 IF starts_with(model,'glm-') THEN RETURN 'zhipu'; END IF;
 IF starts_with(model,'deepseek-') THEN RETURN 'deepseek'; END IF;
 IF model ~ '^(minimax-|abab[567])' THEN RETURN 'minimax'; END IF;
 IF starts_with(model,'jev-') THEN RETURN 'typesafe'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION s2a_private.composite_resolve(p_group bigint,p_model text,p_endpoint text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE model text:=btrim(p_model); route_endpoint text:=lower(btrim(coalesce(p_endpoint,'')));
 route public.composite_model_routes; platforms text[]; target text;
BEGIN
 IF model IS NULL OR model='' THEN RETURN jsonb_build_object('error','composite_model_required','status',400); END IF;
 IF route_endpoint NOT IN ('messages','count_tokens','responses','chat_completions','embeddings','images','gemini') THEN route_endpoint:='any'; END IF;
 SELECT * INTO route FROM public.composite_model_routes r
 WHERE r.group_id=p_group AND r.deleted_at IS NULL AND r.enabled
  AND r.endpoint IN ('any',route_endpoint)
  AND ((r.match_type='exact' AND btrim(r.public_model)=model) OR (r.match_type='prefix' AND starts_with(model,btrim(r.public_model))))
  AND btrim(r.public_model)<>''
 ORDER BY (r.match_type='exact') DESC,(r.endpoint=route_endpoint) DESC,length(btrim(r.public_model)) DESC,r.priority,r.id LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('platform',route.target_platform,'upstream_model',coalesce(nullif(btrim(route.upstream_model),''),model),'source','route'); END IF;
 SELECT array_agg(DISTINCT a.platform) INTO platforms FROM s2a_private.accounts a
 JOIN public.account_groups ag ON ag.account_id=a.id AND ag.group_id=p_group
 WHERE a.deleted_at IS NULL AND a.status='active' AND a.schedulable
  AND a.platform IN ('anthropic','openai','gemini','antigravity','grok','kimi','zhipu','deepseek','minimax','opencode_go','typesafe')
  AND jsonb_typeof(s2a_private.account_credentials(a.id)->'model_mapping'->model)='string'
  AND btrim(s2a_private.account_credentials(a.id)->'model_mapping'->>model)<>'';
 IF cardinality(platforms)>1 THEN RETURN jsonb_build_object('error','composite_model_ambiguous','status',400); END IF;
 IF cardinality(platforms)=1 THEN RETURN jsonb_build_object('platform',platforms[1],'upstream_model',model,'source','account_model'); END IF;
 target:=s2a_private.composite_detect_platform(model);
 IF target IS NULL THEN RETURN jsonb_build_object('error','composite_model_unresolved','status',400); END IF;
 RETURN jsonb_build_object('platform',target,'upstream_model',model,'source','detector');
END $$;
-- Capability intersections retain accounts under temporary cooldown, matching Go.
CREATE OR REPLACE FUNCTION s2a_private.composite_capability_sources(p_group bigint) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'platform',a.platform,'type',a.type,
  'passthrough',a.platform='openai' AND CASE WHEN jsonb_typeof(a.extra->'openai_passthrough')='boolean' THEN (a.extra->>'openai_passthrough')::boolean WHEN jsonb_typeof(a.extra->'openai_oauth_passthrough')='boolean' THEN (a.extra->>'openai_oauth_passthrough')::boolean ELSE false END,
  'official',CASE WHEN a.platform='openai' AND a.type='oauth' THEN true
   WHEN a.platform='openai' THEN coalesce(nullif(btrim(c.value->>'base_url'),''),'https://api.openai.com') ~* '^https?://api[.]openai[.]com[.]?(:[0-9]+)?(/|$)'
   WHEN a.platform='grok' THEN coalesce(nullif(btrim(c.value->>'base_url'),''),'https://api.x.ai') ~* '^https?://(([a-z0-9-]+[.])*api[.]x[.]ai|cli-chat-proxy[.]grok[.]com)[.]?(:[0-9]+)?(/|$)'
   ELSE false END,
  'mapping',coalesce((SELECT jsonb_object_agg(m.key,m.value) FROM jsonb_each(
   CASE WHEN jsonb_typeof(c.value->'model_mapping')='object' THEN c.value->'model_mapping' ELSE '{}'::jsonb END) m
   WHERE jsonb_typeof(m.value)='string' AND btrim(m.value#>>'{}')<>''),'{}'::jsonb),
  'modalities',coalesce((SELECT jsonb_object_agg(m.key,m.value->'input_modalities') FROM jsonb_each(
   CASE WHEN jsonb_typeof(a.extra->'upstream_model_metadata'->'models')='object' THEN a.extra->'upstream_model_metadata'->'models' ELSE '{}'::jsonb END) m
   WHERE jsonb_typeof(m.value->'input_modalities')='array'),'{}'::jsonb)
 ) ORDER BY a.platform,a.priority,a.id),'[]'::jsonb)
 FROM s2a_private.accounts a JOIN public.account_groups ag ON ag.account_id=a.id
 JOIN public.groups g ON g.id=ag.group_id
 CROSS JOIN LATERAL (SELECT s2a_private.account_credentials(a.id) AS value) c
 WHERE ag.group_id=p_group AND g.platform IN ('composite','anthropic') AND g.deleted_at IS NULL
  AND (g.platform='composite' OR a.platform='anthropic')
  AND a.deleted_at IS NULL AND a.status='active' AND a.schedulable
  AND a.platform IN ('anthropic','openai','gemini','antigravity','grok','kimi','zhipu','deepseek','minimax','opencode_go');
$$;
ALTER FUNCTION s2a_private.composite_capability_sources(bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.composite_capability_sources(bigint) FROM PUBLIC,anon,authenticated,service_role;
-- Public catalog inputs exclude provider credentials and account identifiers.
CREATE OR REPLACE FUNCTION s2a_private.composite_catalog_sources(p_group bigint) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object(
  'capability_sources',s2a_private.composite_capability_sources(p_group),
  'sources',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'platform',a.platform,
   'passthrough',a.platform='openai' AND CASE WHEN jsonb_typeof(a.extra->'openai_passthrough')='boolean' THEN (a.extra->>'openai_passthrough')::boolean WHEN jsonb_typeof(a.extra->'openai_oauth_passthrough')='boolean' THEN (a.extra->>'openai_oauth_passthrough')::boolean ELSE false END,
   'mapping',coalesce((SELECT jsonb_object_agg(m.key,m.value) FROM jsonb_each(
    CASE WHEN jsonb_typeof(s2a_private.account_credentials(a.id)->'model_mapping')='object'
     THEN s2a_private.account_credentials(a.id)->'model_mapping' ELSE '{}'::jsonb END) m
    WHERE jsonb_typeof(m.value)='string' AND btrim(m.value#>>'{}')<>''),'{}'::jsonb)
   ) ORDER BY a.platform,a.priority,a.id)
   FROM s2a_private.accounts a JOIN public.account_groups ag ON ag.account_id=a.id
   JOIN public.groups g ON g.id=ag.group_id
   WHERE ag.group_id=p_group AND g.platform IN ('composite','openai') AND g.deleted_at IS NULL
    AND a.deleted_at IS NULL AND a.status='active' AND a.schedulable
    AND NOT coalesce(a.auto_pause_on_expired AND a.expires_at<=now(),false)
    AND coalesce(a.overload_until,'-infinity')<=now()
    AND coalesce(a.rate_limit_reset_at,'-infinity')<=now()
    AND coalesce(a.temp_unschedulable_until,'-infinity')<=now()
    AND (NOT g.require_oauth_only OR a.type<>'apikey')
    AND (NOT g.require_privacy_set OR a.platform<>'openai' OR a.extra->>'privacy_mode'='training_off')
  ),'[]'::jsonb),
  'routes',coalesce((SELECT jsonb_agg(jsonb_build_object('model',btrim(r.public_model),
    'match_type',r.match_type,'platform',r.target_platform,'endpoint',r.endpoint,
    'upstream_model',coalesce(nullif(btrim(r.upstream_model),''),btrim(r.public_model)))
    ORDER BY (r.match_type='exact') DESC,length(btrim(r.public_model)) DESC,r.priority,r.id)
   FROM public.composite_model_routes r JOIN public.groups g ON g.id=r.group_id
   WHERE r.group_id=p_group AND g.platform='composite' AND g.deleted_at IS NULL
    AND r.deleted_at IS NULL AND r.enabled AND btrim(r.public_model)<>''),'[]'::jsonb)
 );
$$;
ALTER FUNCTION s2a_private.composite_catalog_sources(bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.composite_catalog_sources(bigint) FROM PUBLIC,anon,authenticated,service_role;
ALTER FUNCTION s2a_private.composite_detect_platform(text) OWNER TO s2a_management;
ALTER FUNCTION s2a_private.composite_resolve(bigint,text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.composite_detect_platform(text),s2a_private.composite_resolve(bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
