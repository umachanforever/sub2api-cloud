-- Install after native migrations and before gateway-admission.sql.
BEGIN;
CREATE SCHEMA IF NOT EXISTS s2a_private AUTHORIZATION s2a_management;
REVOKE ALL ON SCHEMA s2a_private FROM PUBLIC,anon,authenticated,service_role;
-- Keep database metadata and legacy columns out of the Go pricing JSON contract.
CREATE OR REPLACE FUNCTION s2a_private.gateway_price_card(p_card jsonb,p_intervals jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT coalesce(jsonb_object_agg(key,value),'{}'::jsonb) || jsonb_build_object('intervals',coalesce(p_intervals,'[]'::jsonb))
    FROM jsonb_each(p_card)
    WHERE key = ANY(ARRAY['platform','models','billing_mode','input_price','output_price','cache_write_price',
        'cache_write_1h_price','cache_read_price','fast_multiplier','flex_multiplier','reasoning_effort_multipliers',
        'image_input_price','image_output_price','per_request_price','time_pricing']);
$$;
ALTER FUNCTION s2a_private.gateway_price_card(jsonb,jsonb) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.gateway_price_card(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION s2a_private.gateway_channel_policy(p_group_id bigint) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT jsonb_build_object('id',c.id::text,'model_mapping',coalesce(c.model_mapping,'{}'::jsonb),
        'billing_model_source',coalesce(nullif(c.billing_model_source,''),'channel_mapped'),
        'restrict_models',coalesce(c.restrict_models,false),'apply_pricing_to_account_stats',c.apply_pricing_to_account_stats,
        'model_pricing',coalesce((
            SELECT jsonb_agg(s2a_private.gateway_price_card(to_jsonb(p),(
                SELECT jsonb_agg(to_jsonb(i)-ARRAY['id','pricing_id','created_at','updated_at'] ORDER BY i.sort_order,i.id)
                FROM public.channel_pricing_intervals i WHERE i.pricing_id=p.id
            )) ORDER BY p.id) FROM public.channel_model_pricing p WHERE p.channel_id=c.id
        ),'[]'::jsonb),
        'account_stats_rules',coalesce((
            SELECT jsonb_agg(jsonb_build_object('id',r.id::text,'group_ids',to_jsonb(r.group_ids::text[]),
                'account_ids',to_jsonb(r.account_ids::text[]),'sort_order',r.sort_order,
                'pricing',coalesce((
                    SELECT jsonb_agg(s2a_private.gateway_price_card(to_jsonb(p),(
                        SELECT jsonb_agg(to_jsonb(i)-ARRAY['id','pricing_id','created_at','updated_at'] ORDER BY i.sort_order,i.id)
                        FROM public.channel_account_stats_pricing_intervals i WHERE i.pricing_id=p.id
                    )) ORDER BY p.id) FROM public.channel_account_stats_model_pricing p WHERE p.rule_id=r.id
                ),'[]'::jsonb)) ORDER BY r.sort_order,r.id)
            FROM public.channel_account_stats_pricing_rules r WHERE r.channel_id=c.id
        ),'[]'::jsonb))
    FROM public.channels c JOIN public.channel_groups cg ON cg.channel_id=c.id
    WHERE cg.group_id=p_group_id AND c.status='active';
$$;
ALTER FUNCTION s2a_private.gateway_channel_policy(bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION s2a_private.gateway_channel_policy(bigint) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
