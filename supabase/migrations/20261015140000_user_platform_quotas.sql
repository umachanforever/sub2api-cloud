create table public.s2a_platform_quotas (
 user_id uuid not null references auth.users(id) on delete cascade,
 platform text not null check(platform in ('openai','anthropic','gemini','antigravity','grok','kimi','zhipu','deepseek','minimax','opencode_go')),
 daily_limit_usd numeric(20,8) check(daily_limit_usd between 0 and 1000000000),
 weekly_limit_usd numeric(20,8) check(weekly_limit_usd between 0 and 1000000000),
 monthly_limit_usd numeric(20,8) check(monthly_limit_usd between 0 and 1000000000),
 daily_usage_usd numeric(20,8) not null default 0 check(daily_usage_usd>=0),
 weekly_usage_usd numeric(20,8) not null default 0 check(weekly_usage_usd>=0),
 monthly_usage_usd numeric(20,8) not null default 0 check(monthly_usage_usd>=0),
 daily_window_start timestamptz,weekly_window_start timestamptz,monthly_window_start timestamptz,
 primary key(user_id,platform),check(daily_limit_usd is not null or weekly_limit_usd is not null or monthly_limit_usd is not null)
);
alter table public.s2a_platform_quotas enable row level security;
revoke all on public.s2a_platform_quotas from public,anon,authenticated;
grant select,insert,update,delete on public.s2a_platform_quotas to service_role;
create trigger s2a_platform_quotas_audit after insert or update or delete on public.s2a_platform_quotas for each row execute function public.s2a_audit_mutation();
create function public.s2a_platform_quotas_valid(p_quotas jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
begin
 if p_quotas is null or jsonb_typeof(p_quotas)<>'array' then return false;end if;
 if jsonb_array_length(p_quotas)>10 or exists(select 1 from jsonb_array_elements(p_quotas) e where jsonb_typeof(e)<>'object') then return false;end if;
 if exists(select 1 from jsonb_array_elements(p_quotas) e where not(e ? 'platform') or jsonb_typeof(e->'platform')<>'string' or e->>'platform' not in ('openai','anthropic','gemini','antigravity','grok','kimi','zhipu','deepseek','minimax','opencode_go') or exists(select 1 from jsonb_object_keys(e) k where k not in ('platform','daily_limit_usd','weekly_limit_usd','monthly_limit_usd'))) then return false;end if;
 if (select count(distinct e->>'platform') from jsonb_array_elements(p_quotas) e)<>jsonb_array_length(p_quotas) then return false;end if;
 if exists(select 1 from jsonb_array_elements(p_quotas) e cross join jsonb_each(e) x where x.key<>'platform' and jsonb_typeof(x.value) not in ('number','null')) then return false;end if;
 if exists(select 1 from jsonb_array_elements(p_quotas) e cross join jsonb_each_text(e) x where x.key<>'platform' and x.value is not null and (x.value::numeric<0 or x.value::numeric>1000000000 or x.value::numeric<>round(x.value::numeric,8))) then return false;end if;
 return true;
end $$;
create function public.s2a_platform_quotas_get(p_user_id uuid,p_admin boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare day_start timestamptz:=date_trunc('day',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';week_start timestamptz:=date_trunc('week',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
begin
 if not exists(select 1 from auth.users where id=p_user_id and deleted_at is null) then return jsonb_build_object('error','user_not_found','status',404);end if;
 return jsonb_build_object('platform_quotas',coalesce((select jsonb_agg(jsonb_build_object('platform',q.platform,
  'daily_limit_usd',q.daily_limit_usd,'weekly_limit_usd',q.weekly_limit_usd,'monthly_limit_usd',q.monthly_limit_usd,
  'daily_usage_usd',case when q.daily_window_start<day_start then 0 else q.daily_usage_usd end,
  'weekly_usage_usd',case when q.weekly_window_start<week_start then 0 else q.weekly_usage_usd end,
  'monthly_usage_usd',case when q.monthly_window_start+interval '30 days'<=now() then 0 else q.monthly_usage_usd end,
  'daily_window_resets_at',case when q.daily_window_start>=day_start then day_start+interval '1 day' else null end,
  'weekly_window_resets_at',case when q.weekly_window_start>=week_start then week_start+interval '7 days' else null end,
  'monthly_window_resets_at',case when q.monthly_window_start+interval '30 days'>now() then q.monthly_window_start+interval '30 days' else null end)
  ||case when p_admin then jsonb_build_object('daily_window_start',q.daily_window_start,'weekly_window_start',q.weekly_window_start,'monthly_window_start',q.monthly_window_start) else '{}'::jsonb end order by q.platform)
  from public.s2a_platform_quotas q where q.user_id=p_user_id),'[]'::jsonb));
end $$;
create function public.s2a_platform_quotas_set(p_user_id uuid,p_quotas jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not public.s2a_platform_quotas_valid(p_quotas) then return jsonb_build_object('error','invalid_platform_quotas','status',400);end if;
 if not exists(select 1 from auth.users where id=p_user_id and deleted_at is null) then return jsonb_build_object('error','user_not_found','status',404);end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 delete from public.s2a_platform_quotas where user_id=p_user_id and platform not in(select platform from jsonb_to_recordset(p_quotas) x(platform text,daily_limit_usd numeric,weekly_limit_usd numeric,monthly_limit_usd numeric) where daily_limit_usd is not null or weekly_limit_usd is not null or monthly_limit_usd is not null);
 insert into public.s2a_platform_quotas(user_id,platform,daily_limit_usd,weekly_limit_usd,monthly_limit_usd)
  select p_user_id,platform,daily_limit_usd,weekly_limit_usd,monthly_limit_usd from jsonb_to_recordset(p_quotas) x(platform text,daily_limit_usd numeric,weekly_limit_usd numeric,monthly_limit_usd numeric) where daily_limit_usd is not null or weekly_limit_usd is not null or monthly_limit_usd is not null
  on conflict(user_id,platform) do update set daily_limit_usd=excluded.daily_limit_usd,weekly_limit_usd=excluded.weekly_limit_usd,monthly_limit_usd=excluded.monthly_limit_usd;
 return public.s2a_platform_quotas_get(p_user_id,true);
end $$;
create function public.s2a_platform_quota_reset(p_user_id uuid,p_platform text,p_window text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if p_platform is null or p_platform not in ('openai','anthropic','gemini','antigravity','grok','kimi','zhipu','deepseek','minimax','opencode_go') or p_window is null or p_window not in ('daily','weekly','monthly') then return jsonb_build_object('error','invalid_platform_quota_reset','status',400);end if;
 if not exists(select 1 from auth.users where id=p_user_id and deleted_at is null) then return jsonb_build_object('error','user_not_found','status',404);end if;
 insert into public.s2a_user_limits(user_id) values(p_user_id) on conflict do nothing;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 update public.s2a_platform_quotas set
  daily_usage_usd=case when p_window='daily' then 0 else daily_usage_usd end,
  weekly_usage_usd=case when p_window='weekly' then 0 else weekly_usage_usd end,
  monthly_usage_usd=case when p_window='monthly' then 0 else monthly_usage_usd end,
  daily_window_start=case when p_window='daily' then now() else daily_window_start end,
  weekly_window_start=case when p_window='weekly' then now() else weekly_window_start end,
  monthly_window_start=case when p_window='monthly' then now() else monthly_window_start end where user_id=p_user_id and platform=p_platform;
 if not found then return jsonb_build_object('error','platform_quota_not_found','status',404);end if;
 return public.s2a_platform_quotas_get(p_user_id,true);
end $$;
create function public.s2a_platform_quota_charge(p_user_id uuid,p_platform text,p_cost numeric) returns void
language plpgsql set search_path='' as $$
declare day_start timestamptz:=date_trunc('day',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';week_start timestamptz:=date_trunc('week',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';
begin
 if p_cost is null or p_cost<=0 then return;end if;
 perform 1 from public.s2a_user_limits where user_id=p_user_id for update;
 update public.s2a_platform_quotas set
  daily_usage_usd=case when daily_window_start is null or daily_window_start<>day_start then p_cost else daily_usage_usd+p_cost end,
  weekly_usage_usd=case when weekly_window_start is null or weekly_window_start<>week_start then p_cost else weekly_usage_usd+p_cost end,
  monthly_usage_usd=case when monthly_window_start is null or monthly_window_start+interval '30 days'<=now() then p_cost else monthly_usage_usd+p_cost end,
  daily_window_start=day_start,weekly_window_start=week_start,
  monthly_window_start=case when monthly_window_start is null or monthly_window_start+interval '30 days'<=now() then now() else monthly_window_start end where user_id=p_user_id and platform=p_platform;
end $$;
create function public.s2a_platform_quota_check(p_user_id uuid,p_platform text) returns jsonb
language plpgsql set search_path='' as $$
declare q public.s2a_platform_quotas;day_start timestamptz:=date_trunc('day',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';week_start timestamptz:=date_trunc('week',now() at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai';used numeric;
begin
 select * into q from public.s2a_platform_quotas where user_id=p_user_id and platform=p_platform;
 if not found then return jsonb_build_object('ok',true);end if;
 used:=case when q.daily_window_start is null or q.daily_window_start<day_start then 0 else q.daily_usage_usd end;
 if q.daily_limit_usd is not null and used>=q.daily_limit_usd then return jsonb_build_object('error','user_platform_daily_quota_exhausted','status',429,'window_resets_at',day_start+interval '1 day');end if;
 used:=case when q.weekly_window_start is null or q.weekly_window_start<week_start then 0 else q.weekly_usage_usd end;
 if q.weekly_limit_usd is not null and used>=q.weekly_limit_usd then return jsonb_build_object('error','user_platform_weekly_quota_exhausted','status',429,'window_resets_at',week_start+interval '7 days');end if;
 used:=case when q.monthly_window_start is null or q.monthly_window_start+interval '30 days'<=now() then 0 else q.monthly_usage_usd end;
 if q.monthly_limit_usd is not null and used>=q.monthly_limit_usd then return jsonb_build_object('error','user_platform_monthly_quota_exhausted','status',429,'window_resets_at',coalesce(q.monthly_window_start,now())+interval '30 days');end if;
 return jsonb_build_object('ok',true);
end $$;
create function public.s2a_user_rpm_status(p_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare limits public.s2a_user_limits;
begin
 if not exists(select 1 from auth.users where id=p_user_id and deleted_at is null) then return jsonb_build_object('error','user_not_found','status',404);end if;
 select * into limits from public.s2a_user_limits where user_id=p_user_id;
 return jsonb_build_object('user_rpm_limit',coalesce(limits.rpm_limit,0),'user_rpm_used',case when limits.window_start>now()-interval '60 seconds' then limits.window_count else 0 end,
  'per_group',coalesce((select jsonb_agg(jsonb_build_object('group_id',g.id,'group_name',g.name,'used',case when w.window_start>now()-interval '60 seconds' then w.window_count else 0 end,
   'limit',coalesce(o.rpm_override,g.rpm_limit),'source',case when o.rpm_override is null then 'group' else 'override' end) order by g.id)
   from public.s2a_groups g left join public.s2a_user_group_rpm o on o.user_id=p_user_id and o.group_id=g.id left join public.s2a_user_group_windows w on w.user_id=p_user_id and w.group_id=g.id
   where exists(select 1 from public.s2a_keys k where k.user_id=p_user_id and k.group_id=g.id and k.deleted_at is null)),'[]'::jsonb));
end $$;
revoke all on function public.s2a_platform_quotas_valid(jsonb) from public,anon,authenticated;
grant execute on function public.s2a_platform_quotas_valid(jsonb) to service_role;
revoke all on function public.s2a_platform_quotas_get(uuid,boolean) from public,anon,authenticated;
grant execute on function public.s2a_platform_quotas_get(uuid,boolean) to service_role;
revoke all on function public.s2a_platform_quotas_set(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.s2a_platform_quotas_set(uuid,jsonb) to service_role;
revoke all on function public.s2a_platform_quota_reset(uuid,text,text) from public,anon,authenticated;
grant execute on function public.s2a_platform_quota_reset(uuid,text,text) to service_role;
revoke all on function public.s2a_platform_quota_charge(uuid,text,numeric) from public,anon,authenticated;
grant execute on function public.s2a_platform_quota_charge(uuid,text,numeric) to service_role;
revoke all on function public.s2a_platform_quota_check(uuid,text) from public,anon,authenticated;
grant execute on function public.s2a_platform_quota_check(uuid,text) to service_role;
revoke all on function public.s2a_user_rpm_status(uuid) from public,anon,authenticated;
grant execute on function public.s2a_user_rpm_status(uuid) to service_role;
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
  if g.subscription_type='standard' then
   result:=public.s2a_platform_quota_check(k.user_id,g.platform);if result ? 'error' then return result;end if;
  end if;
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

create or replace function public.s2a_finish(
 p_lease_id uuid,p_status integer,p_outcome text,
 p_input_tokens bigint default null,p_output_tokens bigint default null,
 p_cache_creation_tokens bigint default null,p_cache_read_tokens bigint default null,
 p_cooldown_seconds integer default 0,p_credential_version bigint default null)
returns void language plpgsql set search_path='' as $$
declare l public.s2a_leases; k public.s2a_keys; prices jsonb; tier text; context bigint; billable_input bigint;
 input_price numeric; output_price numeric; creation_price numeric; read_price numeric;
 total numeric; charged numeric(20,8); multiplier numeric; next_balance numeric; sub_id uuid; state text:='unknown';
begin
 select * into l from public.s2a_leases where id=p_lease_id;
 if not found then return; end if;
 select * into k from public.s2a_keys where id=l.key_id;
 perform 1 from public.s2a_user_limits where user_id=k.user_id for update;
 select * into k from public.s2a_keys where id=l.key_id for update;
 select * into l from public.s2a_leases where id=p_lease_id for update;
 if not found then return; end if;
 sub_id := (l.billing->>'subscription_id')::uuid;
 if sub_id is not null then perform public.s2a_subscription_refresh(sub_id); end if;
 prices := l.billing->'rates';
 tier := l.billing->>'service_tier';
 multiplier := coalesce((l.billing->>'rate_multiplier')::numeric,1);
 if p_input_tokens is not null and p_output_tokens is not null and jsonb_typeof(prices)='object' then
  billable_input := greatest(0,p_input_tokens-case when l.billing->>'platform'='anthropic' then 0 else coalesce(p_cache_creation_tokens,0)+coalesce(p_cache_read_tokens,0) end);
  context := billable_input+coalesce(p_cache_creation_tokens,0)+coalesce(p_cache_read_tokens,0);
  input_price := billable_input*public.s2a_price_rate(prices,'input_cost_per_token',context,tier);
  output_price := p_output_tokens*public.s2a_price_rate(prices,'output_cost_per_token',context,tier);
  creation_price := coalesce(p_cache_creation_tokens,0)*public.s2a_price_rate(prices,'cache_creation_input_token_cost',context,tier);
  read_price := coalesce(p_cache_read_tokens,0)*public.s2a_price_rate(prices,'cache_read_input_token_cost',context,tier);
  total := input_price+output_price+creation_price+read_price;
  charged := round(total*multiplier,8);
  state := case when charged>0 then 'settled' else 'free' end;
 end if;
 insert into public.s2a_usage(id,request_id,account_id,key_id,user_id,model,status,outcome,input_tokens,output_tokens,
  cache_creation_tokens,cache_read_tokens,duration_ms,group_id,input_cost,output_cost,cache_creation_cost,cache_read_cost,
  total_cost,actual_cost,rate_multiplier,service_tier,stream,billing_status)
 values(l.id,l.request_id,l.account_id,l.key_id,k.user_id,l.model,p_status,p_outcome,p_input_tokens,p_output_tokens,
  p_cache_creation_tokens,p_cache_read_tokens,greatest(0,floor(extract(epoch from(clock_timestamp()-l.started_at))*1000)::integer),
  coalesce((l.billing->>'group_id')::uuid,k.group_id),input_price,output_price,creation_price,read_price,total,charged,
  multiplier,tier,(l.billing->>'stream')::boolean,state);
 update public.s2a_keys set quota_used=quota_used+coalesce(p_input_tokens,0)+coalesce(p_output_tokens,0),
  monetary_used=monetary_used+coalesce(charged,0) where id=k.id;
 if sub_id is null and charged>0 then perform public.s2a_platform_quota_charge(k.user_id,l.billing->>'platform',charged);end if;
 update public.s2a_usage set subscription_id=sub_id,
  billing_mode=case when sub_id is null then 'token' else 'subscription' end where id=l.id;
 if sub_id is not null and charged>0 then
  update public.s2a_subscriptions set daily_usage_usd=daily_usage_usd+charged,weekly_usage_usd=weekly_usage_usd+charged,
   monthly_usage_usd=monthly_usage_usd+charged,updated_at=now() where id=sub_id;
 elsif charged>0 then
  insert into public.s2a_wallets(user_id) values(k.user_id) on conflict do nothing;
  update public.s2a_wallets set balance=balance-charged,updated_at=now() where user_id=k.user_id returning balance into next_balance;
  insert into public.s2a_wallet_ledger(user_id,delta,balance_after,reason,notes)
   values(k.user_id,-charged,next_balance,'usage',l.id::text);
 end if;
 if p_status=401 then
  update public.s2a_accounts set status='error',error_message='Upstream authentication rejected (401)'
   where id=l.account_id and status='active' and credential_version=coalesce(p_credential_version,l.credential_version);
 end if;
 if p_cooldown_seconds>0 then
  update public.s2a_accounts set cooldown_until=greatest(coalesce(cooldown_until,now()),now()+make_interval(secs=>least(p_cooldown_seconds,3600))),
   cooldown_status=case when cooldown_until>now()+make_interval(secs=>least(p_cooldown_seconds,3600)) then cooldown_status else p_status end,
   cooldown_started_at=case when cooldown_until>now()+make_interval(secs=>least(p_cooldown_seconds,3600)) then cooldown_started_at else now() end
   where id=l.account_id and credential_version=coalesce(p_credential_version,l.credential_version);
 end if;
 delete from public.s2a_leases where id=l.id;
end $$;
update public.s2a_settings set data=data||'{"default_platform_quotas":{}}'::jsonb where id='11111111-0000-4000-8000-000000000001';
create or replace function public.s2a_settings_update(p_patch jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; entry jsonb; quota_records jsonb;
begin
 if p_patch is null or jsonb_typeof(p_patch)<>'object' or exists(select 1 from jsonb_object_keys(p_patch) k where k not in
 ('default_platform_quotas','registration_email_domain_quota_enabled','custom_menu_items','custom_endpoints','backend_mode_enabled','hide_ccs_import_button','promo_code_enabled','registration_enabled','invitation_code_enabled','registration_email_suffix_whitelist','default_balance','default_concurrency','default_user_rpm_limit','default_subscriptions','site_name','site_logo','site_subtitle','compact_home_enabled','api_base_url','contact_info','doc_url','home_content')) then
  return jsonb_build_object('error','invalid_settings','status',400);
 end if;
 select data||p_patch into result from public.s2a_settings where id='11111111-0000-4000-8000-000000000001' for update;
 if jsonb_typeof(result->'registration_email_domain_quota_enabled')<>'boolean' or jsonb_typeof(result->'backend_mode_enabled')<>'boolean' or jsonb_typeof(result->'hide_ccs_import_button')<>'boolean' or jsonb_typeof(result->'custom_menu_items')<>'array' or jsonb_array_length(result->'custom_menu_items')>100 or jsonb_typeof(result->'custom_endpoints')<>'array' or jsonb_array_length(result->'custom_endpoints')>100 or jsonb_typeof(result->'promo_code_enabled')<>'boolean' or jsonb_typeof(result->'registration_enabled')<>'boolean' or jsonb_typeof(result->'invitation_code_enabled')<>'boolean'
  or jsonb_typeof(result->'compact_home_enabled')<>'boolean' or jsonb_typeof(result->'default_balance')<>'number'
  or (result->>'default_balance')::numeric not between 0 and 1000000000 or (result->>'default_balance')::numeric<>round((result->>'default_balance')::numeric,8)
  or jsonb_typeof(result->'default_concurrency')<>'number' or (result->>'default_concurrency')::numeric not between 0 and 1000000 or (result->>'default_concurrency')::numeric<>trunc((result->>'default_concurrency')::numeric)
  or jsonb_typeof(result->'default_user_rpm_limit')<>'number' or (result->>'default_user_rpm_limit')::numeric not between 0 and 1000000 or (result->>'default_user_rpm_limit')::numeric<>trunc((result->>'default_user_rpm_limit')::numeric)
  or jsonb_typeof(result->'default_subscriptions')<>'array' or jsonb_array_length(result->'default_subscriptions')>100
  or jsonb_typeof(result->'registration_email_suffix_whitelist')<>'array' or jsonb_array_length(result->'registration_email_suffix_whitelist')>100 then
  return jsonb_build_object('error','invalid_registration_settings','status',400);
 end if;
 for entry in select value from jsonb_array_elements(result->'default_subscriptions') loop
  if jsonb_typeof(entry)<>'object' or jsonb_typeof(entry->'validity_days')<>'number' or (entry->>'validity_days')::numeric not between 1 and 36500
   or (entry->>'validity_days')::numeric<>trunc((entry->>'validity_days')::numeric) or not exists(select 1 from public.s2a_groups where id=(entry->>'group_id')::uuid and enabled and subscription_type='subscription') then
   return jsonb_build_object('error','invalid_default_subscription','status',400);
  end if;
 end loop;
 if jsonb_typeof(result->'default_platform_quotas') is distinct from 'object' then return jsonb_build_object('error','invalid_default_platform_quotas','status',400);end if;
 if exists(select 1 from jsonb_each(result->'default_platform_quotas') x where jsonb_typeof(x.value)<>'object') then return jsonb_build_object('error','invalid_default_platform_quotas','status',400);end if;
 if exists(select 1 from jsonb_each(result->'default_platform_quotas') x cross join jsonb_object_keys(x.value) k where k not in ('daily','weekly','monthly')) then return jsonb_build_object('error','invalid_default_platform_quotas','status',400);end if;
 select coalesce(jsonb_agg(jsonb_build_object('platform',x.key,'daily_limit_usd',x.value->'daily','weekly_limit_usd',x.value->'weekly','monthly_limit_usd',x.value->'monthly')),'[]'::jsonb) into quota_records from jsonb_each(result->'default_platform_quotas') x;
 if not public.s2a_platform_quotas_valid(quota_records) then return jsonb_build_object('error','invalid_default_platform_quotas','status',400);end if;
 update public.s2a_settings set data=result,updated_at=now() where id='11111111-0000-4000-8000-000000000001';
 return result;
end $$;


create or replace function public.s2a_registration_bootstrap() returns trigger
language plpgsql security definer set search_path='' as $$
declare settings jsonb; invitation public.s2a_redeem_codes; supplied text; suffix text; rule text; allowed boolean:=false; entry jsonb; result jsonb; authorized text; capability text; quota_domain text;
begin
 capability:=coalesce(new.raw_user_meta_data->>'s2a_registration_ticket','');
 if length(capability)=64 then
  delete from public.s2a_registration_authorizations
   where token_hash=encode(sha256(convert_to(capability,'UTF8')),'hex') and email=lower(new.email) and expires_at>now()
   returning token_hash into authorized;
 end if;
 -- GoTrue admin creation writes app metadata after insertion; its backend ticket supplies the trusted context.
 if authorized is not null or new.raw_app_meta_data->>'s2a_managed_user'='true' then
  update auth.users set raw_user_meta_data=raw_user_meta_data-'s2a_registration_ticket'-'invitation_code'-'promo_code' where id=new.id;
  return new;
 end if;
 select data into settings from public.s2a_settings for share;
 if not (settings->>'registration_enabled')::boolean then raise check_violation using message='registration_disabled'; end if;
 suffix:=rtrim(lower(split_part(coalesce(new.email,''),'@',2)),'.');
 if jsonb_array_length(settings->'registration_email_suffix_whitelist')>0 then
  for rule in select jsonb_array_elements_text(settings->'registration_email_suffix_whitelist') loop
   if left(rule,2)='*.' then
    allowed:=allowed or suffix=substring(rule from 3) or (length(suffix)>length(substring(rule from 3))+1 and right(suffix,length(substring(rule from 3))+1)='.'||substring(rule from 3));
   else allowed:=allowed or suffix=ltrim(rule,'@'); end if;
  end loop;
  if not allowed then
   if not coalesce((settings->>'registration_email_domain_quota_enabled')::boolean,false) then raise check_violation using message='email_suffix_not_allowed';end if;
   quota_domain:=public.s2a_registration_domain(suffix);
   if quota_domain='' then raise check_violation using message='email_suffix_not_allowed';end if;
   perform pg_advisory_xact_lock(hashtextextended('s2a-email-domain|'||quota_domain,0));
   if exists(select 1 from auth.users u where u.id<>new.id and u.deleted_at is null and
     (rtrim(lower(split_part(coalesce(u.email,''),'@',2)),'.')=quota_domain or right(rtrim(lower(split_part(coalesce(u.email,''),'@',2)),'.'),length(quota_domain)+1)='.'||quota_domain)) then
    raise check_violation using message='email_domain_registration_limit';
   end if;
  end if;
 end if;
 -- Serialize aliases before checking the existing inbox identity and issuing signup grants.
 -- shortcut: canonical checks scan Auth users; add a private identity index when registration volume warrants it.
 perform pg_advisory_xact_lock(hashtextextended('s2a-email-alias|'||public.s2a_email_identity(new.email),0));
 if exists(select 1 from auth.users u where u.id<>new.id and public.s2a_email_identity(u.email)=public.s2a_email_identity(new.email)) then
  raise unique_violation using message='email_alias_already_registered';
 end if;
 supplied:=trim(coalesce(new.raw_user_meta_data->>'invitation_code',''));
 if (settings->>'invitation_code_enabled')::boolean then
  if supplied='' then raise check_violation using message='invitation_code_required'; end if;
  select * into invitation from public.s2a_redeem_codes where code=supplied and type='invitation' for update;
  if not found or invitation.status<>'unused' or invitation.expires_at<=now() then raise check_violation using message='invitation_code_invalid'; end if;
  update public.s2a_redeem_codes set status='used',used_by=new.id,used_at=now() where id=invitation.id;
 end if;
 insert into public.s2a_user_limits(user_id,concurrency,rpm_limit)
  values(new.id,(settings->>'default_concurrency')::integer,(settings->>'default_user_rpm_limit')::integer);
 insert into public.s2a_platform_quotas(user_id,platform,daily_limit_usd,weekly_limit_usd,monthly_limit_usd)
  select new.id,x.key,(x.value->>'daily')::numeric,(x.value->>'weekly')::numeric,(x.value->>'monthly')::numeric from jsonb_each(settings->'default_platform_quotas') x
  where x.value->>'daily' is not null or x.value->>'weekly' is not null or x.value->>'monthly' is not null;
 if (settings->>'default_balance')::numeric>0 then
  result:=public.s2a_wallet_adjust(new.id,(settings->>'default_balance')::numeric,'signup','Signup credit');
  if result ? 'error' then raise check_violation using message='signup_balance_failed'; end if;
 end if;
 for entry in select value from jsonb_array_elements(settings->'default_subscriptions') loop
  result:=public.s2a_subscription_assign(new.id,(entry->>'group_id')::uuid,(entry->>'validity_days')::integer);
  if result ? 'error' then raise check_violation using message='signup_subscription_failed'; end if;
 end loop;
 -- Invalid or exhausted promo codes do not prevent signup, matching the upstream flow.
 perform public.s2a_promo_apply(new.id,new.raw_user_meta_data->>'promo_code');
 if new.raw_user_meta_data ? 'promo_code' or new.raw_user_meta_data ? 'invitation_code' or new.raw_user_meta_data ? 's2a_registration_ticket' then
  update auth.users set raw_user_meta_data=raw_user_meta_data-'invitation_code'-'promo_code'-'s2a_registration_ticket' where id=new.id;
 end if;
 return new;
end $$;


create or replace function public.s2a_audit_mutation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare headers jsonb; before_row jsonb; after_row jsonb; changed jsonb;
begin
  -- Native Auth does not supply trustworthy application actor headers.
  headers := case when tg_table_schema = 'auth' then '{}'::jsonb
    else coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb end;
  before_row := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  after_row := case when tg_op = 'DELETE' then '{}'::jsonb else to_jsonb(new) end;
  select coalesce(jsonb_agg(case when k='encrypted_password' then 'password' else k end order by k), '[]'::jsonb) into changed
  from jsonb_object_keys(before_row || after_row) k
  where k not in ('ciphertext','iv','key_hash','refresh_lock_id','refresh_lock_until',
    'last_used_at','window_start','window_count','credential_version','cooldown_until')
    and (tg_table_schema <> 'auth' or k in ('email','phone','encrypted_password','banned_until','raw_user_meta_data','raw_app_meta_data','deleted_at','last_sign_in_at','email_confirmed_at','phone_confirmed_at','is_anonymous','is_sso_user','role','id','user_id','factor_type','status','friendly_name'))
    and (tg_op <> 'UPDATE' or k not in ('created_at','updated_at'))
    and before_row->k is distinct from after_row->k;
  if tg_op = 'UPDATE' and (before_row->'ciphertext' is distinct from after_row->'ciphertext'
    or before_row->'iv' is distinct from after_row->'iv') then
    changed := changed || '["credentials"]'::jsonb;
  end if;
  if changed = '[]'::jsonb then
    return coalesce(new,old);
  end if;
  insert into public.s2a_audit_logs(actor_user_id,actor_email,actor_role,auth_method,
    action,method,path,request_id,extra)
  values(nullif(headers->>'x-s2a-actor-id','')::uuid,
    coalesce(headers->>'x-s2a-actor-email',''),
    coalesce(headers->>'x-s2a-actor-role','system'),
    case when tg_table_schema = 'auth' then 'supabase-auth' when headers ? 'x-s2a-actor-id' then 'jwt' else 'service' end,
    case when tg_table_schema = 'auth' then 'auth.' else '' end || tg_table_name || '.' || lower(tg_op),
    coalesce(headers->>'x-s2a-request-method',''),
    coalesce(headers->>'x-s2a-request-path',''),
    coalesce(headers->>'x-s2a-request-id',''),
    jsonb_build_object('resource_id',coalesce(after_row->>'id',before_row->>'id',after_row->>'announcement_id',before_row->>'announcement_id'),
      'changed_fields',changed,'resource_refs',jsonb_strip_nulls(jsonb_build_object(
        'user_id',coalesce(after_row->>'user_id',before_row->>'user_id'),
        'group_id',coalesce(after_row->>'group_id',before_row->>'group_id'),
        'platform',case when tg_table_name='s2a_platform_quotas' then coalesce(after_row->>'platform',before_row->>'platform') else null end,
        'announcement_id',coalesce(after_row->>'announcement_id',before_row->>'announcement_id')))));
  return coalesce(new,old);
end $$;
notify pgrst,'reload schema';
