alter table public.s2a_keys
  add column if not exists quota_total bigint check (quota_total is null or quota_total >= 0),
  add column if not exists quota_used bigint not null default 0 check (quota_used >= 0);

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

create or replace function public.s2a_finish(
  p_lease_id uuid, p_status integer, p_outcome text,
  p_input_tokens bigint default null, p_output_tokens bigint default null,
  p_cache_creation_tokens bigint default null, p_cache_read_tokens bigint default null,
  p_cooldown_seconds integer default 0
) returns void language plpgsql set search_path = '' as $$
declare l public.s2a_leases; used bigint := coalesce(p_input_tokens,0) + coalesce(p_output_tokens,0);
begin
  select * into l from public.s2a_leases where id = p_lease_id for update;
  if not found then return; end if;
  insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,model,status,outcome,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,duration_ms)
    select l.id,l.request_id,l.account_id,l.key_id,k.user_id,l.model,p_status,p_outcome,p_input_tokens,p_output_tokens,p_cache_creation_tokens,p_cache_read_tokens,
      greatest(0,floor(extract(epoch from (clock_timestamp()-l.started_at))*1000)::integer) from public.s2a_keys k where k.id=l.key_id;
  update public.s2a_keys set quota_used = quota_used + used where id = l.key_id and quota_total is not null;
  if p_cooldown_seconds > 0 then update public.s2a_accounts set cooldown_until = greatest(coalesce(cooldown_until,now()),now()+make_interval(secs=>least(p_cooldown_seconds,3600))) where id=l.account_id; end if;
  delete from public.s2a_leases where id=l.id;
end $$;
revoke all on function public.s2a_acquire(text,text,uuid,uuid[],boolean) from public, anon, authenticated;
revoke all on function public.s2a_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer) from public, anon, authenticated;
grant execute on function public.s2a_acquire(text,text,uuid,uuid[],boolean) to service_role;
grant execute on function public.s2a_finish(uuid,integer,text,bigint,bigint,bigint,bigint,integer) to service_role;
