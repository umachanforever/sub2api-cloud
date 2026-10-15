create or replace function public.s2a_acquire(
  p_key_hash text, p_model text, p_request_id uuid,
  p_excluded uuid[] default '{}', p_count_request boolean default true
) returns jsonb language plpgsql set search_path = '' as $$
declare k public.s2a_keys; a public.s2a_accounts; lease_id uuid;
begin
  select * into k from public.s2a_keys where key_hash = p_key_hash for update;
  if not found or k.revoked or k.expires_at <= now() then return jsonb_build_object('error', 'invalid_api_key', 'status', 401); end if;
  if not exists (select 1 from auth.users u where u.id = k.user_id and (u.banned_until is null or u.banned_until <= now())) then return jsonb_build_object('error', 'invalid_api_key', 'status', 401); end if;
  if not exists (select 1 from public.s2a_groups g where g.id = k.group_id and g.enabled)
    or not exists (select 1 from public.s2a_memberships m where m.user_id = k.user_id and m.group_id = k.group_id) then return jsonb_build_object('error', 'group_access_denied', 'status', 403); end if;
  if k.quota_total is not null and k.quota_used >= k.quota_total then return jsonb_build_object('error', 'quota_exceeded', 'status', 429); end if;
  if p_count_request then
    if k.window_start <= now() - interval '60 seconds' then update public.s2a_keys set window_start = now(), window_count = 0 where id = k.id; k.window_count := 0; end if;
    if k.window_count >= k.rpm then return jsonb_build_object('error', 'rate_limit_exceeded', 'status', 429); end if;
  end if;
  delete from public.s2a_leases where expires_at <= now();
  if (select count(*) from public.s2a_leases l where l.key_id = k.id) >= k.concurrency then return jsonb_build_object('error', 'concurrency_limit_exceeded', 'status', 429); end if;
  select candidate.* into a from public.s2a_accounts candidate join public.s2a_account_groups ag on ag.account_id = candidate.id and ag.group_id = k.group_id
    where candidate.status = 'active' and candidate.schedulable and (not candidate.auto_pause_on_expired or candidate.expires_at is null or candidate.expires_at > now())
      and (candidate.cooldown_until is null or candidate.cooldown_until <= now()) and not (candidate.id = any(p_excluded))
      and (select count(*) from public.s2a_leases l where l.account_id = candidate.id) < candidate.concurrency
    order by candidate.priority, candidate.last_used_at nulls first, candidate.id limit 1 for update skip locked;
  if not found then return jsonb_build_object('error', 'no_available_account', 'status', 503); end if;
  if (select count(*) from public.s2a_leases l where l.account_id = a.id and l.expires_at > now()) >= a.concurrency then return jsonb_build_object('error', 'no_available_account', 'status', 503); end if;
  insert into public.s2a_leases(request_id, account_id, key_id, model) values (p_request_id, a.id, k.id, p_model) returning id into lease_id;
  update public.s2a_accounts set last_used_at = now() where id = a.id;
  if p_count_request then update public.s2a_keys set window_count = window_count + 1 where id = k.id; end if;
  return jsonb_build_object('lease_id', lease_id, 'account', to_jsonb(a));
end $$;

