-- The gateway hashes incoming bearer keys and reads the native management records.
ALTER TABLE public.api_keys ADD COLUMN s2a_key_hash text;
UPDATE public.api_keys
SET s2a_key_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(key, 'UTF8')), 'hex');
ALTER TABLE public.api_keys ALTER COLUMN s2a_key_hash SET NOT NULL;
ALTER TABLE public.api_keys ADD CONSTRAINT api_keys_s2a_hash_format
    CHECK (s2a_key_hash ~ '^[0-9a-f]{64}$');
CREATE UNIQUE INDEX api_keys_s2a_hash_active ON public.api_keys(s2a_key_hash) WHERE deleted_at IS NULL;

CREATE FUNCTION public.s2a_native_key_hash() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'INSERT' OR NEW.key IS DISTINCT FROM OLD.key THEN
        NEW.s2a_key_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(NEW.key, 'UTF8')), 'hex');
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER s2a_native_key_hash BEFORE INSERT OR UPDATE OF key ON public.api_keys
FOR EACH ROW EXECUTE FUNCTION public.s2a_native_key_hash();

-- This is an identity lookup; request admission and settlement apply their own locks.
CREATE FUNCTION public.s2a_gateway_key_lookup(p_hash text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE k public.api_keys; u public.users; g public.groups;
BEGIN
    IF p_hash IS NULL OR p_hash !~ '^[0-9a-f]{64}$' THEN
        RETURN pg_catalog.jsonb_build_object('error', 'invalid_api_key');
    END IF;
    SELECT * INTO k FROM public.api_keys
    WHERE s2a_key_hash = p_hash AND deleted_at IS NULL;
    IF NOT FOUND OR k.status <> 'active' OR (k.expires_at IS NOT NULL AND k.expires_at <= statement_timestamp()) THEN
        RETURN pg_catalog.jsonb_build_object('error', 'invalid_api_key');
    END IF;
    SELECT * INTO u FROM public.users WHERE id = k.user_id AND deleted_at IS NULL;
    IF NOT FOUND OR u.status <> 'active' THEN
        RETURN pg_catalog.jsonb_build_object('error', 'user_disabled');
    END IF;
    SELECT * INTO g FROM public.groups WHERE id = k.group_id AND deleted_at IS NULL;
    IF NOT FOUND OR g.status <> 'active' THEN
        RETURN pg_catalog.jsonb_build_object('error', 'group_unavailable');
    END IF;
    IF (g.is_exclusive OR u.restrict_public_groups) AND NOT EXISTS (
        SELECT FROM public.user_allowed_groups WHERE user_id = u.id AND group_id = g.id
    ) THEN
        RETURN pg_catalog.jsonb_build_object('error', 'group_forbidden');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'key_id', k.id::text, 'user_id', u.id::text, 'group_id', g.id::text,
        'platform', g.platform, 'subscription_type', g.subscription_type,
        'concurrency', u.concurrency, 'balance', u.balance::text,
        'quota', k.quota::text, 'quota_used', k.quota_used::text,
        'rate_limit_5h', k.rate_limit_5h::text, 'rate_limit_1d', k.rate_limit_1d::text,
        'rate_limit_7d', k.rate_limit_7d::text, 'ip_whitelist', k.ip_whitelist,
        'ip_blacklist', k.ip_blacklist, 'model_allowlist', g.model_allowlist,
        'rate_multiplier', g.rate_multiplier::text
    );
END $$;
REVOKE ALL ON FUNCTION public.s2a_native_key_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.s2a_gateway_key_lookup(text) FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
        GRANT EXECUTE ON FUNCTION public.s2a_gateway_key_lookup(text) TO service_role;
    END IF;
END $$;
