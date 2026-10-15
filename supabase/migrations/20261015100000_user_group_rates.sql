create table public.s2a_user_group_rates (
 user_id uuid not null references auth.users(id) on delete cascade,
 group_id uuid not null references public.s2a_groups(id) on delete cascade,
 rate_multiplier numeric(18,6) not null check(rate_multiplier>0 and rate_multiplier<=1000000),
 primary key(user_id,group_id)
);
create index s2a_user_group_rates_group on public.s2a_user_group_rates(group_id,user_id);
alter table public.s2a_user_group_rates enable row level security;
revoke all on public.s2a_user_group_rates from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_user_group_rates to service_role;
create trigger s2a_user_group_rates_audit after insert or update or delete on public.s2a_user_group_rates
 for each row execute function public.s2a_audit_mutation();

create function public.s2a_group_rates_set(p_group_id uuid,p_entries jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if p_entries is null or jsonb_typeof(p_entries)<>'array' then return jsonb_build_object('error','invalid_group_rates','status',400);end if;
 if jsonb_array_length(p_entries)>1000 or exists(select 1 from jsonb_array_elements(p_entries) e where jsonb_typeof(e)<>'object') then return jsonb_build_object('error','invalid_group_rates','status',400);end if;
 if exists(select 1 from jsonb_array_elements(p_entries) e where not(e ? 'user_id' and e ? 'rate_multiplier') or jsonb_typeof(e->'user_id')<>'string' or jsonb_typeof(e->'rate_multiplier')<>'number' or (select count(*) from jsonb_object_keys(e))<>2) then return jsonb_build_object('error','invalid_group_rates','status',400);end if;
 if exists(select 1 from jsonb_to_recordset(p_entries) e(user_id uuid,rate_multiplier numeric) where rate_multiplier<=0 or rate_multiplier>1000000 or rate_multiplier<>round(rate_multiplier,6)) then return jsonb_build_object('error','invalid_rate_multiplier','status',400);end if;
 if (select count(distinct user_id) from jsonb_to_recordset(p_entries) e(user_id uuid,rate_multiplier numeric))<>jsonb_array_length(p_entries) then return jsonb_build_object('error','duplicate_user_ids','status',400);end if;
 perform id from public.s2a_groups where id=p_group_id for no key update;
 if not found then return jsonb_build_object('error','group_not_found','status',404);end if;
 if exists(select 1 from jsonb_to_recordset(p_entries) e(user_id uuid,rate_multiplier numeric) where not exists(select 1 from auth.users where id=e.user_id and deleted_at is null)) then return jsonb_build_object('error','user_not_found','status',404);end if;
 insert into public.s2a_user_limits(user_id)
  select user_id from public.s2a_user_group_rates where group_id=p_group_id union select user_id from jsonb_to_recordset(p_entries) e(user_id uuid,rate_multiplier numeric) on conflict do nothing;
 perform user_id from public.s2a_user_limits where user_id in(select user_id from public.s2a_user_group_rates where group_id=p_group_id union select user_id from jsonb_to_recordset(p_entries) e(user_id uuid,rate_multiplier numeric)) order by user_id for update;
 delete from public.s2a_user_group_rates where group_id=p_group_id and user_id not in(select user_id from jsonb_to_recordset(p_entries) e(user_id uuid,rate_multiplier numeric));
 insert into public.s2a_user_group_rates(user_id,group_id,rate_multiplier)
  select user_id,p_group_id,rate_multiplier from jsonb_to_recordset(p_entries) e(user_id uuid,rate_multiplier numeric)
  on conflict(user_id,group_id) do update set rate_multiplier=excluded.rate_multiplier;
 return jsonb_build_object('ok',true);
exception when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('error','invalid_group_rates','status',400);
end $$;
create function public.s2a_group_rates_list(p_group_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.s2a_groups where id=p_group_id) then return jsonb_build_object('error','group_not_found','status',404);end if;
 return coalesce((select jsonb_agg(jsonb_build_object('user_id',r.user_id,'user_name',coalesce(u.raw_user_meta_data->>'username',split_part(u.email,'@',1)),
  'user_email',u.email,'user_notes',coalesce(u.raw_app_meta_data->>'s2a_notes',''),'user_status',case when u.banned_until>now() then 'disabled' else 'active' end,'rate_multiplier',r.rate_multiplier) order by r.user_id)
  from public.s2a_user_group_rates r join auth.users u on u.id=r.user_id and u.deleted_at is null where r.group_id=p_group_id),'[]'::jsonb);
end $$;
revoke all on function public.s2a_group_rates_set(uuid,jsonb) from public,anon,authenticated;
revoke all on function public.s2a_group_rates_list(uuid) from public,anon,authenticated;
grant execute on function public.s2a_group_rates_set(uuid,jsonb) to service_role;
grant execute on function public.s2a_group_rates_list(uuid) to service_role;

drop function public.s2a_user_configure(uuid,uuid[],numeric,integer,integer,uuid);
create function public.s2a_user_configure(p_user_id uuid, p_groups uuid[] default null,
 p_balance numeric default null, p_concurrency integer default null,
 p_rpm_limit integer default null, p_actor_id uuid default null,p_rates jsonb default null)
returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from auth.users where id=p_user_id) then
  return jsonb_build_object('error','user_not_found','status',404);
 end if;
 if p_groups is not null and (cardinality(p_groups)>500 or exists(
  select 1 from unnest(p_groups) requested(group_id) where requested.group_id is null or not exists(select 1 from public.s2a_groups g where g.id=requested.group_id))) then
  return jsonb_build_object('error','invalid_allowed_groups','status',400);
 end if;
 if p_concurrency<0 or p_concurrency>1000000 or p_rpm_limit<0 or p_rpm_limit>1000000 then
  return jsonb_build_object('error','invalid_user_limits','status',400);
 end if;
 if p_balance is not null and (p_balance<0 or p_balance>1000000000 or p_balance<>round(p_balance,8)) then
  return jsonb_build_object('error','invalid_balance','status',400);
 end if;
 if p_rates is not null then
  if jsonb_typeof(p_rates)<>'object' then return jsonb_build_object('error','invalid_group_rates','status',400);end if;
  if (select count(*) from jsonb_each(p_rates))>500 or exists(select 1 from jsonb_each(p_rates) e where jsonb_typeof(value) not in ('number','null')) then return jsonb_build_object('error','invalid_group_rates','status',400);end if;
  if exists(select 1 from jsonb_each_text(p_rates) where value is not null and (value::numeric<=0 or value::numeric>1000000 or value::numeric<>round(value::numeric,6))) then return jsonb_build_object('error','invalid_rate_multiplier','status',400);end if;
  if (select count(distinct key::uuid) from jsonb_each(p_rates))<>(select count(*) from jsonb_each(p_rates)) then return jsonb_build_object('error','duplicate_group_ids','status',400);end if;
  perform id from public.s2a_groups where id in(select key::uuid from jsonb_each(p_rates)) order by id for share;
  if exists(select 1 from jsonb_each(p_rates) where not exists(select 1 from public.s2a_groups where id=key::uuid)) then return jsonb_build_object('error','group_not_found','status',404);end if;
 end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 if p_balance is not null then
  result := public.s2a_wallet_update(p_user_id,p_balance,'set','',p_actor_id);
  if result ? 'error' then return result; end if;
 end if;
 if p_concurrency is not null or p_rpm_limit is not null then
  perform public.s2a_user_limits_set(array[p_user_id],false,p_concurrency,p_rpm_limit);
 end if;
 if p_groups is not null then
  delete from public.s2a_memberships where user_id=p_user_id and not(group_id=any(p_groups));
  insert into public.s2a_memberships(user_id,group_id)
   select p_user_id,id from unnest(p_groups) id on conflict do nothing;
 end if;
 if p_rates is not null then
  if p_rates='{}'::jsonb then delete from public.s2a_user_group_rates where user_id=p_user_id;
  else
   delete from public.s2a_user_group_rates where user_id=p_user_id and group_id in(select key::uuid from jsonb_each_text(p_rates) where value is null);
   insert into public.s2a_user_group_rates(user_id,group_id,rate_multiplier)
    select p_user_id,key::uuid,value::numeric from jsonb_each_text(p_rates) where value is not null
    on conflict(user_id,group_id) do update set rate_multiplier=excluded.rate_multiplier;
  end if;
 end if;
 return jsonb_build_object('ok',true);
exception when invalid_text_representation or numeric_value_out_of_range then return jsonb_build_object('error','invalid_group_rates','status',400);
end $$;
revoke all on function public.s2a_user_configure(uuid,uuid[],numeric,integer,integer,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_user_configure(uuid,uuid[],numeric,integer,integer,uuid,jsonb) to service_role;

create or replace function public.s2a_acquire(p_key_hash text,p_model text,p_request_id uuid,
 p_excluded uuid[],p_count_request boolean,p_client_ip text,p_billing_context jsonb)
returns jsonb language plpgsql set search_path='' as $$
declare k public.s2a_keys; g public.s2a_groups; w public.s2a_wallets; prices jsonb; result jsonb; subscription public.s2a_subscriptions; multiplier numeric;
begin
 if p_billing_context is null or jsonb_typeof(p_billing_context)<>'object' then return jsonb_build_object('error','invalid_billing_context','status',400); end if;
 select * into k from public.s2a_keys where key_hash=p_key_hash;
 if not found or k.revoked or k.expires_at<=now() or not exists(select 1 from auth.users where id=k.user_id and (banned_until is null or banned_until<=now())) then
  return jsonb_build_object('error','invalid_api_key','status',401);
 end if;
 insert into public.s2a_user_limits(user_id) values(k.user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=k.user_id for update;
 select * into k from public.s2a_keys where key_hash=p_key_hash for update;
 if not found or k.revoked or k.expires_at<=now() then return jsonb_build_object('error','invalid_api_key','status',401); end if;
 select * into g from public.s2a_groups where id=k.group_id and enabled;
 if not found or not exists(select 1 from public.s2a_memberships where user_id=k.user_id and group_id=k.group_id) then
  return jsonb_build_object('error','group_access_denied','status',403);
 end if;
 begin
 if cardinality(k.ip_blacklist)>0 and p_client_ip is not null and exists(select 1 from unnest(k.ip_blacklist) rule where p_client_ip::inet <<= rule::cidr) then
  return jsonb_build_object('error','ip_restricted','status',403);
 end if;
 if cardinality(k.ip_whitelist)>0 and (p_client_ip is null or not exists(select 1 from unnest(k.ip_whitelist) rule where p_client_ip::inet <<= rule::cidr)) then
  return jsonb_build_object('error','ip_restricted','status',403);
 end if;
 exception when invalid_text_representation then return jsonb_build_object('error','ip_restricted','status',403);
 end;
 multiplier:=coalesce((select rate_multiplier from public.s2a_user_group_rates where user_id=k.user_id and group_id=g.id),g.rate_multiplier);
 if g.subscription_type='subscription' then
  select * into subscription from public.s2a_subscriptions where user_id=k.user_id and group_id=g.id and status<>'revoked' for update;
  if not found then return jsonb_build_object('error','subscription_required','status',403); end if;
  perform public.s2a_subscription_refresh(subscription.id);
  select * into subscription from public.s2a_subscriptions where id=subscription.id;
  if subscription.status<>'active' or subscription.expires_at<=now() then return jsonb_build_object('error','subscription_inactive','status',403); end if;
  if subscription.starts_at>now() then return jsonb_build_object('error','subscription_not_started','status',403); end if;
  if p_model<>'__models__' then
   if g.daily_limit_usd is not null and subscription.daily_usage_usd>=g.daily_limit_usd then return jsonb_build_object('error','daily_limit_exceeded','status',429); end if;
   if g.weekly_limit_usd is not null and subscription.weekly_usage_usd>=g.weekly_limit_usd then return jsonb_build_object('error','weekly_limit_exceeded','status',429); end if;
   if g.monthly_limit_usd is not null and subscription.monthly_usage_usd>=g.monthly_limit_usd then return jsonb_build_object('error','monthly_limit_exceeded','status',429); end if;
  end if;
 end if;
 if p_model<>'__models__' then
  prices := public.s2a_price_lookup(g.platform,p_model);
  if prices is null then return jsonb_build_object('error','model_pricing_unavailable','status',422); end if;
  if k.monetary_quota is not null and k.monetary_used>=k.monetary_quota then
   return jsonb_build_object('error','monetary_quota_exceeded','status',429);
  end if;
  if g.subscription_type='standard' and multiplier>0 and exists(select 1 from jsonb_each_text(prices) rate where rate.value::numeric>0) then
   insert into public.s2a_wallets(user_id) values(k.user_id) on conflict do nothing;
   select * into w from public.s2a_wallets where user_id=k.user_id for update;
   if w.balance<=w.frozen_balance then return jsonb_build_object('error','insufficient_balance','status',402); end if;
  end if;
 end if;
 result := public.s2a_acquire(p_key_hash,p_model,p_request_id,p_excluded,p_count_request,p_client_ip);
 if result ? 'lease_id' then
  update public.s2a_leases set billing=jsonb_build_object('rates',prices,'platform',g.platform,
   'subscription_id',subscription.id,'group_id',g.id,'rate_multiplier',multiplier,'service_tier',p_billing_context->>'service_tier',
   'stream',coalesce((p_billing_context->>case when result->'account'->>'type'='apikey' then 'native_stream' else 'stream' end)::boolean,false)) where id=(result->>'lease_id')::uuid;
 end if;
 return result;
end $$;

create or replace function public.s2a_wallet_get(p_user_id uuid) returns jsonb
language plpgsql set search_path = '' as $$
declare w public.s2a_wallets;
begin
  insert into public.s2a_wallets(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select * into w from public.s2a_wallets where user_id = p_user_id;
  return jsonb_build_object('user_id', w.user_id, 'balance', w.balance::float8,
    'frozen_balance', w.frozen_balance::float8, 'updated_at', w.updated_at,
    'concurrency',coalesce((select concurrency from public.s2a_user_limits where user_id=p_user_id),3),
    'group_rates',coalesce((select jsonb_object_agg(group_id,rate_multiplier) from public.s2a_user_group_rates where user_id=p_user_id),'{}'::jsonb),
    'rpm_limit',coalesce((select rpm_limit from public.s2a_user_limits where user_id=p_user_id),0));
end $$;


notify pgrst,'reload schema';
