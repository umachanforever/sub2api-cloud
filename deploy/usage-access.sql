-- Read-only usage tokens inherit the linked API key's group and access restrictions.
BEGIN;
CREATE TABLE IF NOT EXISTS s2a_private.usage_tokens (
    token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    api_key_id bigint NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
ALTER TABLE s2a_private.usage_tokens OWNER TO s2a_management;
ALTER TABLE s2a_private.usage_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON s2a_private.usage_tokens FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.s2a_personal_usage_accounts(
    p_key_hash text,p_client_ip text DEFAULT NULL,p_account_id bigint DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE identity jsonb; resolved_hash text; address inet; network text; allowed boolean; accounts jsonb;
BEGIN
    resolved_hash:=p_key_hash;
    SELECT k.s2a_key_hash INTO resolved_hash FROM s2a_private.usage_tokens t
        JOIN public.api_keys k ON k.id=t.api_key_id
        WHERE t.token_hash=p_key_hash AND t.revoked_at IS NULL;
    resolved_hash:=coalesce(resolved_hash,p_key_hash);
    identity:=public.s2a_gateway_key_lookup(resolved_hash);
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
    SELECT coalesce(jsonb_agg(public.s2a_gateway_account_snapshot(a.id) || jsonb_build_object(
        'name',a.name,'status',a.status,'proxy_id',a.proxy_id::text,'quota_snapshot',(SELECT coalesce(jsonb_object_agg(e.key,e.value),'{}'::jsonb)
            FROM jsonb_each(coalesce(a.extra,'{}'::jsonb)) e
            WHERE e.key ~ '^codex_(usage_updated_at|(5h|7d)_(used_percent|window_minutes|reset_after_seconds|reset_at))$')) ORDER BY a.id),'[]'::jsonb)
    INTO accounts FROM (
        SELECT a.* FROM s2a_private.accounts a
        JOIN public.account_groups ag ON ag.account_id=a.id
        WHERE ag.group_id=(identity->>'group_id')::bigint AND a.platform=identity->>'platform'
            AND a.deleted_at IS NULL AND a.status='active' AND a.type='oauth' AND a.platform='openai'
            AND (p_account_id IS NULL OR a.id=p_account_id)
        ORDER BY a.id LIMIT 21
    ) a;
    IF jsonb_array_length(accounts)>20 THEN RETURN jsonb_build_object('error','account_id_required','status',400); END IF;
    IF p_account_id IS NOT NULL AND jsonb_array_length(accounts)=0 THEN RETURN jsonb_build_object('error','account_not_found','status',404); END IF;
    RETURN jsonb_build_object('accounts',accounts);
END $$;
ALTER FUNCTION public.s2a_personal_usage_accounts(text,text,bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_personal_usage_accounts(text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_personal_usage_accounts(text,text,bigint) TO service_role;
COMMIT;
