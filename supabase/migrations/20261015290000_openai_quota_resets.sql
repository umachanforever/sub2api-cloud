create table public.s2a_openai_quota_resets (
 id uuid primary key default gen_random_uuid(),
 account_id uuid references public.s2a_accounts(id) on delete set null,
 account_fingerprint text not null,
 actor_id uuid references auth.users(id) on delete set null,
 request_keys text[] not null,
 lease_id uuid not null default gen_random_uuid(),lease_until timestamptz not null default now()+interval '3 minutes',
 dispatched_at timestamptz,consumed_result jsonb,response_result jsonb,
 created_at timestamptz not null default now(),completed_at timestamptz,
 check(cardinality(request_keys) between 1 and 128)
);
create unique index s2a_openai_quota_reset_pending on public.s2a_openai_quota_resets(account_fingerprint) where completed_at is null;
create index s2a_openai_quota_reset_keys on public.s2a_openai_quota_resets using gin(request_keys);
alter table public.s2a_openai_quota_resets enable row level security;
revoke all on public.s2a_openai_quota_resets from public,anon,authenticated,service_role;

create function public.s2a_openai_quota_reset_begin(p_account_id uuid,p_actor_id uuid,p_key text,p_version bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.s2a_accounts;j public.s2a_openai_quota_resets;
begin
 if p_key is null or p_key !~ '^[A-Za-z0-9._:-]{1,128}$' then raise exception 'invalid_idempotency_key';end if;
 select * into a from public.s2a_accounts where id=p_account_id for update;
 if not found then return jsonb_build_object('error','account_not_found','status',404);end if;
 if a.platform<>'openai' or a.type<>'oauth' then return jsonb_build_object('error','openai_quota_requires_oauth','status',400);end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(a.account_fingerprint,514));
 select * into j from public.s2a_openai_quota_resets where account_fingerprint=a.account_fingerprint and p_key=any(request_keys) order by created_at desc limit 1 for update;
 if found and j.completed_at is not null then return jsonb_build_object('response',j.response_result,'replayed',true);end if;
 if not found then
  select * into j from public.s2a_openai_quota_resets where account_fingerprint=a.account_fingerprint and completed_at is null for update;
 end if;
 if j.id is not null then
  if not p_key=any(j.request_keys) then
   if cardinality(j.request_keys)>=128 then return jsonb_build_object('error','quota_reset_retry_limit','status',429);end if;
   update public.s2a_openai_quota_resets set request_keys=array_append(request_keys,p_key) where id=j.id;
  end if;
  if j.lease_until>now() then return jsonb_build_object('error','openai_quota_reset_in_progress','status',409);end if;
 end if;
 if a.credential_version is distinct from p_version then return jsonb_build_object('error','account_credentials_changed_retry','status',409);end if;
 if j.id is null then
  insert into public.s2a_openai_quota_resets(account_id,account_fingerprint,actor_id,request_keys)
   values(a.id,a.account_fingerprint,p_actor_id,array[p_key]) returning * into j;
 else
  update public.s2a_openai_quota_resets set account_id=a.id,lease_id=gen_random_uuid(),lease_until=now()+interval '3 minutes' where id=j.id returning * into j;
 end if;
 return jsonb_build_object('id',j.id,'lease_id',j.lease_id,'consumed',j.consumed_result);
end $$;

create function public.s2a_openai_quota_reset_dispatch(p_id uuid,p_lease_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 update public.s2a_openai_quota_resets set dispatched_at=coalesce(dispatched_at,now())
  where id=p_id and lease_id=p_lease_id and lease_until>now() and completed_at is null and consumed_result is null;
 return found;
end $$;
create function public.s2a_openai_quota_reset_consumed(p_id uuid,p_lease_id uuid,p_result jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare credit jsonb:='{}';entry record;clean jsonb;
begin
 if p_result is null or jsonb_typeof(p_result)<>'object' or octet_length(p_result::text)>8192
  or jsonb_typeof(p_result->'code') is distinct from 'string' or p_result->>'code' !~ '^[a-z][a-z0-9_]{0,63}$'
  or jsonb_typeof(p_result->'windows_reset') is distinct from 'number' or p_result->>'windows_reset' !~ '^[0-9]+$'
  or (p_result->>'windows_reset')::numeric>1000000 then raise exception 'invalid_quota_reset_result';end if;
 if p_result->'credit' is not null and p_result->'credit'<>'null'::jsonb then
  if jsonb_typeof(p_result->'credit')<>'object' then raise exception 'invalid_quota_reset_result';end if;
  for entry in select * from jsonb_each(p_result->'credit') loop
   if entry.key in ('id','reset_type','status','granted_at','expires_at','redeem_started_at','redeemed_at') then
    if jsonb_typeof(entry.value)<>'string' or length(entry.value#>>'{}')>512 or entry.value#>>'{}' ~ '[[:cntrl:]]' then raise exception 'invalid_quota_reset_result';end if;
    credit:=credit||jsonb_build_object(entry.key,entry.value);
   end if;
  end loop;
 else credit:='null'::jsonb;end if;
 clean:=jsonb_build_object('code',p_result->'code','windows_reset',p_result->'windows_reset','credit',credit);
 update public.s2a_openai_quota_resets set consumed_result=coalesce(consumed_result,clean)
  where id=p_id and lease_id=p_lease_id and completed_at is null and dispatched_at is not null;
 return found;
end $$;
create function public.s2a_openai_quota_reset_finish(p_id uuid,p_lease_id uuid,p_response jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_response is null or jsonb_typeof(p_response)<>'object' or octet_length(p_response::text)>512*1024
 or p_response?'account' or jsonb_typeof(p_response->'cache_refreshed') is distinct from 'boolean'
 or jsonb_typeof(p_response->'account_state_recovered') is distinct from 'boolean' then raise exception 'invalid_quota_reset_response';end if;
 update public.s2a_openai_quota_resets set response_result=consumed_result||jsonb_build_object('quota',p_response->'quota','cache_refreshed',p_response->'cache_refreshed','account_state_recovered',p_response->'account_state_recovered')||case when p_response?'warning_code' then jsonb_build_object('warning_code',p_response->'warning_code') else '{}'::jsonb end,completed_at=now()
  where id=p_id and lease_id=p_lease_id and consumed_result is not null and completed_at is null;
 return found;
end $$;
revoke all on function public.s2a_openai_quota_reset_begin(uuid,uuid,text,bigint),public.s2a_openai_quota_reset_dispatch(uuid,uuid),public.s2a_openai_quota_reset_consumed(uuid,uuid,jsonb),public.s2a_openai_quota_reset_finish(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_openai_quota_reset_begin(uuid,uuid,text,bigint),public.s2a_openai_quota_reset_dispatch(uuid,uuid),public.s2a_openai_quota_reset_consumed(uuid,uuid,jsonb),public.s2a_openai_quota_reset_finish(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
