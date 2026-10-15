-- API key source restrictions. Empty lists keep the key available from every source.
alter table public.s2a_keys
  add column ip_whitelist text[] not null default '{}',
  add column ip_blacklist text[] not null default '{}';

-- Keep the original three/five-argument function for SQL clients and add the
-- source-aware overload used by the gateway.
create function public.s2a_acquire(
  p_key_hash text, p_model text, p_request_id uuid,
  p_excluded uuid[], p_count_request boolean, p_client_ip text
) returns jsonb language plpgsql set search_path = '' as $$
declare k public.s2a_keys;
begin
  select * into k from public.s2a_keys where key_hash = p_key_hash;
  if not found or k.revoked or k.expires_at <= now() then
    return jsonb_build_object('error', 'invalid_api_key', 'status', 401);
  end if;
  if cardinality(k.ip_blacklist) > 0 and (p_client_ip is not null) and exists (
    select 1 from unnest(k.ip_blacklist) rule where p_client_ip::inet <<= rule::cidr
  ) then
    return jsonb_build_object('error', 'ip_restricted', 'status', 403);
  end if;
  if cardinality(k.ip_whitelist) > 0 and (
    p_client_ip is null or not exists (
      select 1 from unnest(k.ip_whitelist) rule where p_client_ip::inet <<= rule::cidr
    )
  ) then
    return jsonb_build_object('error', 'ip_restricted', 'status', 403);
  end if;
  return public.s2a_acquire(p_key_hash, p_model, p_request_id, p_excluded, p_count_request);
exception when invalid_text_representation then
  return jsonb_build_object('error', 'ip_restricted', 'status', 403);
end $$;

revoke all on function public.s2a_acquire(text,text,uuid,uuid[],boolean,text) from public, anon, authenticated;
grant execute on function public.s2a_acquire(text,text,uuid,uuid[],boolean,text) to service_role;
