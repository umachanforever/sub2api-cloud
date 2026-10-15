BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE u bigint:=current_setting('s2a.acceptance.user_id')::bigint;
    k bigint:=current_setting('s2a.acceptance.key_id')::bigint;
    g bigint:=current_setting('s2a.acceptance.group_id')::bigint;
    channel_id bigint; price_id bigint; rule_id bigint; stats_id bigint;
    request uuid:=gen_random_uuid(); policy jsonb; replay jsonb; channel jsonb; contract jsonb;
BEGIN
    IF has_function_privilege('service_role','s2a_private.gateway_channel_policy(bigint)','EXECUTE')
        OR has_function_privilege('anon','s2a_private.gateway_price_card(jsonb,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'pricing helpers exposed'; END IF;
    DELETE FROM public.channel_groups WHERE group_id=g;
    UPDATE public.users SET balance=10,concurrency=0,rpm_limit=0 WHERE id=u;
    UPDATE public.groups SET platform='openai',subscription_type='standard',model_allowlist='{}',model_pricing='[]',long_context_pricing_enabled=true,rpm_limit=0 WHERE id=g;
    UPDATE public.api_keys SET status='active',expires_at=NULL,quota=0,rate_limit_5h=0,rate_limit_1d=0,rate_limit_7d=0,ip_whitelist='[]',ip_blacklist='[]' WHERE id=k;
    UPDATE public.user_platform_quotas SET deleted_at=now() WHERE user_id=u;
    UPDATE public.user_group_rate_multipliers SET rpm_override=0 WHERE user_id=u AND group_id=g;
    INSERT INTO public.channels(name,model_mapping,billing_model_source,restrict_models,apply_pricing_to_account_stats)
    VALUES('Synthetic pricing snapshot','{"openai":{"client-alias":"custom-priced-model"}}','channel_mapped',true,true) RETURNING id INTO channel_id;
    INSERT INTO public.channel_groups(channel_id,group_id) VALUES(channel_id,g);
    INSERT INTO public.channel_model_pricing(channel_id,platform,models,billing_mode,input_price,output_price,cache_write_price,cache_write_1h_price,cache_read_price,fast_multiplier,flex_multiplier,reasoning_effort_multipliers,image_input_price,image_output_price,per_request_price,time_pricing)
    VALUES(channel_id,'openai','["custom-priced-model"]','token',0.000001,0.000002,0.000003,0.000006,0,2,0.5,'{"high":3}',0.000008,0.000009,0.2,
        '{"timezone":"UTC","periods":[{"start_time":"00:00","end_time":"12:00","multiplier":0.5},{"start_time":"12:00","end_time":"00:00","multiplier":0.5}]}') RETURNING id INTO price_id;
    INSERT INTO public.channel_pricing_intervals(pricing_id,min_tokens,max_tokens,input_price,sort_order) VALUES(price_id,1000,NULL,0.000005,9),(price_id,0,1000,0.000003,1);
    INSERT INTO public.channel_account_stats_pricing_rules(channel_id,group_ids,account_ids,sort_order) VALUES(channel_id,ARRAY[g],ARRAY[9007199254740993::bigint],2) RETURNING id INTO rule_id;
    INSERT INTO public.channel_account_stats_model_pricing(rule_id,platform,models,input_price,cache_write_1h_price,reasoning_effort_multipliers)
    VALUES(rule_id,'openai','["custom-priced-model"]',0.000001,0.000002,'{"high":2}') RETURNING id INTO stats_id;
    INSERT INTO public.channel_account_stats_pricing_intervals(pricing_id,min_tokens,max_tokens,input_price,sort_order) VALUES(stats_id,0,1000,0.000002,1);
    policy:=public.s2a_gateway_key_admit((SELECT s2a_key_hash FROM public.api_keys WHERE id=k),request,'custom-priced-model');
    IF policy ? 'error' THEN RAISE EXCEPTION 'pricing admission failed: %',policy->>'error'; END IF;
    channel:=policy->'channel_policy';
    IF channel->>'id' IS DISTINCT FROM channel_id::text OR channel->>'billing_model_source' IS DISTINCT FROM 'channel_mapped'
        OR channel->'model_mapping'->'openai'->>'client-alias' IS DISTINCT FROM 'custom-priced-model'
        OR (channel->>'restrict_models')::boolean IS NOT TRUE
        OR (channel->>'apply_pricing_to_account_stats')::boolean IS NOT TRUE
        OR channel->'model_pricing'->0->'cache_read_price' IS DISTINCT FROM '0'::jsonb
        OR channel->'model_pricing'->0 ? 'max_reasoning_effort_multiplier'
        OR channel->'model_pricing'->0->'intervals'->0->'min_tokens' IS DISTINCT FROM '0'::jsonb
        OR channel->'account_stats_rules'->0->'account_ids'->>0 IS DISTINCT FROM '9007199254740993'
        OR channel->'account_stats_rules'->0->'pricing'->0->'intervals'->0->'input_price' IS DISTINCT FROM '0.000002'::jsonb
        THEN RAISE EXCEPTION 'native pricing serialization mismatch'; END IF;
    UPDATE public.channel_model_pricing SET input_price=9,output_price=8 WHERE id=price_id;
    DELETE FROM public.channel_pricing_intervals WHERE pricing_id=price_id;
    UPDATE public.channels SET status='disabled',model_mapping='{}' WHERE id=channel_id;
    replay:=public.s2a_gateway_key_admit((SELECT s2a_key_hash FROM public.api_keys WHERE id=k),request,'custom-priced-model');
    IF replay IS DISTINCT FROM policy OR policy->>'pricing_at' IS NULL THEN RAISE EXCEPTION 'request pricing changed during replay'; END IF;
    IF s2a_private.gateway_channel_policy(g) IS NOT NULL THEN RAISE EXCEPTION 'disabled channel returned pricing'; END IF;
    contract:=jsonb_build_object('input',jsonb_build_object('model','custom-priced-model','platform','openai',
        'accountStats',jsonb_build_object('accountId','9007199254740993','groupId',g::text,'upstreamModel','custom-priced-model','applyPricingToAccountStats',true,'rules',channel->'account_stats_rules','longContextPricingEnabled',true),
        'pricingAt',policy->'pricing_at','tokens',jsonb_build_object('InputTokens',1000,'OutputTokens',100),
        'group',jsonb_build_object('model_pricing',policy->'group_policy'->'model_pricing','long_context_pricing_enabled',policy->'group_policy'->'long_context_pricing_enabled'),
        'channel',channel->'model_pricing'),
        'expected','{"source":"channel","accountStatsCost":0.001,"cost":{"InputCost":0.0015,"ImageInputCost":0,"OutputCost":0.0001,"ImageOutputCost":0,"CacheCreationCost":0,"CacheReadCost":0,"TotalCost":0.0016,"ActualCost":0.0016,"BillingMode":"token","LongContextBillingApplied":false}}'::jsonb);
    PERFORM set_config('s2a.acceptance.pricing_contract',jsonb_build_array(contract)::text,true);
END $$;
SELECT current_setting('s2a.acceptance.pricing_contract');
ROLLBACK;
