-- Install after native migrations. Proxy credentials are returned only to the cloud service.
BEGIN;
CREATE OR REPLACE FUNCTION public.s2a_gateway_proxy_route(p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE original public.proxies; current_proxy public.proxies; seen bigint[] := '{}';
BEGIN
    IF p_id IS NULL THEN RETURN '{"proxy":null}'; END IF;
    SELECT * INTO original FROM public.proxies WHERE id = p_id AND deleted_at IS NULL;
    IF NOT FOUND THEN RETURN '{"error":"proxy_not_found","status":503}'; END IF;
    IF original.status <> 'active' THEN RETURN '{"error":"proxy_inactive","status":503}'; END IF;
    current_proxy := original;
    LOOP
        IF current_proxy.status = 'active' AND (current_proxy.expires_at IS NULL OR current_proxy.expires_at > now()) THEN EXIT; END IF;
        seen := array_append(seen, current_proxy.id);
        IF current_proxy.fallback_mode = 'direct' THEN RETURN '{"proxy":null}'; END IF;
        IF current_proxy.fallback_mode <> 'proxy' OR current_proxy.backup_proxy_id IS NULL OR current_proxy.backup_proxy_id = ANY(seen) THEN
            current_proxy := original; EXIT;
        END IF;
        SELECT * INTO current_proxy FROM public.proxies WHERE id = current_proxy.backup_proxy_id AND deleted_at IS NULL;
        IF NOT FOUND THEN current_proxy := original; EXIT; END IF;
    END LOOP;
    RETURN jsonb_build_object('proxy', jsonb_build_object(
        'id', current_proxy.id::text, 'protocol', current_proxy.protocol,
        'host', current_proxy.host, 'port', current_proxy.port,
        'username', coalesce(current_proxy.username, ''), 'password', coalesce(current_proxy.password, '')));
END $$;
ALTER FUNCTION public.s2a_gateway_proxy_route(bigint) OWNER TO s2a_management;
REVOKE ALL ON FUNCTION public.s2a_gateway_proxy_route(bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.s2a_gateway_proxy_route(bigint) TO service_role;
COMMIT;
