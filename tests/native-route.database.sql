BEGIN;
SET LOCAL ROLE s2a_management;
DO $$
DECLARE u bigint := current_setting('s2a.acceptance.user_id')::bigint;
    k bigint := current_setting('s2a.acceptance.key_id')::bigint;
    g bigint := current_setting('s2a.acceptance.group_id')::bigint;
    a bigint; v bigint; request uuid := gen_random_uuid(); lease uuid; result jsonb; original jsonb;
    route jsonb := '{"upstream_model":"gpt-5.4","channel_model":"channel-alias","protocol":"responses","stream":true}';
BEGIN
    IF has_function_privilege('anon','public.s2a_gateway_account_route(uuid,bigint,jsonb)','EXECUTE')
        OR has_function_privilege('authenticated','public.s2a_gateway_account_route(uuid,bigint,jsonb)','EXECUTE')
        OR NOT has_function_privilege('service_role','public.s2a_gateway_account_route(uuid,bigint,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'route ACL mismatch'; END IF;
    INSERT INTO public.accounts(name,platform,type,credentials,concurrency)
    VALUES('Route fixture','openai','apikey','{"api_key":"synthetic-route-key"}',2) RETURNING id,s2a_credential_version INTO a,v;
    INSERT INTO public.account_groups(account_id,group_id) VALUES(a,g);
    INSERT INTO s2a_private.gateway_requests(request_id,api_key_id,user_id,group_id,fingerprint,policy,expires_at)
    VALUES(request,k,u,g,repeat('b',64),'{"model":"requested-alias","platform":"openai"}',clock_timestamp()+interval '3 minutes');
    result := public.s2a_gateway_account_reserve(request,a,v);
    IF result ? 'error' THEN RAISE EXCEPTION 'route reservation failed'; END IF;
    lease := (result->>'lease_id')::uuid;
    IF public.s2a_gateway_account_route(lease,v,route||'{"access_token":"secret"}')->>'error'<>'invalid_account_route' THEN RAISE EXCEPTION 'route allowed secret fields'; END IF;
    IF public.s2a_gateway_account_route(lease,v,route||'{"upstream_model":null}')->>'error'<>'invalid_account_route' THEN RAISE EXCEPTION 'route allowed null model'; END IF;
    IF public.s2a_gateway_account_route(lease,v,route||'{"stream":"true"}')->>'error'<>'invalid_account_route' THEN RAISE EXCEPTION 'route allowed string stream'; END IF;
    IF public.s2a_gateway_account_route(lease,v,route||'{"protocol":"models","stream":false}')->>'error'<>'account_route_mismatch' THEN RAISE EXCEPTION 'route changed request kind'; END IF;
    original := public.s2a_gateway_account_route(lease,v,route);
    IF original->'policy'->>'upstream_model'<>'gpt-5.4' OR original->'policy'->'route'->'service_tier'<>'null'::jsonb
        OR original->>'account_id'<>a::text OR original->>'request_id'<>request::text THEN RAISE EXCEPTION 'route lost context'; END IF;
    IF public.s2a_gateway_account_route(lease,v,route||'{"service_tier":null,"reasoning_effort":null}')<>original THEN RAISE EXCEPTION 'route replay changed policy'; END IF;
    IF public.s2a_gateway_account_route(lease,v,route||'{"upstream_model":"other"}')->>'error'<>'account_route_conflict' THEN RAISE EXCEPTION 'route replay changed model'; END IF;
    IF public.s2a_gateway_account_route(lease,v+1,route)->>'error'<>'account_credentials_changed' THEN RAISE EXCEPTION 'route ignored version'; END IF;
    UPDATE public.api_keys SET status='disabled' WHERE id=k;
    IF public.s2a_gateway_account_route(lease,v,route)->>'error'<>'invalid_api_key' THEN RAISE EXCEPTION 'route ignored revoked key'; END IF;
    UPDATE public.api_keys SET status='active' WHERE id=k;
    IF NOT public.s2a_gateway_key_release(request) THEN RAISE EXCEPTION 'request release failed'; END IF;
    IF public.s2a_gateway_key_release(request) THEN RAISE EXCEPTION 'request release was not idempotent'; END IF;
    IF (SELECT released_at FROM s2a_private.gateway_account_leases WHERE lease_id=lease) IS NULL THEN RAISE EXCEPTION 'abandoned request retained account slot'; END IF;
    IF public.s2a_gateway_account_route(lease,v,route)->>'error'<>'request_lease_expired' THEN RAISE EXCEPTION 'route accepted released lease'; END IF;
    IF EXISTS(SELECT FROM s2a_private.gateway_account_leases WHERE lease_id=lease AND policy::text LIKE '%synthetic-route-key%') THEN RAISE EXCEPTION 'route persisted secrets'; END IF;
END $$;
ROLLBACK;
