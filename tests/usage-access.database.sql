BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE u bigint; g bigint; other_g bigint; k bigint; a bigint; other_a bigint; second_a bigint; disabled_a bigint; result jsonb;
    key_hash text:=encode(sha256(convert_to('synthetic-usage-inference-key','UTF8')),'hex');
    usage_hash text:=encode(sha256(convert_to('synthetic-usage-readonly-key','UTF8')),'hex');
BEGIN
    IF has_function_privilege('anon','public.s2a_personal_usage_accounts(text,text,bigint)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_personal_usage_accounts(text,text,bigint)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_personal_usage_accounts(text,text,bigint)','EXECUTE')
        OR has_table_privilege('service_role','s2a_private.usage_tokens','SELECT') THEN RAISE EXCEPTION 'usage ACL mismatch'; END IF;
    INSERT INTO public.users(email,password_hash) VALUES('usage-fixture-'||gen_random_uuid()::text||'@example.invalid','!fixture') RETURNING id INTO u;
    INSERT INTO public.groups(name,platform) VALUES('Usage fixture','openai') RETURNING id INTO g;
    INSERT INTO public.groups(name,platform) VALUES('Other usage fixture','openai') RETURNING id INTO other_g;
    INSERT INTO public.api_keys(user_id,group_id,key,name) VALUES(u,g,'synthetic-usage-inference-key','Usage fixture') RETURNING id INTO k;
    INSERT INTO public.accounts(name,platform,type,credentials,extra,schedulable)
        VALUES('Usage fixture','openai','oauth','{"access_token":"synthetic-provider-secret"}',
        '{"codex_5h_used_percent":12,"codex_7d_used_percent":34,"private_value":"never-expose"}',false) RETURNING id INTO a;
    INSERT INTO public.accounts(name,platform,type,credentials) VALUES('Other fixture','openai','oauth','{"access_token":"other-secret"}') RETURNING id INTO other_a;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g),(other_a,other_g);
    INSERT INTO s2a_private.usage_tokens(token_hash,api_key_id,name) VALUES(usage_hash,k,'Usage fixture');
    result:=public.s2a_personal_usage_accounts(usage_hash);
    IF jsonb_array_length(result->'accounts')<>1 OR result->'accounts'->0->>'id' IS DISTINCT FROM a::text
        OR result->'accounts'->0->'quota_snapshot'->>'codex_5h_used_percent' IS DISTINCT FROM '12'
        OR result->'accounts'->0->'quota_snapshot' ? 'private_value' THEN RAISE EXCEPTION 'usage projection or group isolation mismatch'; END IF;
    INSERT INTO public.accounts(name,platform,type,credentials) VALUES('Second enabled fixture','openai','oauth','{"access_token":"second-secret"}') RETURNING id INTO second_a;
    INSERT INTO public.accounts(name,platform,type,credentials,status) VALUES('Disabled fixture','openai','oauth','{"access_token":"disabled-secret"}','inactive') RETURNING id INTO disabled_a;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(second_a,g),(disabled_a,g);
    result:=public.s2a_personal_usage_accounts(usage_hash);
    IF jsonb_array_length(result->'accounts')<>2
        OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'accounts') entry WHERE entry->>'id'=second_a::text AND entry->>'name'='Second enabled fixture')
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(result->'accounts') entry WHERE entry->>'id'=disabled_a::text)
        THEN RAISE EXCEPTION 'enabled account names or status filtering mismatch'; END IF;
    IF public.s2a_personal_usage_accounts(key_hash) IS DISTINCT FROM result THEN RAISE EXCEPTION 'inference key not accepted'; END IF;
    IF public.s2a_gateway_key_lookup(usage_hash)->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'usage token accepted for inference'; END IF;
    IF public.s2a_personal_usage_accounts(usage_hash,NULL,other_a)->>'error' IS DISTINCT FROM 'account_not_found' THEN RAISE EXCEPTION 'other group disclosed'; END IF;
    UPDATE public.api_keys SET ip_whitelist='["203.0.113.0/24"]' WHERE id=k;
    IF public.s2a_personal_usage_accounts(usage_hash,'198.51.100.1')->>'error' IS DISTINCT FROM 'ip_forbidden' THEN RAISE EXCEPTION 'IP allowlist ignored'; END IF;
    IF public.s2a_personal_usage_accounts(usage_hash,'203.0.113.2') ? 'error' THEN RAISE EXCEPTION 'allowed IP rejected'; END IF;
    UPDATE public.api_keys SET ip_whitelist='[]',ip_blacklist='["203.0.113.0/24"]' WHERE id=k;
    IF public.s2a_personal_usage_accounts(usage_hash,'203.0.113.2')->>'error' IS DISTINCT FROM 'ip_forbidden' THEN RAISE EXCEPTION 'IP denylist ignored'; END IF;
    UPDATE public.api_keys SET ip_blacklist='[]',status='disabled' WHERE id=k;
    IF public.s2a_personal_usage_accounts(usage_hash)->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'disabled parent key accepted'; END IF;
    UPDATE public.api_keys SET status='active',expires_at=now()-interval '1 second' WHERE id=k;
    IF public.s2a_personal_usage_accounts(usage_hash)->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'expired parent key accepted'; END IF;
    UPDATE public.api_keys SET expires_at=NULL WHERE id=k;
    UPDATE s2a_private.usage_tokens SET revoked_at=now() WHERE token_hash=usage_hash;
    IF public.s2a_personal_usage_accounts(usage_hash)->>'error' IS DISTINCT FROM 'invalid_api_key' THEN RAISE EXCEPTION 'revoked usage token accepted'; END IF;
END $$;
ROLLBACK;
