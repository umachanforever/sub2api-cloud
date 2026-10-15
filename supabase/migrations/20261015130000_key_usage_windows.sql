alter table public.s2a_keys
 add column rate_limit_5h numeric(20,8) not null default 0 check(rate_limit_5h>=0),
 add column rate_limit_1d numeric(20,8) not null default 0 check(rate_limit_1d>=0),
 add column rate_limit_7d numeric(20,8) not null default 0 check(rate_limit_7d>=0),
 add column usage_5h numeric(20,8) not null default 0 check(usage_5h>=0),
 add column usage_1d numeric(20,8) not null default 0 check(usage_1d>=0),
 add column usage_7d numeric(20,8) not null default 0 check(usage_7d>=0),
 add column window_5h_start timestamptz,
 add column window_1d_start timestamptz,
 add column window_7d_start timestamptz;
create function public.s2a_key_window_usage() returns trigger
language plpgsql set search_path='' as $$
begin
 if new.actual_cost>0 then
  update public.s2a_keys set
   usage_5h=case when window_5h_start+interval '5 hours'<=now() then new.actual_cost else usage_5h+new.actual_cost end,
   usage_1d=case when window_1d_start+interval '24 hours'<=now() then new.actual_cost else usage_1d+new.actual_cost end,
   usage_7d=case when window_7d_start+interval '7 days'<=now() then new.actual_cost else usage_7d+new.actual_cost end,
   window_5h_start=case when window_5h_start is null or window_5h_start+interval '5 hours'<=now() then now() else window_5h_start end,
   window_1d_start=case when window_1d_start is null or window_1d_start+interval '24 hours'<=now() then date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' else window_1d_start end,
   window_7d_start=case when window_7d_start is null or window_7d_start+interval '7 days'<=now() then date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' else window_7d_start end
  where id=new.key_id and deleted_at is null;
 end if;
 return new;
end $$;
revoke all on function public.s2a_key_window_usage() from public,anon,authenticated;
create trigger s2a_key_window_usage after insert on public.s2a_usage for each row execute function public.s2a_key_window_usage();
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
 if not found or (g.subscription_type='standard' and not public.s2a_group_can_bind(k.user_id,k.group_id)) then
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
  if k.rate_limit_5h>0 and k.window_5h_start+interval '5 hours'>now() and k.usage_5h>=k.rate_limit_5h then return jsonb_build_object('error','api_key_rate_5h_exceeded','status',429);end if;
  if k.rate_limit_1d>0 and k.window_1d_start+interval '24 hours'>now() and k.usage_1d>=k.rate_limit_1d then return jsonb_build_object('error','api_key_rate_1d_exceeded','status',429);end if;
  if k.rate_limit_7d>0 and k.window_7d_start+interval '7 days'>now() and k.usage_7d>=k.rate_limit_7d then return jsonb_build_object('error','api_key_rate_7d_exceeded','status',429);end if;
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

create table public.s2a_key_create_attempts (
 user_id uuid primary key references auth.users(id) on delete cascade,
 failures integer not null default 0 check(failures>=0),
 window_start timestamptz not null default now()
);
alter table public.s2a_key_create_attempts enable row level security;
revoke all on public.s2a_key_create_attempts from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_key_create_attempts to service_role;
create function public.s2a_custom_key_create(p_user_id uuid,p_valid boolean,p_record jsonb default '{}')
returns jsonb language plpgsql set search_path='' as $$
declare attempts public.s2a_key_create_attempts; k public.s2a_keys;
begin
 insert into public.s2a_key_create_attempts(user_id) values(p_user_id) on conflict do nothing;
 select * into attempts from public.s2a_key_create_attempts where user_id=p_user_id for update;
 if attempts.window_start<=now()-interval '1 hour' then
  update public.s2a_key_create_attempts set failures=0,window_start=now() where user_id=p_user_id;attempts.failures:=0;
 end if;
 if attempts.failures>=20 then return jsonb_build_object('error','api_key_creation_rate_limited','status',429);end if;
 if p_valid is distinct from true then
  update public.s2a_key_create_attempts set failures=failures+1 where user_id=p_user_id;
  return jsonb_build_object('error','invalid_custom_key','status',400);
 end if;
 if p_record is null or jsonb_typeof(p_record)<>'object' or exists(select 1 from jsonb_object_keys(p_record) field where field not in
  ('user_id','group_id','name','key_hash','key_prefix','expires_at','rpm','concurrency','quota_total','monetary_quota','ip_whitelist','ip_blacklist','rate_limit_5h','rate_limit_1d','rate_limit_7d')) then return jsonb_build_object('error','invalid_key_options','status',400);end if;
 k:=jsonb_populate_record(null::public.s2a_keys,p_record);
 if k.user_id is distinct from p_user_id then return jsonb_build_object('error','invalid_key_owner','status',400);end if;
 if not public.s2a_group_can_bind(p_user_id,k.group_id) then return jsonb_build_object('error','group_access_denied','status',403);end if;
 begin
  insert into public.s2a_keys(user_id,group_id,name,key_hash,key_prefix,expires_at,rpm,concurrency,quota_total,monetary_quota,ip_whitelist,ip_blacklist,rate_limit_5h,rate_limit_1d,rate_limit_7d)
  values(p_user_id,k.group_id,k.name,k.key_hash,k.key_prefix,k.expires_at,coalesce(k.rpm,60),coalesce(k.concurrency,3),k.quota_total,k.monetary_quota,coalesce(k.ip_whitelist,'{}'),coalesce(k.ip_blacklist,'{}'),coalesce(k.rate_limit_5h,0),coalesce(k.rate_limit_1d,0),coalesce(k.rate_limit_7d,0)) returning * into k;
 exception when unique_violation then
  update public.s2a_key_create_attempts set failures=failures+1 where user_id=p_user_id;
  return jsonb_build_object('error','api_key_already_exists','status',409);
 end;
 return to_jsonb(k);
end $$;
revoke all on function public.s2a_custom_key_create(uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_custom_key_create(uuid,boolean,jsonb) to service_role;
notify pgrst,'reload schema';
