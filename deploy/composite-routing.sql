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
ALTER FUNCTION s2a_private.composite_detect_platform(text) OWNER TO s2a_management;
ALTER FUNCTION s2a_private.composite_resolve(bigint,text,text) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.composite_detect_platform(text),s2a_private.composite_resolve(bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
