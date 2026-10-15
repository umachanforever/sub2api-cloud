create table public.s2a_user_limits (
 user_id uuid primary key references auth.users(id) on delete cascade,
 concurrency integer not null default 3 check(concurrency between 0 and 1000000),
 rpm_limit integer not null default 0 check(rpm_limit between 0 and 1000000),
 window_start timestamptz not null default now(),
 window_count integer not null default 0 check(window_count>=0)
);
alter table public.s2a_user_limits enable row level security;
revoke all on public.s2a_user_limits from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_user_limits to service_role;

create function public.s2a_user_limits_set(p_user_ids uuid[],p_all boolean default false,
 p_concurrency integer default null,p_rpm_limit integer default null)
returns jsonb language plpgsql set search_path='' as $$
declare affected integer;
begin
 if p_concurrency is null and p_rpm_limit is null or p_concurrency<0 or p_concurrency>1000000 or p_rpm_limit<0 or p_rpm_limit>1000000 then
  return jsonb_build_object('error','invalid_user_limits','status',400);
 end if;
 insert into public.s2a_user_limits(user_id,concurrency,rpm_limit)
  select id,coalesce(p_concurrency,3),coalesce(p_rpm_limit,0) from auth.users
  where p_all or id=any(p_user_ids) order by id
  on conflict(user_id) do update set
   concurrency=coalesce(p_concurrency,s2a_user_limits.concurrency),
   rpm_limit=coalesce(p_rpm_limit,s2a_user_limits.rpm_limit);
 get diagnostics affected = row_count;
 return jsonb_build_object('affected',affected);
end $$;
revoke all on function public.s2a_user_limits_set(uuid[],boolean,integer,integer) from public,anon,authenticated;
grant execute on function public.s2a_user_limits_set(uuid[],boolean,integer,integer) to service_role;

alter function public.s2a_acquire(text,text,uuid,uuid[],boolean) rename to s2a_acquire_key;
create function public.s2a_acquire(p_key_hash text,p_model text,p_request_id uuid,
 p_excluded uuid[] default '{}',p_count_request boolean default true)
returns jsonb language plpgsql set search_path='' as $$
declare owner_id uuid; limits public.s2a_user_limits; result jsonb;
begin
 select user_id into owner_id from public.s2a_keys where key_hash=p_key_hash;
 if owner_id is null then return jsonb_build_object('error','invalid_api_key','status',401); end if;
 insert into public.s2a_user_limits(user_id) values(owner_id) on conflict do nothing;
 select * into limits from public.s2a_user_limits where user_id=owner_id for update;
 if limits.concurrency>0 and (select count(*) from public.s2a_leases l join public.s2a_keys k on k.id=l.key_id
    where k.user_id=owner_id and l.expires_at>now())>=limits.concurrency then
  return jsonb_build_object('error','user_concurrency_limit_exceeded','status',429);
 end if;
 if p_count_request and limits.rpm_limit>0 and limits.window_start>now()-interval '60 seconds' and limits.window_count>=limits.rpm_limit then
  return jsonb_build_object('error','user_rate_limit_exceeded','status',429);
 end if;
 result := public.s2a_acquire_key(p_key_hash,p_model,p_request_id,p_excluded,p_count_request);
 if result ? 'lease_id' and p_count_request then
  update public.s2a_user_limits set
   window_count=case when window_start<=now()-interval '60 seconds' then 1 else window_count+1 end,
   window_start=case when window_start<=now()-interval '60 seconds' then now() else window_start end
   where user_id=owner_id;
 end if;
 return result;
end $$;
-- The IP-aware overload must call the new user-wide limiter after the rename.
create or replace function public.s2a_acquire(p_key_hash text,p_model text,p_request_id uuid,
 p_excluded uuid[],p_count_request boolean,p_client_ip text)
returns jsonb language plpgsql set search_path='' as $$
declare k public.s2a_keys;
begin
 select * into k from public.s2a_keys where key_hash=p_key_hash;
 if not found or k.revoked or k.expires_at<=now() then return jsonb_build_object('error','invalid_api_key','status',401); end if;
 if cardinality(k.ip_blacklist)>0 and p_client_ip is not null and exists(select 1 from unnest(k.ip_blacklist) rule where p_client_ip::inet <<= rule::cidr) then
  return jsonb_build_object('error','ip_restricted','status',403);
 end if;
 if cardinality(k.ip_whitelist)>0 and (p_client_ip is null or not exists(select 1 from unnest(k.ip_whitelist) rule where p_client_ip::inet <<= rule::cidr)) then
  return jsonb_build_object('error','ip_restricted','status',403);
 end if;
 return public.s2a_acquire(p_key_hash,p_model,p_request_id,p_excluded,p_count_request);
exception when invalid_text_representation then return jsonb_build_object('error','ip_restricted','status',403);
end $$;
revoke all on function public.s2a_acquire(text,text,uuid,uuid[],boolean) from public,anon,authenticated;
grant execute on function public.s2a_acquire(text,text,uuid,uuid[],boolean) to service_role;

create or replace function public.s2a_wallet_get(p_user_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare w public.s2a_wallets;
begin
  insert into public.s2a_wallets(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into w from public.s2a_wallets where user_id = p_user_id;
  return jsonb_build_object('user_id', w.user_id, 'balance', w.balance::float8,
    'frozen_balance', w.frozen_balance::float8, 'updated_at', w.updated_at,
    'concurrency',coalesce((select concurrency from public.s2a_user_limits where user_id=p_user_id),3),
    'rpm_limit',coalesce((select rpm_limit from public.s2a_user_limits where user_id=p_user_id),0));
end $$;

